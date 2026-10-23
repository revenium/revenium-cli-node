import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { CursorConfig } from "../../../src/cursor/types.js";
import type { CopilotConfig } from "../../../src/copilot/types.js";
import type { SyncState } from "../../../src/cursor/types.js";

const CURSOR_CONFIG_PATH = "/tmp/.cursor/revenium/revenium.env";
const CURSOR_FISH_CONFIG_PATH = "/tmp/.cursor/revenium/revenium.fish";
const COPILOT_CONFIG_PATH = "/tmp/.github-copilot/revenium/revenium.env";

const CURSOR_CONFIG: CursorConfig = {
  cursorApiKey: "key_cursoradmin123",
  reveniumApiKey: "hak_tenant_abc123xyz",
  reveniumEndpoint: "https://api.revenium.ai",
  organizationName: "Acme",
  syncIntervalMs: 300000,
};

const COPILOT_CONFIG: CopilotConfig = {
  reveniumApiKey: "hak_tenant_abc123xyz",
  reveniumEndpoint: "https://api.revenium.ai",
  organizationName: "Acme",
  syncIntervalMs: 300000,
};

const EMPTY_STATE: SyncState = {
  lastSyncTimestamp: 0,
  lastSyncEventCount: 0,
  totalEventsSynced: 0,
  sentRecords: {},
};

const mocks = vi.hoisted(() => ({
  sendOtlpLogs: vi.fn(),
  sendOtlpTraces: vi.fn(),
  cursorFindUnknownConfigKeys: vi.fn(),
  copilotFindUnknownConfigKeys: vi.fn(),
  cursorLoadConfig: vi.fn(),
  copilotLoadConfig: vi.fn(),
  cursorTestConnectivity: vi.fn(),
  copilotCheckAccess: vi.fn(),
}));

vi.mock("../../../src/_core/api/otlp-client.js", () => ({
  sendOtlpLogs: mocks.sendOtlpLogs,
  sendOtlpTraces: mocks.sendOtlpTraces,
}));

vi.mock("../../../src/cursor/config/loader.js", () => ({
  configExists: () => true,
  getConfigPath: () => CURSOR_CONFIG_PATH,
  getFishConfigPath: () => CURSOR_FISH_CONFIG_PATH,
  loadConfig: mocks.cursorLoadConfig,
  findUnknownConfigKeys: mocks.cursorFindUnknownConfigKeys,
}));

vi.mock("../../../src/copilot/config/loader.js", () => ({
  configExists: () => true,
  getConfigPath: () => COPILOT_CONFIG_PATH,
  loadConfig: mocks.copilotLoadConfig,
  findUnknownConfigKeys: mocks.copilotFindUnknownConfigKeys,
}));

vi.mock("../../../src/cursor/core/cursor-client.js", () => ({
  testConnectivity: mocks.cursorTestConnectivity,
}));

vi.mock("../../../src/copilot/core/github-client.js", () => ({
  checkCopilotAccess: mocks.copilotCheckAccess,
}));

vi.mock("../../../src/cursor/core/sync/state-manager.js", () => ({
  loadState: async () => EMPTY_STATE,
}));

vi.mock("../../../src/copilot/core/sync/state-manager.js", () => ({
  loadState: async () => EMPTY_STATE,
}));

import { statusCommand as cursorStatusCommand } from "../../../src/cursor/commands/status.js";
import { testCommand as cursorTestCommand } from "../../../src/cursor/commands/test.js";
import { statusCommand as copilotStatusCommand } from "../../../src/copilot/commands/status.js";
import { testCommand as copilotTestCommand } from "../../../src/copilot/commands/test.js";

let output = "";

const commands: Array<{
  name: string;
  configPath: string;
  unknownKeys: typeof mocks.cursorFindUnknownConfigKeys;
  loadConfig: typeof mocks.cursorLoadConfig;
  run: () => Promise<void>;
}> = [
  {
    name: "revenium-cursor status",
    configPath: CURSOR_CONFIG_PATH,
    unknownKeys: mocks.cursorFindUnknownConfigKeys,
    loadConfig: mocks.cursorLoadConfig,
    run: cursorStatusCommand,
  },
  {
    name: "revenium-cursor test",
    configPath: CURSOR_CONFIG_PATH,
    unknownKeys: mocks.cursorFindUnknownConfigKeys,
    loadConfig: mocks.cursorLoadConfig,
    run: cursorTestCommand,
  },
  {
    name: "revenium-copilot status",
    configPath: COPILOT_CONFIG_PATH,
    unknownKeys: mocks.copilotFindUnknownConfigKeys,
    loadConfig: mocks.copilotLoadConfig,
    run: copilotStatusCommand,
  },
  {
    name: "revenium-copilot test",
    configPath: COPILOT_CONFIG_PATH,
    unknownKeys: mocks.copilotFindUnknownConfigKeys,
    loadConfig: mocks.copilotLoadConfig,
    run: copilotTestCommand,
  },
];

beforeEach(() => {
  output = "";
  vi.clearAllMocks();
  mocks.sendOtlpLogs.mockResolvedValue({
    id: "test-id",
    resourceType: "AI_COMPLETION",
    processedEvents: 1,
    created: "2026-10-10T00:00:00Z",
  });
  mocks.sendOtlpTraces.mockResolvedValue({
    id: "test-id",
    resourceType: "AI_COMPLETION",
    processedEvents: 1,
    created: "2026-10-10T00:00:00Z",
  });
  mocks.cursorTestConnectivity.mockResolvedValue(true);
  mocks.copilotCheckAccess.mockResolvedValue("connected");
  mocks.cursorFindUnknownConfigKeys.mockResolvedValue([]);
  mocks.copilotFindUnknownConfigKeys.mockResolvedValue([]);
  mocks.cursorLoadConfig.mockResolvedValue(CURSOR_CONFIG);
  mocks.copilotLoadConfig.mockResolvedValue(COPILOT_CONFIG);
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    output += args.join(" ") + "\n";
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a config key the CLI does not read is reported, not silently ignored", () => {
  for (const command of commands) {
    it(`${command.name} names the retired key and its replacement`, async () => {
      command.unknownKeys.mockResolvedValue(["REVENIUM_EMAIL"]);

      await command.run();

      expect(output).toContain("REVENIUM_EMAIL");
      expect(output).toContain("REVENIUM_SUBSCRIBER_EMAIL");
      expect(output).toContain(command.configPath);
    });

    it(`${command.name} stays quiet when every key is known`, async () => {
      await command.run();

      expect(output).not.toContain("Unrecognized settings");
    });
  }
});

describe("a mistyped required key is named, not hidden behind the parse error", () => {
  for (const command of commands) {
    it(`${command.name} reports the key before exiting`, async () => {
      command.unknownKeys.mockResolvedValue(["REVENIUM_APIKEY"]);
      command.loadConfig.mockResolvedValue(null);
      vi.spyOn(process, "exit").mockImplementation((() => {
        throw new Error("exit");
      }) as never);

      await expect(command.run()).rejects.toThrow("exit");

      expect(output).toContain("REVENIUM_APIKEY");
      expect(process.exit).toHaveBeenCalledWith(1);
    });
  }
});
