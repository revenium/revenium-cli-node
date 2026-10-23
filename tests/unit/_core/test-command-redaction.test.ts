import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { OTLPLogsPayload } from "../../../src/_core/types/index.js";

const mocks = vi.hoisted(() => ({
  sendOtlpLogs: vi.fn(),
  claudeConfigExists: vi.fn(() => true),
  claudeLoadConfig: vi.fn(),
  cursorConfigExists: vi.fn(() => true),
  cursorLoadConfig: vi.fn(),
  cursorGetConfigPath: vi.fn(() => "/tmp/cursor/revenium.env"),
  cursorFindUnknownConfigKeys: vi.fn(async () => []),
  geminiConfigExists: vi.fn(() => true),
  geminiLoadConfig: vi.fn(),
}));

vi.mock("../../../src/_core/api/otlp-client.js", () => ({
  sendOtlpLogs: mocks.sendOtlpLogs,
}));

vi.mock("../../../src/claude-code/config/loader.js", () => ({
  configExists: mocks.claudeConfigExists,
  loadConfig: mocks.claudeLoadConfig,
}));

vi.mock("../../../src/cursor/config/loader.js", () => ({
  configExists: mocks.cursorConfigExists,
  loadConfig: mocks.cursorLoadConfig,
  getConfigPath: mocks.cursorGetConfigPath,
  getFishConfigPath: () => "/tmp/cursor/revenium.fish",
  findUnknownConfigKeys: mocks.cursorFindUnknownConfigKeys,
}));

vi.mock("../../../src/gemini-cli/config/loader.js", () => ({
  configExists: mocks.geminiConfigExists,
  loadConfig: mocks.geminiLoadConfig,
}));

import { testCommand as claudeTestCommand } from "../../../src/claude-code/commands/test.js";
import { testCommand as cursorTestCommand } from "../../../src/cursor/commands/test.js";
import { testCommand as geminiTestCommand } from "../../../src/gemini-cli/commands/test.js";

const OWN_KEY = "hak_ownkey_0123456789";
const SHELL_KEY = "hak_shellkey_0123456789";

let output = "";

function sentPayload(): OTLPLogsPayload {
  return mocks.sendOtlpLogs.mock.calls[0][2] as OTLPLogsPayload;
}

beforeEach(() => {
  output = "";
  vi.clearAllMocks();
  mocks.sendOtlpLogs.mockResolvedValue({
    id: "test-id",
    resourceType: "AI_COMPLETION",
    processedEvents: 1,
    created: "2026-10-10T00:00:00Z",
  });
  mocks.claudeConfigExists.mockReturnValue(true);
  mocks.cursorConfigExists.mockReturnValue(true);
  mocks.geminiConfigExists.mockReturnValue(true);
  mocks.claudeLoadConfig.mockResolvedValue({
    apiKey: OWN_KEY,
    endpoint: "https://api.revenium.ai",
    email: "user@example.com",
  });
  mocks.cursorLoadConfig.mockResolvedValue({
    reveniumApiKey: OWN_KEY,
    reveniumEndpoint: "https://api.revenium.ai",
    email: "user@example.com",
  });
  mocks.geminiLoadConfig.mockResolvedValue({
    apiKey: OWN_KEY,
    endpoint: "https://api.revenium.ai",
    email: "user@example.com",
    legacy: false,
  });

  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    output += args.join(" ") + "\n";
  });
  vi.spyOn(console, "error").mockImplementation(() => {});

  // A shell that still carries a key in the shared resource-attribute variable: the state every
  // install created before this change, and the one `test --verbose` used to print back.
  vi.stubEnv("OTEL_RESOURCE_ATTRIBUTES", `revenium.api_key=${SHELL_KEY},product.name=Prod`);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("test --verbose never exposes a Revenium API key", () => {
  const bins: Array<{ name: string; run: () => Promise<void> }> = [
    { name: "revenium-metering", run: () => claudeTestCommand({ verbose: true }) },
    { name: "revenium-cursor", run: () => cursorTestCommand({ verbose: true }) },
    { name: "revenium-gemini", run: () => geminiTestCommand({ verbose: true }) },
  ];

  for (const bin of bins) {
    it(`${bin.name} prints no key inherited from the shell`, async () => {
      await bin.run();

      expect(output).not.toContain(SHELL_KEY);
      expect(output).not.toContain(OWN_KEY);
      expect(output).toContain("product.name");
    });

    it(`${bin.name} prints no configured key reaching the payload`, async () => {
      vi.stubEnv("OTEL_RESOURCE_ATTRIBUTES", `deploy.token=${OWN_KEY},product.name=Prod`);

      await bin.run();

      expect(output).toContain("deploy.token");
      expect(output).not.toContain(OWN_KEY);
    });

    it(`${bin.name} sends a test record that carries no key`, async () => {
      await bin.run();

      const body = JSON.stringify(sentPayload());
      expect(body).not.toContain(SHELL_KEY);
      expect(body).not.toContain(OWN_KEY);
      expect(body).not.toContain("revenium.api_key");
    });
  }
});
