import { NodeBusy } from './errors.mjs';
import { normalize } from './felt.mjs';
import { dollars, escapeHtml, parseDecimal, plainText, short, unescapeHtml } from './format.mjs';
import { addressInput, looksLikeName } from './names.mjs';
import { usdPair } from './prices.mjs';
import { LIMITS } from './subscriptions.mjs';
import { VENUES } from './venues.mjs';

// The chat settings: round 2's /watch, /unwatch, /list, /whale, /unwhale, /min, /mute, /unmute, /track,
// /export, /forget and the buttons, and round 3's /feed and /unfeed. A handler does its reads and chain calls
// first, then returns a commit: a synchronous function the bot runs in the transaction that also confirms the
// update, before any reply is sent. In groups every one of them but /list needs an administrator. A feed,
// watch, whale or track set up in a forum topic posts into that topic.

export const SETTINGS = new Set(['watch', 'unwatch', 'list', 'whale', 'unwhale', 'min', 'mute', 'unmute', 'track', 'export', 'forget', 'feed', 'unfeed', 'network', 'guard']);
const OPEN_IN_GROUPS = new Set(['list']);
const BUSY = 'node busy: Cairn cannot read the chain right now, so nothing was changed. Please try again shortly.';
const ADMIN_ONLY = 'Only an administrator of this group can change Cairn’s settings. Anyone here can read them with /list.';
const FEED_USAGE = 'Usage: /feed &lt;SYMBOL|token address&gt; [&lt;min&gt;|$&lt;usd&gt;] [buys|all], for example /feed STRK $100 all. ' +
  'The floor is a token amount or a dollar value; buys (the default) posts buys only, all posts sells too.';
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const say = (html, keyboard) => () => ({ lines: html.split('\n'), keyboard });
/** Where a subscription posts, said whenever it is in a forum topic or has just left one. */
const where = (before, thread) => (thread !== null ? ' Its posts go to this topic.'
  : before !== null && before !== undefined ? ' Its posts now go to the main thread.' : '');

export async function setting(command, ctx) {
  if (ctx.chat.type !== 'private' && !OPEN_IN_GROUPS.has(command.name) && !(await ctx.admin())) return say(ADMIN_ONLY);
  try { return await HANDLERS[command.name](command.argument.trim(), ctx); }
  catch (error) {
    if (error instanceof NodeBusy && !ctx.signal.aborted) return say(BUSY);
    throw error;
  }
}

/** How a watched address reads in this chat: its label, the name it was given by, or its short form, linked. */
const watchName = (ctx, w, name = null) => ctx.fmt.contract(w.address, w.label ? escapeHtml(w.label) : name ? escapeHtml(name) : short(w.address));

