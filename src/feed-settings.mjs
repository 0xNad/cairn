import { escapeHtml, parseDecimal } from './format.mjs';
export async function feedSetting(command, ctx) {
  const say = text => () => ({ lines: text.split('\n') });
  if (ctx.chat.type !== 'private' && !(await ctx.admin())) return say('Only a group administrator can change this feed.');
  if (command.name === 'unfeed') return () => ({ lines: [ctx.subs.unfeed(ctx.chat.id) ? 'Feed stopped. /feed starts a new one.' : 'No feed is set up here.'] });
  const contracts = ctx.config.contracts;
  if (!contracts.ekubo_core && !contracts.avnu_exchange) return say('Trade feeds unavailable: no venue contracts are configured for this network.');
  if (!ctx.head) return say('node busy: no feed was changed.');
  const args = command.argument.split(/\s+/).filter(Boolean);
  const target = args.shift();
  let mode = 'buys';
  if (['buys', 'all'].includes(args.at(-1))) mode = args.pop();
  if (!target || args.length > 1) return say('Usage: /feed &lt;SYMBOL|address&gt; [&lt;min&gt;|$&lt;usd&gt;] [buys|all]');
  const minimum = args[0] ?? '0', usd = minimum.startsWith('$');
  let resolved;
  try { resolved = await ctx.tokens.resolve(target, ctx.head.timestamp); }
  catch { return say('node busy: token lookup unavailable; no feed was changed.'); }
  if (resolved.error) return say(escapeHtml(resolved.error));
  const token = resolved.token;
  if (usd && (!token.verified || !token.pragma_pair || !contracts.pragma)) return say('USD floors unavailable: use a token minimum; USD needs a verified token with a configured Pragma pair.');
  const parsed = parseDecimal(usd ? minimum.slice(1) : minimum, usd ? 18 : token.decimals);
  if (parsed.error) return say(escapeHtml(parsed.error));
  return () => {
    ctx.subs.feed(ctx.chat, token.address, parsed.text, parsed.units, usd, mode, ctx.head.block_number, ctx.topic);
    return { lines: [`Feed set: ${ctx.fmt.token(token)} · ${mode === 'all' ? 'buys and sells' : 'buys only'} · minimum ${usd ? '$' : ''}${escapeHtml(parsed.text)}${usd ? '' : ' tokens'}.`,
      `From block ${ctx.head.block_number + 1}${ctx.topic ? ` · topic ${ctx.topic}` : ''}. /unfeed stops it. Group bursts become two posts and a summary.`,
      ...(usd ? ['USD floors use fresh prices only; trades wait for the next priceable transaction when the oracle is stale.'] : [])] };
  };
}
