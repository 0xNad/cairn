// The Bot API client: JSON over HTTPS to TELEGRAM_API_ROOT, long polling only. It maps Telegram's errors to the
// behaviour ARCHITECTURE.md fixes: 429 waits `retry_after` and retries, 401 exits 3, 409 exits 1, 403 and other
// 4xx are the caller's to skip, 5xx and network failures are retried and then reported as "unreachable".
// The token is in the request path only: it is never logged, and errors never carry the URL.
import { EXIT, ExitError } from "./errors.mjs";
import { TELEGRAM_LIMIT } from "./format.mjs";
import { errorCode, isAbort, jitter, sleep } from "./util.mjs";

/** Telegram answered with an error the caller may handle (403 blocked, 400 bad request...). */
export class TelegramError extends Error {
  constructor(code, description, parameters) {
    super(description);
    this.name = "TelegramError";
    this.code = code;
    this.parameters = parameters ?? {};
  }
}

/** Telegram could not be reached after every try. */
export class TelegramUnreachable extends Error {
  constructor(reason) {
    super(reason);
    this.name = "TelegramUnreachable";
  }
}

const TRIES = 3;
const MAX_429_WAITS = 5;
const MAX_RETRY_AFTER_S = 120;
const BACKOFF_MS = 500;
const SLACK_MS = 15_000; // a long poll is given its own timeout plus this before it is given up on

export class Telegram {
  /** @param {{ root: string, token: string, log: object, signal?: AbortSignal }} options */
  constructor({ root, token, log, signal }) {
    this.base = `${root}/bot${token}`;
    this.log = log;
    this.signal = signal;
    this.sent = 0; // messages Telegram accepted
  }

  /**
   * Calls a Bot API method. `timeoutS` is the request timeout in seconds.
   * @throws {ExitError} 401 (exit 3) and 409 (exit 1)
   * @throws {TelegramError} any other refusal
   * @throws {TelegramUnreachable} after three failed tries
   */
  async api(method, params = {}, { timeoutS = 30 } = {}) {
    let failures = 0;
    let limited = 0;
    for (;;) {
      let res;
      let body;
      try {
        const signals = [AbortSignal.timeout(timeoutS * 1000)];
        if (this.signal) signals.push(this.signal);
        res = await fetch(`${this.base}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(params),
          signal: AbortSignal.any(signals),
        });
        body = await res.json().catch(() => null);
      } catch (e) {
        if (this.signal?.aborted) throw this.signal.reason ?? e;
        res = null;
        body = null;
        this.log.debug("telegram_retry", { method, reason: isAbort(e) || e?.name === "TimeoutError" ? "timeout" : errorCode(e) });
      }

      if (res && body?.ok === true) return body.result;

      const code = body?.error_code ?? res?.status;
      const description = String(body?.description ?? "").slice(0, 300);
      if (res && code === 401) throw new ExitError(EXIT.REJECTED, "Telegram rejected the bot token (401 Unauthorized): check TELEGRAM_BOT_TOKEN");
      if (res && code === 409) throw new ExitError(EXIT.UNREACHABLE, "Telegram reports a conflict (409): another instance is running with this bot token, or a webhook is set");
      if (res && code === 429) {
        const seconds = Math.min(Math.max(Number(body?.parameters?.retry_after) || 1, 0), MAX_RETRY_AFTER_S);
        if (++limited > MAX_429_WAITS) throw new TelegramError(429, description || "Too Many Requests", body?.parameters);
        this.log.info("telegram_rate_limited", { method, retry_after: seconds });
        await sleep(seconds * 1000, this.signal);
        continue;
      }
      if (res && code >= 400 && code < 500) throw new TelegramError(code, description || `HTTP ${code}`, body?.parameters);

      // A 5xx, a network failure, a timeout or an answer that is not Telegram's: try again, then give up.
      if (++failures >= TRIES) throw new TelegramUnreachable(res ? `HTTP ${res.status}` : "no answer");
      await sleep(BACKOFF_MS * 2 ** (failures - 1) + jitter(150), this.signal);
    }
  }

  getMe() {
    return this.api("getMe");
  }

  /** Never drops the pending updates. */
  deleteWebhook() {
    return this.api("deleteWebhook", { drop_pending_updates: false });
  }

  /**
   * One getUpdates call. `timeout` is the long-poll length in seconds (0 for a plain read).
   * @returns {Promise<object[]>}
   */
  getUpdates({ offset, limit = 100, timeout = 0 }) {
    const params = { limit, timeout, allowed_updates: ["message"] };
    if (offset !== undefined && offset !== null) params.offset = offset;
    return this.api("getUpdates", params, { timeoutS: timeout + SLACK_MS / 1000 });
  }

  setMyCommands(commands) {
    return this.api("setMyCommands", { commands });
  }

  /**
   * Sends one HTML message (1 to 4096 characters), link previews off. Counts it when Telegram accepts it.
   * @returns {Promise<object>} the sent message
   */
  async sendMessage(chatId, html, { replyTo, threadId } = {}) {
    if (html.length === 0 || html.length > TELEGRAM_LIMIT * 2) throw new RangeError("a message must be 1 to 4096 characters");
    const params = {
      chat_id: chatId,
      text: html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    };
    if (threadId !== undefined) params.message_thread_id = threadId;
    if (replyTo !== undefined) params.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
    const message = await this.api("sendMessage", params);
    this.sent++;
    return message;
  }
}
