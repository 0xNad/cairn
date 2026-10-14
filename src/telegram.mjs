// The Telegram Bot API client: POST ${TELEGRAM_API_ROOT}/bot<token>/<method> with a JSON body.
// 401 ends the process with exit 3 and 409 with exit 1 (another instance). 429 waits exactly retry_after
// and tries again; 5xx and network failures are retried with backoff, then reported as unreachable.
// sendMessage skips a chat that blocked the bot (403) and follows a group that became a supergroup.
import { EXIT, Fatal } from "./errors.mjs";
import { htmlToText } from "./format.mjs";
import { log, reasonOf } from "./log.mjs";
import { backoff, sleep } from "./wait.mjs";

const TRIES = 3;
const MAX_429 = 5;

// Telegram answered with an error: `status` is its error_code, `parameters` its retry_after or
// migrate_to_chat_id.
export class TelegramError extends Error {
  constructor(status, description, parameters) {
    super(`Telegram answered ${status}: ${description}`);
    this.name = "TelegramError";
    this.status = status;
    this.description = description;
    this.parameters = parameters ?? {};
  }
}

// Telegram could not be reached, or kept answering 5xx.
export class TelegramUnreachable extends Error {
  constructor(reason) {
    super(`Telegram is unreachable: ${reason}`);
    this.name = "TelegramUnreachable";
  }
}

export function telegramClient({ root, token, stop }) {
  const base = `${root}/bot${token}/`;

  async function once(method, params, timeoutMs) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = stop ? AbortSignal.any([stop, timeout]) : timeout;
    let res, text;
    try {
      res = await fetch(`${base}${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params), signal });
      text = await res.text();
    } catch (e) {
      if (stop?.aborted) throw stop.reason;
      throw new TelegramUnreachable(`${method}: ${timeout.aborted ? `no answer within ${timeoutMs / 1000} s` : reasonOf(e)}`);
    }
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {}
    if (body?.ok === true) return body.result;
    throw new TelegramError(body?.error_code ?? res.status, body?.description ?? `HTTP ${res.status}`, body?.parameters);
  }

  // Calls `method`; returns its result or throws Fatal, TelegramUnreachable or TelegramError.
  async function call(method, params = {}, { timeoutMs = 20_000 } = {}) {
    for (let n = 1, waits = 0; ; n++) {
      try {
        return await once(method, params, timeoutMs);
      } catch (e) {
        if (stop?.aborted) throw e;
        if (e instanceof TelegramError) {
          if (e.status === 401) throw new Fatal(EXIT.TOKEN, "Telegram rejected TELEGRAM_BOT_TOKEN (401 Unauthorized): check the token with @BotFather");
          if (e.status === 409) throw new Fatal(EXIT.UNREACHABLE, `Telegram answered ${method} with 409 Conflict, another instance is running with this token (or a webhook is set): ${e.description}`);
          if (e.status === 429 && ++waits <= MAX_429) {
            const s = Number(e.parameters.retry_after) || 1;
            log.warn("telegram_429", { method, retry_after: s });
            await sleep(s * 1000, stop);
            n--;
            continue;
          }
          if (e.status < 500) throw e;
          if (n >= TRIES) throw new TelegramUnreachable(`${method}: answered ${e.status} ${TRIES} times`);
        } else if (!(e instanceof TelegramUnreachable) || n >= TRIES) throw e;
        log.warn("telegram_retry", { method, try: n, reason: e.message });
        await sleep(backoff(n), stop);
      }
    }
  }

  // Sends one message (chat_id, text and options); true when Telegram accepted it, false when it was
  // skipped (blocked, kicked, or refused). Throws only TelegramUnreachable, Fatal or an abort.
  async function send(message, { migrated = false, plain = false } = {}) {
    const params = plain
      ? { link_preview_options: { is_disabled: true }, ...message, text: htmlToText(message.text) }
      : { parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...message };
    try {
      await call("sendMessage", params);
      return true;
    } catch (e) {
      if (!(e instanceof TelegramError)) throw e;
      const to = e.parameters.migrate_to_chat_id;
      if (e.status === 400 && to && !migrated) {
        log.info("chat_migrated", { chat: message.chat_id, to });
        return send({ ...message, chat_id: to }, { migrated: true, plain });
      }
      if (e.status === 400 && /can't parse entities/i.test(e.description) && !plain) {
        // A formatting bug must not cost the user their answer: send the same text without HTML.
        log.error("html_refused", { chat: message.chat_id, reason: e.description });
        return send(message, { migrated, plain: true });
      }
      if (e.status === 403) log.info("chat_skipped", { chat: message.chat_id, reason: e.description });
      else log.error("send_refused", { chat: message.chat_id, status: e.status, reason: e.description });
      return false;
    }
  }

  return { call, send };
}
