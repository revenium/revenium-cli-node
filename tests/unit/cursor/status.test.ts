import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../src/cursor/config/loader.js", () => ({
  configExists: () => true,
  getConfigPath: () => "/tmp/.cursor/revenium/revenium.env",
  findUnknownConfigKeys: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../../src/cursor/commands/migrated-config.js", () => ({
  loadMigratedConfig: vi.fn(),
}));

vi.mock("../../../src/cursor/core/cursor-client.js", () => ({
  testConnectivity: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../../src/cursor/core/sync/state-manager.js", () => ({
  loadState: vi.fn(),
}));

vi.mock("../../../src/_core/api/health-check.js", () => ({
  checkEndpointHealth: vi.fn().mockResolvedValue({ healthy: true, message: "ok", latencyMs: 1 }),
}));

import { statusCommand } from "../../../src/cursor/commands/status.js";
import { loadMigratedConfig } from "../../../src/cursor/commands/migrated-config.js";
import { loadState } from "../../../src/cursor/core/sync/state-manager.js";
import { maskApiKey } from "../../../src/_core/utils/masking.js";
import { createCursorConfig, createSyncState } from "../../helpers/fixtures.js";

const CONFIG = createCursorConfig();

let output = "";

describe("cursor statusCommand", () => {
  beforeEach(() => {
    output = "";
    vi.mocked(loadMigratedConfig).mockResolvedValue(CONFIG);
    vi.mocked(loadState).mockResolvedValue(createSyncState());
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      output += args.join(" ") + "\n";
    });
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
      output += chunk;
      return true;
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("never prints the full Cursor or Revenium key", async () => {
    await statusCommand();

    for (const key of [CONFIG.cursorApiKey, CONFIG.reveniumApiKey]) {
      expect(output).not.toContain(key);
      expect(output).toContain(maskApiKey(key));
    }
  });
});
