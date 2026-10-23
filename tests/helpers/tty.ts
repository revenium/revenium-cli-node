const originalStdinIsTTY = process.stdin.isTTY;
const originalStdoutIsTTY = process.stdout.isTTY;

function assign(stream: NodeJS.ReadStream | NodeJS.WriteStream, isTty: boolean): void {
  Object.defineProperty(stream, "isTTY", {
    value: isTty ? true : undefined,
    configurable: true,
  });
}

export function stubTty(stdinIsTty: boolean, stdoutIsTty: boolean = stdinIsTty): void {
  assign(process.stdin, stdinIsTty);
  assign(process.stdout, stdoutIsTty);
}

export function restoreTty(): void {
  Object.defineProperty(process.stdin, "isTTY", {
    value: originalStdinIsTTY,
    configurable: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    value: originalStdoutIsTTY,
    configurable: true,
  });
}
