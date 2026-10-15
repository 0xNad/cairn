import { CairnError } from './errors.mjs';

// One in-flight head read can serve multiple update batches. A slow read continues its normal
// retries after a command receives a busy reply; Telegram intake does not wait for node recovery.
export class HeadReader {
  constructor(rpc, signal, log, incompatible) {
    this.rpc = rpc;
    this.signal = signal;
    this.log = log;
    this.incompatible = incompatible;
    this.pending = null;
  }

  read() {
    if (!this.pending) {
      this.pending = this.rpc.head().catch((error) => {
        if (error instanceof CairnError && error.exitCode === 2) this.incompatible(error);
        else if (!this.signal.aborted) this.log('warn', 'node_busy', { origin: new URL(this.rpc.config.rpc).origin });
        return null;
      }).finally(() => { this.pending = null; });
    }
    return this.pending;
  }

  within(milliseconds) {
    this.signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const finish = (value, error) => {
        clearTimeout(timer);
        this.signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(value);
      };
      const abort = () => finish(null, this.signal.reason);
      const timer = setTimeout(() => finish(null), milliseconds);
      this.signal.addEventListener('abort', abort, { once: true });
      this.read().then((head) => finish(head), (error) => finish(null, error));
    });
  }
}
