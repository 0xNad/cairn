// Exit codes and the errors that end a command. ARCHITECTURE.md fixes the codes:
//   0 done; 1 Telegram unreachable, the node unreachable (doctor only) or another instance (409);
//   2 a bad command line, environment, network file, chain or spec version; 3 Telegram rejected the token.

export const EXIT = Object.freeze({ OK: 0, UNREACHABLE: 1, CONFIG: 2, TOKEN: 3 });

// An error that ends the process with `exitCode`; its message is the reason printed on standard error.
export class Fatal extends Error {
  constructor(exitCode, message) {
    super(message);
    this.name = "Fatal";
    this.exitCode = exitCode;
  }
}