const HANDLERS = {
  async network(arg, ctx) {
    if (!/^(on|off)$/.test(arg)) return say('Usage: /network on|off');
    return () => { ctx.guards.set(ctx.chat, 'network', arg === 'on'); return say(`Network alerts: ${arg}.`)(); };
  },

  async guard(arg, ctx) {
    const match = /^(seed|links) (on|off)$/.exec(arg);
    if (!match) return say('Usage: /guard seed|links on|off');
    return () => { ctx.guards.set(ctx.chat, match[1], match[2] === 'on'); return say(`${match[1]} guard: ${match[2]}.`)(); };
  },

  async watch(arg, ctx) {
    const m = /^(\S+)(?:\s+([\s\S]+))?$/.exec(arg);
    if (!m) return say('Usage: /watch &lt;address|name.stark&gt; [label], for example /watch 0x0471…938d Treasury or /watch ben.stark.');
    const label = plainText(m[2] ?? '', Infinity) || null;
    let address, name = null;
    if (looksLikeName(m[1])) {
      const r = await ctx.names.resolve(m[1]);
      if (r.error) return say(escapeHtml(r.error));
      ({ address, name } = r);
    } else {
      try { address = normalize(m[1]); } catch (error) { return say(escapeHtml(error.message)); }
    }
    if (label && Array.from(label).length > LIMITS.label) return say(`Labels are at most ${LIMITS.label} characters; that one has ${Array.from(label).length}. Nothing was changed.`);
    if (label && /^0x[0-9a-f]*$/i.test(label)) return say('A label cannot look like an address, or /unwatch could not tell them apart. Nothing was changed.');
    if (!ctx.head) return say(BUSY);
    const since = ctx.head.block_number;
    return () => {
      const r = ctx.subs.watch(ctx.chat, address, label, since, ctx.thread);
      if (r.status === 'cap') return say(`This chat already watches ${ctx.config.maxWatches} addresses, the most it can. Remove one with /unwatch or the buttons in /list.`)();
      // A watch set up by name shows the address it resolved to, so the group can check it.
      const via = !name ? '' : r.watch.label ? ` (${escapeHtml(name)}, ${short(address)})` : ` (${short(address)})`;
      if (r.status === 'exists') {
        return say(`Already watching ${watchName(ctx, r.watch, name)}${via}${r.relabelled ? '; its label is updated' : ''}.${r.moved ? where(r.before, ctx.thread) : ''}`)();
      }
      return say(`👁 Watching ${watchName(ctx, r.watch, name)}${via} from block ${since + 1}: every transfer in or out, on any token, and every approval it grants.${where(null, ctx.thread)}\n` +
        'Skip small transfers with /min, silence a spam token with /mute, and manage it in /list.')();
    };
  },

  async unwatch(arg, ctx) {
    if (!arg) return say('Usage: /unwatch &lt;address|name.stark|label&gt;. /list shows what this chat watches.');
    let address = null;
    if (looksLikeName(arg) && ctx.names.enabled) address = (await ctx.names.resolve(arg)).address ?? null; // else it may be a label
    else try { address = normalize(arg); } catch { /* a label */ }
    return () => {
      const r = ctx.subs.unwatch(ctx.chat.id, address ? { address } : { label: plainText(arg, Infinity) });
      if (r.watch) return say(`Stopped watching ${watchName(ctx, r.watch)}.`)();
      if (r.ambiguous) return say(`${r.ambiguous} watches here are labelled ${escapeHtml(plainText(arg, 40))}: use the address, or the buttons in /list. Nothing was changed.`)();
      return say(`No watch here matches ${escapeHtml(plainText(arg, 40))}. /list shows what this chat watches.`)();
    };
  },

  async list(_, ctx) { return () => listView(ctx.chat.id, ctx); },

  async whale(arg, ctx) {
    const m = /^(\S+)\s+(\S+)$/.exec(arg);
    if (!m) return say('Usage: /whale &lt;SYMBOL|token address&gt; &lt;amount&gt;, for example /whale STRK 1000000.');
    if (!ctx.head) return say(BUSY);
    const { token, error } = await ctx.tokens.resolve(m[1], ctx.head.timestamp, ctx.names);
    if (error) return say(escapeHtml(error));
    const amount = parseDecimal(m[2], token.decimals);
    if (amount.error) return say(`${escapeHtml(amount.error)} Nothing was changed.`);
    if (amount.units === 0n) return say('Use an amount above zero: zero-amount transfers are never alerted. Nothing was changed.');
    const since = ctx.head.block_number;
    return () => {
      const before = ctx.subs.whales(ctx.chat.id).find((w) => w.token === token.address)?.thread_id;
      const r = ctx.subs.whale(ctx.chat, token.address, token.symbol, amount.text, amount.units, since, ctx.thread);
      const name = ctx.fmt.token(token), topic = where(before, ctx.thread);
      if (r === 'cap') return say(`This chat already has ${LIMITS.whales} whale alerts, the most it can. Stop one with /unwhale or in /list.`)();
      if (r === 'updated') return say(`🐋 Whale alert on ${name} updated: every transfer of at least ${escapeHtml(amount.text)} ${name}.${topic}`)();
      return say(`🐋 Whale alert on ${name}: every transfer of at least ${escapeHtml(amount.text)} ${name} from block ${since + 1}, mints and burns labelled.${topic}`)();
    };
  },

  async unwhale(arg, ctx) {
    const token = await tokenAddress(arg, ctx);
    if (token.error) return say(escapeHtml(token.error));
    return () => {
      const removed = ctx.subs.unwhale(ctx.chat.id, { token: token.address });
      return say(removed ? `Whale alert on ${tokenName(ctx, removed.token)} stopped.` : 'No whale alert on that token here. /list shows them.')();
    };
  },

  async min(arg, ctx) {
    const m = /^(\S+)\s+(\S+)$/.exec(arg);
    if (!m) return say('Usage: /min &lt;SYMBOL|token address&gt; &lt;amount&gt;, for example /min STRK 5. Use 0 to remove a floor.');
    const { token, error } = await ctx.tokens.resolve(m[1], ctx.head?.timestamp ?? 0, ctx.names);
    if (error) return say(escapeHtml(error));
    const amount = parseDecimal(m[2], token.decimals);
    if (amount.error) return say(`${escapeHtml(amount.error)} Nothing was changed.`);
    return () => {
      const r = ctx.subs.minimum(ctx.chat, token.address, amount.text, amount.units);
      const name = ctx.fmt.token(token);
      if (r === 'cap') return say(`This chat already has ${LIMITS.minimums} floors, the most it can. Remove one with /min &lt;token&gt; 0.`)();
      if (r === 'removed') return say(`Floor on ${name} removed: every ${name} transfer of a watched address alerts again.`)();
      if (r === 'none') return say(`There is no floor on ${name} here.`)();
      return say(`Watch alerts here now skip ${name} transfers below ${escapeHtml(amount.text)} ${name}. Whale alerts and approvals are not affected.`)();
    };
  },

  async mute(arg, ctx) {
    const token = await tokenAddress(arg, ctx, 'mute');
    if (token.error) return say(escapeHtml(token.error));
    return () => {
      const r = ctx.subs.mute(ctx.chat, token.address);
      const name = tokenName(ctx, token.address);
      if (r === 'cap') return say(`This chat already mutes ${LIMITS.muted} tokens, the most it can.`)();
      if (r === 'exists') return say(`${name} is already muted here.`)();
      return say(`🔇 Muted ${name}: no alerts on that token in this chat. /unmute ${token.address} undoes it.`)();
    };
  },

  async unmute(arg, ctx) {
    const token = await tokenAddress(arg, ctx, 'unmute');
    if (token.error) return say(escapeHtml(token.error));
    return () => say(ctx.subs.unmute(ctx.chat.id, token.address)
      ? `🔔 ${tokenName(ctx, token.address)} is no longer muted here.` : 'That token is not muted here. /list shows the muted ones.')();
  },

  async track(arg, ctx) {
    let hash;
    try { hash = normalize(arg, 'hash'); } catch (error) { return say(escapeHtml(error.message)); }
    if (!ctx.head) return say(BUSY);
    return trackCommit(ctx, ctx.chat, hash, say, ctx.thread);
  },

  /**
   * /feed <SYMBOL|address> [<min>|$<usd>] [buys|all]: the chat's one trade feed, replacing any other. The
   * floor is a token amount or a dollar value (which needs a fresh price, so never on an unverified token);
   * buys, the default, posts buys only.
   */
  async feed(arg, ctx) {
    if (!ctx.venues.length) {
      return say(`📉 The trade feed is off on this instance: its network file names no venue (${VENUES.map((v) => `contracts.${v.contract}`).join(', ')}), so no trade can be read.`);
    }
    const [first, ...options] = arg.split(/\s+/).filter(Boolean);
    if (!first || options.length > 2) return say(FEED_USAGE);
    if (!ctx.head) return say(BUSY);
    const { token, error } = await ctx.tokens.resolve(first, ctx.head.timestamp, ctx.names);
    if (error) return say(escapeHtml(error));
    let mode = null, floor;
    for (const option of options) {
      if (/^(buys|all)$/i.test(option)) {
        if (mode) return say(FEED_USAGE);
        mode = option.toLowerCase();
        continue;
      }
      if (floor !== undefined) return say(FEED_USAGE);
      const usd = option.startsWith('$'), value = parseDecimal(usd ? option.slice(1) : option, usd ? 2 : token.decimals);
      if (value.error) return say(`${escapeHtml(usd ? value.error.replace(/This token has 2 decimals/, 'Dollars have cents') : value.error)} Nothing was changed.`);
      floor = value.units === 0n ? null : usd ? { usd: value.units, text: dollars(value.units) } : { units: value.units, text: value.text };
    }
    mode ??= 'buys';
    const name = ctx.fmt.token(token);
    if (floor?.usd !== undefined) {
      if (!token.verified) return say(`A dollar floor needs a USD value, and ${name} is outside the registry: unverified tokens never get one. Use a token amount instead. Nothing was changed.`);
      if (!ctx.prices.enabled) return say('Dollar floors are off on this instance: its network file has no contracts.pragma, so Cairn reads no prices. Use a token amount instead. Nothing was changed.');
    }
    const since = ctx.head.block_number;
    const venues = ctx.venues.map((v) => v.name).join(' and ');
    const sides = mode === 'all' ? 'buy and sell' : 'buy';
    const least = floor ? ` of at least ${escapeHtml(floor.text)}${floor.units !== undefined ? ` ${name}` : ''}` : '';
    const valued = !token.verified ? `No USD values: ${name} is outside the registry.`
      : !ctx.prices.enabled ? 'No USD values: this instance reads no prices.'
        : usdPair(token.pragma_pair) ? `USD values from Pragma's ${escapeHtml(token.pragma_pair)}, when fresh.`
          : 'USD values from what traders pay, priced by Pragma, when fresh.';
    return () => {
      const r = ctx.subs.feed(ctx.chat, { token: token.address, symbol: token.symbol, min: floor?.text ?? null,
        minUnits: floor?.units ?? null, minUsd: floor?.usd ?? null, mode }, since, ctx.thread);
      const replaced = r.status === 'replaced' ? ` It replaces the feed on ${tokenName(ctx, r.previous.token)}: one feed per chat.` : '';
      return say(`📈 Trade feed on ${name}${r.status === 'updated' ? ' updated' : ''}: every ${sides}${least} on ${venues}, from block ${(r.status === 'updated' ? r.previous.since_block : since) + 1}.${replaced}${where(r.previous?.thread_id, ctx.thread)}\n` +
        `Each post shows the trader (a verified .stark name or the address) and flags a new holder. ${valued} /unfeed stops it.`)();
    };
  },

  async unfeed(_, ctx) {
    return () => {
      const removed = ctx.subs.unfeed(ctx.chat.id);
      return say(removed ? `Trade feed on ${tokenName(ctx, removed.token)} stopped.` : 'There is no trade feed in this chat. Start one with /feed &lt;token&gt; [&lt;min&gt;|$&lt;usd&gt;] [buys|all].')();
    };
  },

  async export(_, ctx) {
    return () => {
      const json = JSON.stringify(ctx.subs.export(ctx.chat.id));
      return { messages: chunks(json, 4000).map((part) => `<pre>${escapeHtml(part)}</pre>`) };
    };
  },

  async forget(_, ctx) {
    return () => {
      const c = ctx.subs.forget(ctx.chat.id);
      return say(`🗑 Deleted everything Cairn stored for this chat: ${plural(c.feeds, 'trade feed')}, ${plural(c.watches, 'watch', 'watches')}, ` +
        `${plural(c.whales, 'whale alert')}, ${plural(c.minimums, 'floor')}, ${plural(c.muted, 'mute')}, ${plural(c.tracks, 'track')}, ` +
        `${plural(c.offers, 'button')} and ${plural(c.deliveries, 'alert record')}.`)();
    };
  },
};

