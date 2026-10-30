import { log } from './errors.mjs';

// Network alerts (round 4). After every head read, the bot tells this module what it saw: a head, or null when
// every RPC endpoint failed. From that it keeps, in CAIRN_DATA, the highest head seen and the wall-clock time Cairn
// first saw it (the stall clock), the current stall and the current outage; and it queues what each one owes as
// deliveries in round 2's ledger, in the same transaction, so that every notice goes out once, in order, through
// restarts and group budgets like any alert:
// - a stall alert for every chat with /network on once the head has not changed for CAIRN_STALL_SECONDS, one per
//   chat and stall (a chat that subscribes during a stall gets it too), and one recovery, with the stall's length,
//   to each chat that got the stall alert, when a higher block arrives;
// - an outage notice to CAIRN_OPERATOR_CHAT only, once per outage, when every endpoint fails, and one when an
//   endpoint answers again; subscribers hear nothing of it, since the chain itself may be fine;
// - a notice to every chat a skipped gap concerns (the scanner jumped over more than CAIRN_MAX_GAP blocks).
// A notice still unsent when its trouble ends is dropped instead of sent late, and then gets no resolution.

const KIND = 'network';
const DIGEST = { k: KIND };
/** A block number as every Cairn message shows it: 4200010. A count of blocks is grouped: 50,000. */
const block = (n) => String(n);
const count = (n) => n.toLocaleString('en-US');

/** A length of time in words, to the second: 45 s, 3 min 12 s, 2 h 5 min, 3 d 4 h. */
export function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h < 48) return `${h} h${m ? ` ${m} min` : ''}`;
  return `${Math.floor(h / 24)} d${h % 24 ? ` ${h % 24} h` : ''}`;
}

export const texts = {
  stall: (stall, now) => `⚠️ <b>Starknet stalled</b>: no new block for ${duration(now - stall.at)}. The head is still block ${block(stall.n)}. Cairn posts here again when blocks resume.`,
  resumed: (stall, head, now) => `✅ <b>Starknet is producing blocks again</b>: block ${block(head.block_number)} arrived after a ${duration(now - stall.at)} stall at block ${block(stall.n)}.`,
  outage: (count) => `🚨 <b>RPC outage</b>: ${count > 1 ? `all ${count} endpoints of STARKNET_RPC_URLS fail` : 'the RPC endpoint fails'}, so Cairn cannot read Starknet. Alerts are on hold and none are lost: scanning picks up where it stopped. Cairn says so here once an endpoint answers.`,
  answered: (outage, endpoint, now) => `✅ <b>RPC back online</b>: ${endpoint} answers again after ${duration(now - outage.at)} of outage. Cairn reads Starknet again and catches up on the blocks it missed.`,
  gap: (from, to, maxGap) => `⏭ <b>Skipped blocks ${block(from)}–${block(to)}</b> (${count(to - from + 1)} blocks): Cairn was further behind than CAIRN_MAX_GAP (${count(maxGap)} blocks) and jumped to the head. Alerts and trades in those blocks were not posted; an explorer shows that range.`,
  deep: (fork, depth) => `⚠️ <b>Reorg deeper than CAIRN_REORG_DEPTH</b> (${count(depth)} blocks): block ${block(fork.from)} changed and none of the hashes Cairn keeps still matched. Cairn rescanned from block ${block(fork.ancestor + 1)}; alerts on blocks before it could not be checked.`,
};

