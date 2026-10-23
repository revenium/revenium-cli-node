import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

vi.mock("../../../src/codex-cli/config/loader.js", () => ({
  readReveniumEnv: vi.fn(),
  reveniumEnvExists: vi.fn(),
}));

import { spawn } from "node:child_process";
import { runCommand } from "../../../src/codex-cli/commands/run.js";
import { readReveniumEnv, reveniumEnvExists } from "../../../src/codex-cli/config/loader.js";

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
    vi.mocked(readReveniumEnv).mockResolvedValue({
      REVENIUM_ORGANIZATION_NAME: "Acme, Inc.",
      REVENIUM_PRODUCT_NAME: "R=D 100%",
    });
    vi.mocked(reveniumEnvExists).mockReturnValue(true);
    vi.mocked(spawn).mockReturnValue(child as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("injects the encoded attribution into the spawned Codex process", async () => {
    await runCommand(["--version"]);

    const [command, args] = vi.mocked(spawn).mock.calls[0];
    expect(command).toBe("codex");
    expect(args).toEqual(["--version"]);
    expect(spawnOptions().env?.OTEL_RESOURCE_ATTRIBUTES).toBe(
      "organization.name=Acme%2C Inc.,product.name=R%3DD 100%25",
    );
  });

  it("never writes the attribution into the parent environment", async () => {
    await runCommand([]);

    expect(process.env.OTEL_RESOURCE_ATTRIBUTES).toBeUndefined();
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

  it("still launches codex when the environment file is missing", async () => {
    vi.mocked(reveniumEnvExists).mockReturnValue(false);

    await runCommand(["--version"]);

    expect(spawn).toHaveBeenCalled();
    expect(spawnOptions().env?.OTEL_RESOURCE_ATTRIBUTES).toBeUndefined();
  });

  it("warns instead of attributing when the environment file is missing", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.join(" "));
    });
    vi.mocked(reveniumEnvExists).mockReturnValue(false);

    await runCommand([]);

    expect(errors.join("\n")).toContain("revenium-codex setup");
  });

  it("stays silent when a healthy setup configured no organization or product", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.join(" "));
    });
    vi.mocked(readReveniumEnv).mockResolvedValue({});

    await runCommand([]);

    expect(errors).toEqual([]);
    expect(spawnOptions().env?.OTEL_RESOURCE_ATTRIBUTES).toBeUndefined();
  });

  it("reads the attribution written beside a custom config path", async () => {
    await runCommand(["--version"], { configPath: "/custom/config.toml" });

    expect(readReveniumEnv).toHaveBeenCalledWith("/custom/config.toml");
    expect(reveniumEnvExists).toHaveBeenCalledWith("/custom/config.toml");
  });

  it("omits the configured email, which live sessions resolve from the signed-in identity", async () => {
    vi.mocked(readReveniumEnv).mockResolvedValue({
      REVENIUM_SUBSCRIBER_EMAIL: "dev@example.com",
      REVENIUM_ORGANIZATION_NAME: "Acme, Inc.",
    });

    await runCommand([]);

    expect(spawnOptions().env?.OTEL_RESOURCE_ATTRIBUTES).toBe("organization.name=Acme%2C Inc.");
  });

  it("reports an install hint when codex is absent from PATH", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.join(" "));
    });

    await runCommand([]);
    child.emit("error", Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }));

    expect(errors.join("\n")).toContain("npm install -g @openai/codex");
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
