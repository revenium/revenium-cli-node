import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

vi.mock("../../../src/gemini-cli/config/loader.js", () => ({
  loadConfig: vi.fn(),
}));

import { spawn } from "node:child_process";
import { runCommand } from "../../../src/gemini-cli/commands/run.js";
import { loadConfig } from "../../../src/gemini-cli/config/loader.js";

const config = {
  apiKey: "hak_testkey123",
  endpoint: "https://api.revenium.ai",
  legacy: false,
};

class FakeChild extends EventEmitter {
  kill = vi.fn();
}

let child: FakeChild;

function spawnOptions() {
  return vi.mocked(spawn).mock.calls[0][2] as { env?: NodeJS.ProcessEnv; stdio?: string };
}

describe("runCommand", () => {
  beforeEach(() => {
    child = new FakeChild();
    vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.spyOn(process, "kill").mockImplementation((() => true) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(loadConfig).mockResolvedValue(config);
    vi.mocked(spawn).mockReturnValue(child as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("injects the API key header into the spawned Gemini process", async () => {
    await runCommand(["--version"]);

    const [command, args] = vi.mocked(spawn).mock.calls[0];
    expect(command).toBe("gemini");
    expect(args).toEqual(["--version"]);
    expect(spawnOptions().env?.OTEL_EXPORTER_OTLP_HEADERS).toBe("x-api-key=hak_testkey123");
  });

  it("keeps prompt logging off even when the parent shell exports it on", async () => {
    vi.stubEnv("GEMINI_TELEMETRY_LOG_PROMPTS", "true");

    await runCommand([]);

    expect(spawnOptions().env?.GEMINI_TELEMETRY_LOG_PROMPTS).toBe("false");
  });

  it("runs the child transparently on the inherited streams", async () => {
    await runCommand([]);

    expect(spawnOptions().stdio).toBe("inherit");
  });

  it("propagates the child exit status", async () => {
    await runCommand([]);
    child.emit("close", 42, null);

    expect(process.exit).toHaveBeenCalledWith(42);
  });

  it("re-raises the signal that killed the child instead of flattening it to 1", async () => {
    await runCommand([]);
    child.emit("close", null, "SIGINT");

    expect(process.kill).toHaveBeenCalledWith(process.pid, "SIGINT");
    expect(process.exit).not.toHaveBeenCalled();
  });

  it("forwards signals to the child while it runs", async () => {
    await runCommand([]);
    process.emit("SIGTERM");

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", 0, null);
  });

  it("leaves signals the terminal already delivers to the process group to the child", async () => {
    await runCommand([]);
    process.emit("SIGINT");

    expect(child.kill).not.toHaveBeenCalled();
    child.emit("close", 0, null);
  });

  it("still launches gemini when no configuration can be loaded", async () => {
    vi.mocked(loadConfig).mockResolvedValue(null);

    await runCommand(["--version"]);

    expect(spawn).toHaveBeenCalled();
    expect(spawnOptions().env?.OTEL_EXPORTER_OTLP_HEADERS).toBeUndefined();
  });

  it("reports an install hint when gemini is absent from PATH", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.join(" "));
    });

    await runCommand([]);
    child.emit("error", Object.assign(new Error("spawn gemini ENOENT"), { code: "ENOENT" }));

    expect(errors.join("\n")).toContain("npm install -g @google/gemini-cli");
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
