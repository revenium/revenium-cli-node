import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../src/cursor/config/loader.js", () => ({
  configExists: vi.fn().mockReturnValue(true),
  getConfigPath: vi.fn().mockReturnValue("/tmp/revenium-cursor/revenium.env"),
  findUnknownConfigKeys: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../../src/cursor/commands/migrated-config.js", () => ({
  loadMigratedConfig: vi.fn().mockResolvedValue(null),
}));

import { loadMigratedConfig } from "../../../src/cursor/commands/migrated-config.js";
import { statusCommand } from "../../../src/cursor/commands/status.js";
import { syncCommand } from "../../../src/cursor/commands/sync.js";
import { backfillCommand } from "../../../src/cursor/commands/backfill.js";
import { testCommand } from "../../../src/cursor/commands/test.js";

const COMMANDS: ReadonlyArray<[string, () => Promise<void>]> = [
  ["status", statusCommand],
  ["sync", () => syncCommand()],
  ["backfill", () => backfillCommand()],
  ["test", () => testCommand()],
];

describe("cursor commands read the admin key through the migrating loader", () => {
  beforeEach(() => {
    vi.mocked(loadMigratedConfig).mockClear();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(COMMANDS)(
    "%s migrates a configuration written under the old key name",
    async (_name, command) => {
      await expect(command()).rejects.toThrow("process.exit");

      expect(loadMigratedConfig).toHaveBeenCalled();
    },
  );
});
