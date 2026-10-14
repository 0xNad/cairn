export class CairnError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

export class NodeBusy extends CairnError {
  constructor() { super('Node busy. Check the RPC endpoint and try again.'); }
}

export class RpcError extends Error {
  constructor(code) {
    super('The node rejected this lookup.');
    this.code = code;
  }
}

export function stopped(signal) { signal.throwIfAborted(); }
