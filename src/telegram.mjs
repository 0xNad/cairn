// The Bot API client: POST ${TELEGRAM_API_ROOT}/bot<token>/<method> with a JSON body. Long polling only.
// The URL holds the token, so it is never logged; errors carry Telegram's code and description only.

/** Telegram refused a call (`code` is error_code: 401, 403, 409, 429…), or could not be reached (`code` 0). */
export class TelegramError extends Error {
  constructor(code, description, parameters) {
    super(description);
    this.code = code;
    this.parameters = parameters;
  }
}

/** The update kinds round 1 asks for. */
export const ALLOWED_UPDATES = ["message"];

export function telegram({ apiRoot, token }) {
  const base = `${apiRoot}/bot${token}/`;

  /** Calls `method`; returns its result or throws TelegramError (or the abort, when `signal` fired). */
  async function call(method, params = {}, { timeoutMs = 15_000, signal } = {}) {
    const timeout = AbortSignal.timeout(timeoutMs);
    let res, body;
    try {
      res = await fetch(`${base}${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      body = await res.json().catch(() => null);
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new TelegramError(0, timeout.aborted ? `Telegram did not answer ${method} within ${timeoutMs / 1000} s` : `Telegram is unreachable (${e.cause?.code ?? e.name})`);
    }
    if (!body || typeof body !== "object") throw new TelegramError(res.status >= 500 ? res.status : 0, `Telegram answered ${method} with HTTP ${res.status} and no JSON`);
    if (!body.ok) throw new TelegramError(Number(body.error_code ?? res.status), String(body.description ?? `HTTP ${res.status}`), body.parameters);
    return body.result;
  }

  return {
    call,
    getMe: () => call("getMe"),
    deleteWebhook: () => call("deleteWebhook", { drop_pending_updates: false }),
    setMyCommands: (commands) => call("setMyCommands", { commands }),
    /** Updates from `offset` on; `timeout` > 0 long-polls for that many seconds. */
    getUpdates: ({ offset, timeout = 0, limit }, { signal } = {}) => call("getUpdates", {
      ...(offset ? { offset } : {}), ...(limit ? { limit } : {}), timeout, allowed_updates: ALLOWED_UPDATES,
    }, { signal, timeoutMs: (timeout + 15) * 1000 }),
    /** One HTML message with link previews off. */
    sendMessage: (chatId, html, extra = {}) => call("sendMessage", {
      chat_id: chatId, text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra,
    }),
  };
}
