// The Bot API client (ARCHITECTURE.md, "Telegram transport"): POST ${TELEGRAM_API_ROOT}/bot<token>/<method>
// with a JSON body, long polling only. The URL holds the token, so no error or log line ever shows it.
import { rejected, unreachable } from "./errors.mjs";
import { NoAnswer, postJson, sleep } from "./http.mjs";

/** Telegram answered ok: false. `code` is its error_code; `retryAfter` is in seconds. */
export class TelegramError extends Error {
  constructor(code, description, parameters = {}) {
    super(`Telegram ${code}: ${description}`);
    this.code = code;
    this.description = description;
    this.retryAfter = parameters.retry_after;
  }
}

/** The methods round 1 calls: anything else is a bug. */
const METHODS = new Set(["getMe", "deleteWebhook", "getUpdates", "sendMessage", "setMyCommands"]);

export function createTelegram({ root, token, log, signal }) {
  const base = `${root}/bot${token}/`;

  /** One call: resolves its result; rejects with TelegramError, NoAnswer, or the shutdown's abort. */
  async function call(method, params = {}, { timeoutMs = 15_000 } = {}) {
    if (!METHODS.has(method)) throw new Error(`Cairn does not call ${method}`);
    const res = await postJson(base + method, params, { timeoutMs, signal });
    let body;
    try {
      body = JSON.parse(res.text);
    } catch {
      throw new TelegramError(res.status, `an answer that is not JSON (HTTP ${res.status})`);
    }
    if (body?.ok === true) return body.result;
    throw new TelegramError(body?.error_code ?? res.status, String(body?.description ?? `HTTP ${res.status}`), body?.parameters);
  }

  /**
   * A call that must succeed for the command to go on: 401 exits 3; a 429 waits retry_after; a 5xx or no
   * answer is tried 3 times, then exits 1 ("Telegram unreachable").
   */
  async function must(method, params, opts) {
    for (let n = 1; ; n++) {
      try {
        return await call(method, params, opts);
      } catch (e) {
        if (e instanceof TelegramError && e.code === 401) throw rejected();
        if (e instanceof TelegramError && e.code === 429 && n <= 5) {
          await sleep((e.retryAfter ?? 1) * 1000, signal);
          continue;
        }
        const transient = e instanceof NoAnswer || (e instanceof TelegramError && e.code >= 500);
        if (!transient) throw e;
        if (n >= 3) throw unreachable(`Telegram is unreachable at ${root} (${e instanceof NoAnswer ? e.message : `HTTP ${e.code}`} after ${n} tries)`);
        await sleep(n * 1000, signal);
      }
    }
  }

  return {
    call,
    must,
    getMe: () => must("getMe"),

    /**
     * Sends one message. Resolves the accepted Message, or null when Telegram refused it for good (403: the
     * chat blocked or removed the bot; 400: a bad request). A 429 waits exactly retry_after and sends
     * again; a 5xx, or a connection that surely never reached Telegram, is retried; a request that may
     * have reached it is never sent twice.
     */
    async send(chatId, text, extra = {}) {
      const params = { chat_id: chatId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra };
      for (let n = 1; ; n++) {
        try {
          return await call("sendMessage", params);
        } catch (e) {
          if (e instanceof TelegramError) {
            if (e.code === 401) throw rejected();
            if (e.code === 429 && n <= 5) {
              log.info("telegram_429", { retry_after: e.retryAfter ?? 1 });
              await sleep((e.retryAfter ?? 1) * 1000, signal);
              continue;
            }
            if (e.code >= 500 && n < 3) {
              await sleep(n * 1000, signal);
              continue;
            }
            log.warn("message_refused", { chat: chatId, code: e.code, description: e.description.slice(0, 200) });
            return null;
          }
          if (e instanceof NoAnswer && e.unsent && n < 3) {
            await sleep(n * 1000, signal);
            continue;
          }
          // A timeout may hide a message Telegram accepted: it is not sent again, so it can never arrive twice.
          if (e instanceof NoAnswer) {
            log.warn("message_unsent", { chat: chatId, reason: e.message });
            return null;
          }
          throw e;
        }
      }
    },
  };
}
