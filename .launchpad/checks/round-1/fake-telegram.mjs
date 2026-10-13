// A fake Telegram Bot API for round 1's checks: node:http on 127.0.0.1:0, Node built-ins only. It serves
// every method of ARCHITECTURE.md's list for rounds 1 to 4 (anything else is 404), validates messages the
// way Telegram does (HTML tags and entities, 1 to 4096 UTF-16 units after parsing, buttons), long-polls
// like Telegram, and records every request so the checks can read what Cairn sent and when.
import { createServer } from "node:http";

/** The methods Cairn may call (ARCHITECTURE.md, rounds 1 to 4). Anything else gets 404. */
export const METHODS = ["getMe", "deleteWebhook", "getUpdates", "sendMessage", "setMyCommands", "sendChatAction",
  "answerCallbackQuery", "editMessageText", "getChatMember", "deleteMessage"];

// Tags Telegram's HTML parse mode accepts, with the attributes it reads.
const TAGS = new Set(["b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "span", "tg-spoiler", "a", "tg-emoji", "code", "pre", "blockquote", "tg-time"]);

/**
 * Parses `text` as Telegram's HTML parse mode does: returns { plain } or { error }. Tags must be supported and
 * balanced (case-insensitive names, quoted or bare attribute values); `&lt; &gt; &amp; &quot;` and numeric
 * references are decoded, and any other `&` or a bare `>` is kept as text, as Telegram does. A `<` that does
 * not open a supported tag is an error, which is what an unescaped outside string usually produces.
 */
export function parseHtml(text) {
  let plain = "", i = 0;
  const stack = [];
  const at = () => `at byte offset ${Buffer.byteLength(text.slice(0, i))}`;
  while (i < text.length) {
    const c = text[i];
    if (c === "&") {
      const m = /^&(?:(lt|gt|amp|quot)|#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6}));/.exec(text.slice(i, i + 12));
      if (m) {
        const cp = m[1] ? { lt: 60, gt: 62, amp: 38, quot: 34 }[m[1]] : m[2] ? Number(m[2]) : parseInt(m[3], 16);
        if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return { error: `Bad Request: can't parse entities: invalid character reference ${at()}` };
        plain += String.fromCodePoint(cp);
        i += m[0].length;
        continue;
      }
      plain += c;
      i++;
      continue;
    }
    if (c !== "<") {
      plain += c;
      i++;
      continue;
    }
    const close = text[i + 1] === "/";
    const nm = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(text.slice(i + (close ? 2 : 1), i + 64));
    if (!nm) return { error: `Bad Request: can't parse entities: Unsupported start tag ${at()}` };
    const name = nm[0].toLowerCase();
    let j = i + (close ? 2 : 1) + nm[0].length;
    if (close) {
      while (/\s/.test(text[j] ?? "")) j++;
      if (text[j] !== ">") return { error: `Bad Request: can't parse entities: Unclosed end tag ${at()}` };
      const top = stack.pop();
      if (!top || top.name !== name) return { error: `Bad Request: can't parse entities: Unmatched end tag ${at()}, expected "</${top?.name ?? ""}>", found "</${name}>"` };
      i = j + 1;
      continue;
    }
    if (!TAGS.has(name)) return { error: `Bad Request: can't parse entities: Unsupported start tag "${name}" ${at()}` };
    const attrs = {};
    for (;;) {
      while (/\s/.test(text[j] ?? "")) j++;
      if (j >= text.length) return { error: `Bad Request: can't parse entities: Unclosed start tag ${at()}` };
      if (text[j] === ">") break;
      const an = /^[a-zA-Z][a-zA-Z0-9_-]*/.exec(text.slice(j, j + 64));
      if (!an) return { error: `Bad Request: can't parse entities: Expected equal sign in declaration of an attribute of the tag "${name}" ${at()}` };
      j += an[0].length;
      while (/\s/.test(text[j] ?? "")) j++;
      let value = "";
      if (text[j] === "=") {
        j++;
        while (/\s/.test(text[j] ?? "")) j++;
        const q = text[j];
        if (q === '"' || q === "'") {
          const end = text.indexOf(q, j + 1);
          if (end < 0) return { error: `Bad Request: can't parse entities: Unclosed start tag at byte offset ${Buffer.byteLength(text.slice(0, j))}` };
          value = text.slice(j + 1, end);
          j = end + 1;
        } else {
          const m = /^[^\s>]*/.exec(text.slice(j));
          value = m[0];
          j += value.length;
        }
        value = value.replace(/&(?:(lt|gt|amp|quot)|#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6}));/g, (_, n, d, h) => String.fromCodePoint(n ? { lt: 60, gt: 62, amp: 38, quot: 34 }[n] : d ? Number(d) : parseInt(h, 16)));
      }
      attrs[an[0].toLowerCase()] = value;
    }
    if (name === "span" && attrs.class !== "tg-spoiler") return { error: `Bad Request: can't parse entities: Tag "span" must have class "tg-spoiler" ${at()}` };
    if (name === "tg-emoji" && !/^\d+$/.test(attrs["emoji-id"] ?? "")) return { error: `Bad Request: can't parse entities: Tag "tg-emoji" must have attribute "emoji-id" ${at()}` };
    if (name === "a" && stack.some((t) => t.name === "a")) return { error: `Bad Request: can't parse entities: a link inside a link ${at()}` };
    stack.push({ name, attrs });
    i = j + 1;
  }
  if (stack.length) return { error: `Bad Request: can't parse entities: Can't find end tag corresponding to start tag "${stack.at(-1).name}"` };
  return { plain };
}

/** The links (`<a href>`) of a valid HTML message, decoded. */
export function linksOf(html) {
  const out = [];
  for (const m of html.matchAll(/<a\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    out.push((m[1] ?? m[2] ?? m[3]).replace(/&(?:(lt|gt|amp|quot)|#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6}));/g, (_, n, d, h) => String.fromCodePoint(n ? { lt: 60, gt: 62, amp: 38, quot: 34 }[n] : d ? Number(d) : parseInt(h, 16))));
  }
  return out;
}

/** Why a reply_markup is refused, or null. Mini App, login and payment buttons are refused and noted. */
function markupError(rm, violations) {
  if (rm === undefined || rm === null) return null;
  if (typeof rm !== "object") return "Bad Request: can't parse reply keyboard markup JSON object";
  for (const key of ["inline_keyboard", "keyboard"]) {
    if (rm[key] === undefined) continue;
    if (!Array.isArray(rm[key])) return `Bad Request: field "${key}" must be an Array`;
    for (const row of rm[key]) {
      if (!Array.isArray(row)) return `Bad Request: ${key} rows must be Arrays`;
      for (const b of row) {
        const btn = typeof b === "string" ? { text: b } : b;
        if (!btn || typeof btn.text !== "string" || btn.text === "") return "Bad Request: button text is empty";
        for (const banned of ["web_app", "login_url", "pay"]) {
          if (btn[banned] !== undefined && btn[banned] !== false) {
            violations.push(`a ${banned} button in ${key}: ${JSON.stringify(btn).slice(0, 200)}`);
            return "Bad Request: BUTTON_TYPE_INVALID";
          }
        }
        if (btn.callback_data !== undefined) {
          const n = Buffer.byteLength(String(btn.callback_data));
          if (n < 1 || n > 64) return "Bad Request: BUTTON_DATA_INVALID";
        }
        if (btn.url !== undefined && !/^(https?|tg):\/\/\S+$/i.test(String(btn.url))) return "Bad Request: BUTTON_URL_INVALID";
      }
    }
  }
  return null;
}

const INTS = new Set(["chat_id", "message_id", "offset", "limit", "timeout", "user_id", "message_thread_id"]);
const BOOLS = new Set(["drop_pending_updates", "disable_notification", "protect_content", "show_alert", "disable_web_page_preview"]);
const JSONS = new Set(["reply_markup", "allowed_updates", "entities", "link_preview_options", "reply_parameters", "commands", "scope"]);
/** Form and query values come as strings: read them as Telegram does. */
function coerce(p) {
  for (const [k, v] of Object.entries(p)) {
    if (typeof v !== "string") continue;
    if (INTS.has(k) && /^-?\d+$/.test(v)) p[k] = Number(v);
    else if (BOOLS.has(k)) p[k] = v === "true";
    else if (JSONS.has(k)) {
      try {
        p[k] = JSON.parse(v);
      } catch {}
    }
  }
  return p;
}

/**
 * A fake Bot API. `token` is the one it accepts (any other gets 401); `me` is getMe's answer; `t0` the
 * first `message.date` (each user's next message comes 8 s after their previous one).
 */
export function fakeTelegram({ token, me, t0 = Math.floor(Date.parse("2026-10-20T00:00:00Z") / 1000), holdMs = 1000 }) {
  const calls = [], requests = [], accepted = [], violations = [], queue = [], rules = [], hooks = [];
  const chats = new Map(), dates = new Map(), members = new Map(), blocked = new Set();
  let updateId = 100, messageId = 5000, acked = 0, poll = null, server = null, url = null;
  const reply = (res, code, body) => {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const fail = (res, code, description, parameters) => reply(res, code, { ok: false, error_code: code, description, ...(parameters ? { parameters } : {}) });
  const wake = () => poll?.done();

  const fake = {
    me, calls, requests, accepted, violations, members, blocked,
    get url() { return url; },
    /** The highest update_id Cairn confirmed (an offset above it). */
    get acked() { return acked; },
    /** Whether a getUpdates is being held right now. */
    get holding() { return poll !== null; },
    get pending() { return queue.length; },

    user: (id, first_name, extra = {}) => ({ id, is_bot: false, first_name, ...extra }),
    dm: (user) => ({ id: user.id, type: "private", first_name: user.first_name }),
    group: (id, title, type = "supergroup") => ({ id, type, title }),
    /** Queues a text message from `from` in `chat`, with a bot_command entity when it starts with one. */
    say(chat, from, text, extra = {}) {
      chats.set(chat.id, chat);
      const date = (dates.get(from.id) ?? t0 - 8) + 8;
      dates.set(from.id, date);
      const cmd = /^\/[A-Za-z0-9_]+(@[A-Za-z0-9_]+)?/.exec(text);
      const message = { message_id: messageId++, from, chat, date, text, ...(cmd ? { entities: [{ type: "bot_command", offset: 0, length: cmd[0].length }] } : {}), ...extra };
      const u = { update_id: ++updateId, message };
      queue.push(u);
      wake();
      return u;
    },
    /** Answers the next `times` calls of `method` (to `chat`, if given) with an error. */
    fail(method, { chat, code, description, parameters, times = 1 }) {
      rules.push({ method, chat, code, description, parameters, times });
    },
    /**
     * Calls `fn(message)` as soon as a sendMessage is accepted, before the answer is written: a check can
     * kill Cairn at the moment Telegram has its reply, before Cairn can do anything after it.
     */
    onSent(fn) {
      hooks.push(fn);
    },
    /** Accepted messages to `chatId`, in order: { text (after parsing), html, params, at }. */
    to: (chatId) => accepted.filter((m) => m.chat_id === chatId),
    callsOf: (method) => calls.filter((c) => c.method === method),

    listen() {
      server = createServer(handle);
      server.keepAliveTimeout = 2000;
      return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
        url = `http://127.0.0.1:${server.address().port}`;
        resolve(fake);
      }));
    },
    get port() { return url ? Number(new URL(url).port) : undefined; },
    close() {
      poll?.done();
      return new Promise((resolve) => {
        if (!server) return resolve();
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };

  const handlers = {
    getMe: () => me,
    deleteWebhook: (p) => {
      if (p.drop_pending_updates) queue.length = 0;
      return true;
    },
    setMyCommands: (p) => {
      const list = p.commands;
      if (!Array.isArray(list) || list.length > 100) return [400, "Bad Request: parameter \"commands\" must be an Array of at most 100 BotCommand"];
      for (const c of list) {
        if (!c || !/^[a-z0-9_]{1,32}$/.test(String(c.command ?? "").replace(/^\//, ""))) return [400, "Bad Request: BOT_COMMAND_INVALID"];
        if (typeof c.description !== "string" || c.description.trim() === "" || c.description.length > 256) return [400, "Bad Request: BOT_COMMAND_DESCRIPTION_INVALID"];
      }
      return true;
    },
    sendChatAction: () => true,
    getChatMember: (p) => ({ status: members.get(`${p.chat_id}:${p.user_id}`) ?? "member", user: { id: p.user_id, is_bot: false, first_name: "Member" } }),
    answerCallbackQuery: () => true,
    deleteMessage: () => true,
    editMessageText: (p) => {
      const m = accepted.find((x) => x.chat_id === p.chat_id && x.message_id === p.message_id);
      if (!m) return [400, "Bad Request: message to edit not found"];
      const r = validateText(p);
      if (Array.isArray(r)) return r;
      if (r.plain === m.text) return [400, "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message"];
      Object.assign(m, { text: r.plain, html: p.text, edited: true });
      return { message_id: m.message_id, chat: chats.get(p.chat_id), date: t0, text: r.plain };
    },
    sendMessage: (p) => {
      if (p.chat_id === undefined || p.chat_id === "") return [400, "Bad Request: chat_id is empty"];
      const chat = chats.get(p.chat_id);
      if (!chat) return [400, "Bad Request: chat not found"];
      if (blocked.has(p.chat_id)) return [403, chat.type === "private" ? "Forbidden: bot was blocked by the user" : "Forbidden: bot was kicked from the supergroup chat"];
      const r = validateText(p);
      if (Array.isArray(r)) return r;
      const m = { message_id: messageId++, chat_id: p.chat_id, text: r.plain, html: p.text, params: p };
      accepted.push(m);
      return { message_id: m.message_id, from: { id: me.id, is_bot: true, first_name: me.first_name, username: me.username }, chat, date: t0, text: r.plain };
    },
  };

  function validateText(p) {
    if (typeof p.text !== "string" || p.text === "") return [400, "Bad Request: message text is empty"];
    let plain = p.text;
    if (p.parse_mode !== undefined) {
      if (String(p.parse_mode).toLowerCase() !== "html") return [400, `Bad Request: unsupported parse_mode ${String(p.parse_mode).slice(0, 20)}: Cairn uses HTML`];
      const r = parseHtml(p.text);
      if (r.error) return [400, r.error];
      plain = r.plain;
    }
    if (plain.trim() === "") return [400, "Bad Request: message text is empty"];
    if (plain.length > 4096) return [400, "Bad Request: message is too long"];
    const mk = markupError(p.reply_markup, violations);
    if (mk) return [400, mk];
    return { plain };
  }

  async function getUpdates(p, res, req) {
    const offset = Number(p.offset ?? 0);
    if (offset > 0) {
      while (queue.length && queue[0].update_id < offset) queue.shift();
      acked = Math.max(acked, offset - 1);
    }
    const limit = Math.min(Math.max(Number(p.limit ?? 100) || 100, 1), 100);
    const allowed = Array.isArray(p.allowed_updates) && p.allowed_updates.length ? p.allowed_updates : null;
    const pick = () => queue.filter((u) => !allowed || allowed.includes(Object.keys(u).find((k) => k !== "update_id"))).slice(0, limit);
    const timeout = Math.max(0, Number(p.timeout ?? 0) || 0);
    if (!pick().length && timeout > 0) {
      // Two polls at once: the second is answered 409 (another instance), as ARCHITECTURE.md says.
      if (poll) return fail(res, 409, "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running");
      let gone = false;
      await new Promise((resolve) => {
        const timer = setTimeout(() => release(), Math.min(timeout * 1000, holdMs));
        const release = () => {
          clearTimeout(timer);
          if (poll === entry) poll = null;
          resolve();
        };
        const entry = { done: release };
        poll = entry;
        res.on("close", () => {
          if (!res.writableEnded) gone = true;
          release();
        });
      });
      if (gone) return;
    }
    reply(res, 200, { ok: true, result: pick() });
  }

  function handle(req, res) {
    const arrived = Date.now();
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: raw, at: arrived });
      const u = new URL(req.url, "http://fake");
      const m = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(u.pathname);
      if (!m) return fail(res, 404, "Not Found");
      if (decodeURIComponent(m[1]) !== token) return fail(res, 401, "Unauthorized");
      const type = String(req.headers["content-type"] ?? "");
      let p = Object.fromEntries(u.searchParams);
      try {
        if (type.startsWith("multipart/")) return fail(res, 400, "Bad Request: the fake Bot API takes no file uploads");
        if (raw && type.includes("json")) p = { ...p, ...JSON.parse(raw) };
        else if (raw) p = { ...p, ...Object.fromEntries(new URLSearchParams(raw)) };
      } catch {
        return fail(res, 400, "Bad Request: can't parse JSON object");
      }
      coerce(p);
      const method = METHODS.find((x) => x.toLowerCase() === m[2].toLowerCase()) ?? m[2];
      const call = { method, params: p, at: arrived, status: 200 };
      calls.push(call);
      const rule = rules.find((r) => r.times > 0 && r.method === method && (r.chat === undefined || r.chat === p.chat_id));
      if (rule) {
        rule.times--;
        call.status = rule.code;
        return fail(res, rule.code, rule.description, rule.parameters);
      }
      if (method === "getUpdates") return getUpdates(p, res, req);
      const h = handlers[method];
      if (!h) {
        call.status = 404;
        return fail(res, 404, "Not Found: method not found");
      }
      const out = h(p);
      if (Array.isArray(out)) {
        call.status = out[0];
        call.error = out[1];
        return fail(res, out[0], out[1]);
      }
      call.result = out;
      if (method === "sendMessage") for (const f of hooks) f(accepted.find((x) => x.message_id === out.message_id));
      reply(res, 200, { ok: true, result: out });
    });
  }
  return fake;
}
