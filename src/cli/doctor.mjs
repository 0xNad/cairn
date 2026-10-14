// `node cairn.mjs doctor`: asks Telegram who the bot is and the node what it is, then prints one line
// {"bot":"<username>","chain":"SN_MAIN","block":<n>,"spec":"0.10.3"}. A node that does not answer is exit 1.
import { EXIT, ExitError } from "../errors.mjs";
import { NodeUnavailable } from "../rpc.mjs";
import { writeFd } from "../util.mjs";

export async function doctor(app) {
  const me = await app.tg.getMe();
  if (typeof me?.username !== "string") throw new ExitError(EXIT.UNREACHABLE, "Telegram's getMe answered without a bot username");
  try {
    await app.chain.verify(); // starknet_chainId and starknet_specVersion
    const block = await app.rpc.blockNumber();
    if (!Number.isSafeInteger(block) || block < 0) throw new NodeUnavailable("starknet_blockNumber did not answer a block number");
    writeFd(1, `${JSON.stringify({ bot: me.username, chain: app.config.chain, block, spec: app.chain.spec })}\n`);
    return 0;
  } catch (e) {
    if (e instanceof NodeUnavailable) throw new ExitError(EXIT.UNREACHABLE, `the Starknet node is unreachable (${e.message})`);
    throw e;
  }
}