/** /track and the Track button share the commit and its words. */
function trackCommit(ctx, chat, hash, reply = say, thread = null) {
  const { block_number: since, timestamp } = ctx.head;
  return () => {
    const r = ctx.subs.track(chat, hash, since, timestamp, thread);
    if (r === 'cap') return reply(`This chat already tracks ${LIMITS.tracks} transactions, the most it can. Wait for one to finish, or stop one in /list.`)();
    if (r === 'exists') return reply(`Already tracking ${short(hash)}.`)();
    return reply(`⏱ Tracking ${short(hash)}. Cairn posts once when Starknet accepts it, and once when it is final on Ethereum or fails. A hash still unknown after 10 minutes is dropped.`)();
  };
}

/** A token address for /mute, /unmute and /unwhale: a registry symbol works for /unwhale only. */
async function tokenAddress(arg, ctx, command) {
  if (!arg) return { error: command ? `Usage: /${command} <token address>.` : 'Usage: /unwhale <SYMBOL|token address>.' };
  if (looksLikeName(arg)) return addressInput(arg, ctx.names);
  if (!/^0x/i.test(arg)) {
    if (command) return { error: `Use the token's contract address: /${command} 0x… (any token can claim any symbol).` };
    const token = ctx.tokens.bySymbol(arg);
    return token ? { address: token.address } : { error: 'Unknown symbol: give the token address shown in /list.' };
  }
  try { return { address: normalize(arg) }; } catch (error) { return { error: error.message.replace('address', 'token address') }; }
}

