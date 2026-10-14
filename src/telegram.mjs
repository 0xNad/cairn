const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
export class TelegramError extends Error {
  constructor(code) { super(code === 401 ? 'Telegram rejected the token' : code === 409 ? 'Telegram conflict: another instance is running' : `Telegram error ${code}`); this.code = code; }
}
export function telegram(config) {
  async function call(method, body = {}, signal) {
    const address = `${config.telegramRoot}/bot${config.token}/${method}`;
    let response, data;
    try {
      response = await fetch(address, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
      data = await response.json();
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new TelegramError(1);
    }
    if (!response.ok || data.ok !== true) {
      const code = Number(data.error_code) || response.status;
      const err = new TelegramError(code);
      err.retryAfter = data.parameters?.retry_after;
      throw err;
    }
    return data.result;
  }
  async function send(chatId, html) {
    const params = { chat_id: chatId, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
    try { await call('sendMessage', params); return true; }
    catch (e) {
      if (e.code !== 429) throw e;
      await sleep(Math.max(0, Number(e.retryAfter) || 1) * 1000);
      await call('sendMessage', params);
      return true;
    }
  }
  return { call, send };
}
