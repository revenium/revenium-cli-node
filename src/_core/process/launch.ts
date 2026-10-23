import { spawn, type ChildProcess } from "node:child_process";
import chalk from "chalk";

const SIGNALS_THE_TERMINAL_ALREADY_DELIVERS_TO_THE_CHILD: NodeJS.Signals[] = [
  "SIGINT",
  "SIGQUIT",
  "SIGHUP",
];
const SIGNALS_FORWARDED_TO_THE_CHILD: NodeJS.Signals[] = ["SIGTERM"];

export interface ToolLaunch {
  binary: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  installHint: string;
}

function listenTo(
  signals: NodeJS.Signals[],
  handler: (signal: NodeJS.Signals) => void,
): () => void {
  const removers = signals.map((signal) => {
    const listener = () => handler(signal);
    process.on(signal, listener);
    return () => process.removeListener(signal, listener);
  });

  return () => removers.forEach((remove) => remove());
}

function relaySignalsTo(child: ChildProcess): () => void {
  const stopForwarding = listenTo(SIGNALS_FORWARDED_TO_THE_CHILD, (signal) => child.kill(signal));
  const stopIgnoring = listenTo(SIGNALS_THE_TERMINAL_ALREADY_DELIVERS_TO_THE_CHILD, () => {});

  return () => {
    stopForwarding();
    stopIgnoring();
  };
}

export function launchTool({ binary, args, env, installHint }: ToolLaunch): void {
  const child = spawn(binary, args, { env, stdio: "inherit" });
  const stopForwarding = relaySignalsTo(child);

  child.on("error", (error) => {
    stopForwarding();

    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(chalk.red(`Error: '${binary}' not found in PATH.`));
      console.error(chalk.dim(installHint));
    } else {
      console.error(chalk.red(`Error launching ${binary}: ${error.message}`));
    }

    process.exit(1);
  });

  child.on("close", (code, signal) => {
    stopForwarding();

    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exit(code ?? 0);
  });
}