/** A token by address with what Cairn knows of it, without a chain call. */
function tokenName(ctx, address) {
  const known = ctx.tokens.registry.get(address) ?? ctx.tokens.cached(address);
  return known ? ctx.fmt.token(known) : ctx.fmt.contract(address);
}
/** A whale alert's symbol where no markup is allowed (buttons, button answers), still marked when unverified. */
const plainSymbol = (ctx, whale) => `${plainText(whale.symbol, 11)}${ctx.tokens.registry.has(whale.token) ? '' : ' (unverified)'}`;

/** Splits text into pieces of at most `size` UTF-16 units, never inside a character. */
function chunks(text, size) {
  const out = [];
  let current = '';
  for (const character of text) {
    if (current.length + character.length > size) { out.push(current); current = ''; }
    current += character;
  }
  if (current || !out.length) out.push(current);
  return out;
}

/** A feed's rule in words: which side, at or above which floor. */
const feedRule = (ctx, feed) => `${feed.mode === 'all' ? 'buys and sells' : 'buys'}${feed.min
  ? ` of at least ${escapeHtml(feed.min)}${feed.min_usd === null ? ` ${tokenName(ctx, feed.token)}` : ''}` : ''}`;

/**
 * The chat's settings with a Remove button per subscription, in one message. It makes no chain call, so that
 * /list answers at once however many watches the chat has.
 */
