import { CairnError, stopped } from './errors.mjs';
import { post, pause } from './http.mjs';

const METHODS = new Set(['getMe', 'deleteWebhook', 'getUpdates', 'setMyCommands', 'sendMessage']);

export class Telegram {
  constructor(config, signal, log) { this.config = config; this.signal = signal; this.log = log; }

  async call(method, params = {}) {
    if (!METHODS.has(method)) throw new CairnError('Unsupported Telegram method.', 2);
    const url = `${this.config.api}/bot${this.config.token}/${method}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      let response, json;
      try {
        ({ response, json } = await post(url, params, (Number(params.timeout) || 0) * 1000 + 10000, this.signal));
      } catch {
        stopped(this.signal);
        // Telegram has no send idempotency key. An ambiguous network failure cannot be retried safely.
        if (method === 'sendMessage' || attempt === 2) throw new CairnError('Telegram unreachable. Check TELEGRAM_API_ROOT and your connection.');
        await pause(200 * 2 ** attempt, this.signal);
        continue;
      }
      const code = Number(json?.error_code ?? response.status);
      if (code === 401) throw new CairnError('Telegram rejected the bot token (401). Replace TELEGRAM_BOT_TOKEN.', 3);
      if (code === 409) throw new CairnError('Telegram conflict (409): another instance is running. Stop the other instance.');
      if (code === 403) return null;
      if (response.ok && json?.ok === true) return json.result;
      if (code === 429 && attempt < 2) {
        const seconds = Number(json?.parameters?.retry_after);
        if (!Number.isFinite(seconds) || seconds < 0) throw new CairnError('Telegram rate limit returned an invalid retry_after.');
        this.log('warn', 'telegram_rate_limit', { seconds });
        await pause(seconds * 1000, this.signal);
        continue;
      }
      if (code >= 500 && attempt < 2) {
        await pause(200 * 2 ** attempt, this.signal);
        continue;
      }
      throw new CairnError(`Telegram request failed (${Number.isInteger(code) ? code : 'invalid response'}). Check bot permissions and connectivity.`);
    }
    throw new CairnError('Telegram unreachable.');
  }

  updates(offset, timeout, limit = 100) {
    return this.call('getUpdates', { offset, timeout, limit, allowed_updates: ['message'] });
  }

  async send(message, html) {
    return this.call('sendMessage', {
      chat_id: message.chat.id, text: html, parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
    });
  }
}