export class Network {
  constructor({ store, ledger, subs, config }) {
    Object.assign(this, { store, ledger, subs, config });
  }
  /** The highest head seen: { n, at, t } (its number, the wall-clock ms Cairn first saw it, its timestamp), or null. */
  get seen() { return this.store.getJson('head_seen'); }
  get stall() { return this.store.getJson('stall'); }
  get outage() { return this.store.getJson('outage'); }
  /** Whether `head` would start a stall now: no higher block for CAIRN_STALL_SECONDS, and none recorded yet. */
  stalling(head, now = Date.now()) {
    const seen = this.seen;
    return Boolean(seen) && head.block_number <= seen.n && now - seen.at >= this.config.stallSeconds * 1000 && !this.stall;
  }
  /** After each head read: the head, or null when every endpoint failed. `endpoint` names the one that answered. */
  observe(head, { now = Date.now(), endpoints = 1, endpoint = 'the node' } = {}) {
    this.store.transaction(() => (head ? this.#up(head, now, endpoint) : this.#down(now, endpoints)));
  }
  #down(now, endpoints) {
    if (this.outage) return;
    const outage = { at: now };
    this.store.setJson('outage', outage);
    log('error', 'rpc outage', { endpoints });
    const chat = this.config.operatorChat;
    if (chat === null) return;
    this.subs.known(chat);
    this.ledger.add({ chatId: chat, txHash: `outage:${outage.at}`, eventIndex: 0, kind: KIND, chainTime: this.seen?.t ?? 0,
      body: texts.outage(endpoints), digest: DIGEST });
  }
  #up(head, now, endpoint) {
    const outage = this.outage;
    if (outage) {
      this.store.setJson('outage', null);
      log('info', 'rpc answers again', { after_s: Math.round((now - outage.at) / 1000) });
      for (const row of this.#resolvable(`outage:${outage.at}`)) {
        this.#add(row.chat_id, row.thread_id, `outage:${outage.at}`, 1, head, texts.answered(outage, endpoint, now));
      }
    }
    const seen = this.seen;
    if (!seen || head.block_number > seen.n) {
      const stall = this.stall;
      if (stall) {
        this.store.setJson('stall', null);
        log('info', 'blocks resume', { block: head.block_number, after_s: Math.round((now - stall.at) / 1000) });
        for (const row of this.#resolvable(stall.key)) {
          const sub = this.subs.networkOf(row.chat_id);
          if (sub) this.#add(row.chat_id, sub.thread_id, stall.key, 1, head, texts.resumed(stall, head, now));
        }
      }
      this.store.setJson('head_seen', { n: head.block_number, at: now, t: head.timestamp });
      return;
    }
    if (now - seen.at < this.config.stallSeconds * 1000) return;
    let stall = this.stall;
    if (!stall) {
      stall = { n: seen.n, at: seen.at, key: `stall:${seen.n}:${seen.at}` };
      this.store.setJson('stall', stall);
      log('warn', 'stall', { block: seen.n, seconds: Math.round((now - seen.at) / 1000) });
    }
    // One stall alert per chat and stall: the key makes it so, whenever a chat turns its alerts on.
    for (const sub of this.subs.networkChats()) this.#add(sub.chat_id, sub.thread_id, stall.key, 0, head, texts.stall(stall, now));
  }
  /** The chats that got a notice, which its resolution now goes to; one still unsent is dropped instead. */
  #resolvable(key) {
    const out = [];
    for (const row of this.ledger.notices(key)) {
      if (row.state === 'pending') this.ledger.dropped(row.seq);
      else if (row.state === 'sent' || row.state === 'summarized') out.push(row);
    }
    return out;
  }
  #add(chatId, thread, key, index, head, body) {
    this.ledger.add({ chatId, thread, txHash: key, eventIndex: index, kind: KIND, block: head.block_number, chainTime: head.timestamp, body, digest: DIGEST });
  }
  /** The scanner jumped over blocks `from` to `to`: every chat it concerns gets one notice. Runs in the caller's transaction. */
  skipped(from, to, head) {
    log('warn', 'gap skipped', { from, to, blocks: to - from + 1 });
    for (const chat of this.subs.affectedChats()) this.#add(chat.chat_id, chat.thread_id, `gap:${from}:${to}`, 0, head, texts.gap(from, to, this.config.maxGap));
  }
  /** A reorg deeper than CAIRN_REORG_DEPTH: the operator is told, once per fork. Runs in the caller's transaction. */
  deepReorg(fork, head) {
    log('error', 'reorg deeper than CAIRN_REORG_DEPTH', { block: fork.from, rescanned_from: fork.ancestor + 1 });
    const chat = this.config.operatorChat;
    if (chat === null) return;
    this.subs.known(chat);
    this.#add(chat, null, `reorg:${fork.from}:${fork.hash}`, 0, head, texts.deep(fork, this.config.reorgDepth));
  }
}