export function listView(chatId, ctx) {
  const { subs, fmt } = ctx;
  const watches = subs.watches(chatId), whales = subs.whales(chatId), floors = subs.minimums(chatId);
  const muted = subs.muted(chatId), tracks = subs.tracks(chatId), feed = subs.feedOf(chatId);
  if (!feed && !watches.length && !whales.length && !floors.length && !muted.length && !tracks.length) {
    return { lines: ['Nothing is set up in this chat yet.', 'Start with /feed &lt;token&gt;, /watch &lt;address&gt; [label] or /whale &lt;token&gt; &lt;amount&gt;. /help lists everything.'], keyboard: [] };
  }
  const lines = [], keyboard = [];
  let size = 0, hidden = 0;
  const add = (line, button) => {
    if (size + line.length > 3600 || keyboard.length >= 90) { hidden++; return; }
    lines.push(line);
    size += line.length + 1;
    if (button) keyboard.push([button]);
  };
  const section = (title, count) => { if (count) add(`<b>${title}</b>`); };
  section('Trade feed', feed ? 1 : 0);
  if (feed) {
    const off = ctx.venues?.length ? '' : ' · off: no venue on this instance';
    add(`• ${tokenName(ctx, feed.token)}: ${feedRule(ctx, feed)} · from block ${feed.since_block + 1}${off}`,
      { text: `Stop feed ${plainText(feed.symbol, 11)}${ctx.tokens.registry.has(feed.token) ? '' : ' (unverified)'}`, callback_data: `rf:${feed.id}` });
  }
  section(`Watches · ${watches.length} of ${ctx.config.maxWatches}`, watches.length);
  for (const w of watches) {
    add(`• ${w.label ? `<b>${escapeHtml(w.label)}</b> ` : ''}${fmt.contract(w.address)} · from block ${w.since_block + 1}`,
      { text: `Remove ${plainText(w.label ?? short(w.address), 32)}`, callback_data: `rw:${w.id}` });
  }
  section(`Whale alerts · ${whales.length} of ${LIMITS.whales}`, whales.length);
  for (const w of whales) {
    add(`• ${tokenName(ctx, w.token)} at or above ${escapeHtml(w.min)}`, { text: `Stop whale ${plainSymbol(ctx, w)}`, callback_data: `rh:${w.id}` });
  }
  section('Floors for watch alerts', floors.length);
  for (const f of floors) add(`• ${tokenName(ctx, f.token)} below ${escapeHtml(f.amount)} is skipped`);
  section('Muted tokens', muted.length);
  for (const token of muted) add(`• ${tokenName(ctx, token)}`);
  section(`Tracked transactions · ${tracks.length} of ${LIMITS.tracks}`, tracks.length);
  for (const t of tracks) {
    add(`• ${fmt.tx(t.hash)} · ${t.stage === 0 ? 'waiting for acceptance' : 'accepted, waiting for Ethereum'}`,
      { text: `Stop tracking ${short(t.hash)}`, callback_data: `rt:${t.id}` });
  }
  if (hidden) lines.push(`… and ${hidden} more lines: /export lists everything.`);
  return { lines, keyboard };
}

