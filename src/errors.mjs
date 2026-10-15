export class CairnError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

export class RpcError extends Error {
  constructor(code) {
    super('node returned an RPC error');
    this.code = code;
  }
}

export const busy = () => new CairnError('node busy; check the configured RPC endpoint');