/**
 * A button press. Buttons carry `<verb>:<server id>`, never an address; the id must belong to the chat the
 * button is in, and in groups the person pressing it must be an administrator now. The commit returns
 * { answer, edit?, reply? }; the bot answers every callback_query exactly once.
 */
export async function callback(query, ctx) {
  const chat = query.message?.chat, messageId = query.message?.message_id;
  const m = /^(rw|rh|rt|rf|ow|ot):(\d{1,15})$/.exec(String(query.data ?? ''));
  const answer = (text) => () => ({ answer: text });
  if (!m || !Number.isSafeInteger(chat?.id)) return answer('This button no longer works. Send /list for fresh ones.');
  if (chat.type !== 'private' && !(await ctx.admin(query.from))) return answer('Only an administrator of this group can change Cairn’s settings.');
  const id = Number(m[2]);
  const elsewhere = answer('This button belongs to another chat, or what it removes is already gone.');
  const refreshed = (text) => ({ answer: text, edit: { chat_id: chat.id, message_id: messageId, ...listView(chat.id, ctx) } });
  switch (m[1]) {
    case 'rw': {
      const w = ctx.subs.watchById(id);
      if (w?.chat_id !== chat.id) return elsewhere;
      return () => { ctx.subs.unwatch(chat.id, { id }); return refreshed(`Stopped watching ${plainText(w.label ?? short(w.address), 40)}.`); };
    }
    case 'rh': {
      const w = ctx.subs.whaleById(id);
      if (w?.chat_id !== chat.id) return elsewhere;
      return () => { ctx.subs.unwhale(chat.id, { id }); return refreshed(`Whale alert on ${plainSymbol(ctx, w)} stopped.`); };
    }
    case 'rt': {
      const t = ctx.subs.trackById(id);
      if (t?.chat_id !== chat.id) return elsewhere;
      return () => { ctx.subs.untrack(chat.id, { id }); return refreshed(`Stopped tracking ${short(t.hash)}.`); };
    }
    case 'rf': {
      const f = ctx.subs.feedById(id);
      if (f?.chat_id !== chat.id) return elsewhere;
      return () => { ctx.subs.unfeed(chat.id, { id }); return refreshed(`Trade feed on ${plainText(f.symbol, 11)} stopped.`); };
    }
    default: {
      if (!ctx.head) return answer('node busy: try again in a moment.');
      const offer = ctx.subs.offerById(id, ctx.head.timestamp);
      if (offer?.chat_id !== chat.id || offer.kind !== (m[1] === 'ow' ? 'watch' : 'track')) return answer('This button has expired. Paste the address or hash again.');
      const asReply = (html) => () => ({ answer: plainText(unescapeHtml(html.replace(/<[^>]+>/g, '')), 190), reply: { lines: html.split('\n') } });
      if (m[1] === 'ot') return trackCommit(ctx, chat, offer.value, asReply);
      const since = ctx.head.block_number;
      return () => {
        const r = ctx.subs.watch(chat, offer.value, null, since);
        if (r.status === 'cap') return asReply(`This chat already watches ${ctx.config.maxWatches} addresses, the most it can.`)();
        if (r.status === 'exists') return asReply(`Already watching ${watchName(ctx, r.watch)}.`)();
        return asReply(`👁 Watching ${watchName(ctx, r.watch)} from block ${since + 1}. Add a label with /watch ${r.watch.address} &lt;label&gt;; /list manages it.`)();
      };
    }
  }
}
