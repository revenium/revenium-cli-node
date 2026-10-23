import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../src/gemini-cli/config/loader.js", () => ({
  loadConfig: vi.fn(),
  configExists: vi.fn().mockReturnValue(true),
}));

vi.mock("../../../src/_core/api/otlp-client.js", () => ({
  sendOtlpLogs: vi.fn().mockResolvedValue({
    id: "1",
    resourceType: "log",
    processedEvents: 1,
    created: "now",
  }),
}));

import { testCommand } from "../../../src/gemini-cli/commands/test.js";
import { loadConfig } from "../../../src/gemini-cli/config/loader.js";

const baseConfig = {
  apiKey: "hak_testkey123",
  endpoint: "https://api.revenium.ai",
  legacy: false,
};

let logged: string[];

describe("testCommand", () => {
  beforeEach(() => {
    logged = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.join(" "));
    });
    vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
    vi.mocked(loadConfig).mockResolvedValue(baseConfig);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("warns that a pre-change configuration carries the key as a resource attribute", async () => {
    vi.mocked(loadConfig).mockResolvedValue({ ...baseConfig, legacy: true });

    await testCommand();

    expect(logged.join("\n")).toContain("Configuration is outdated");
  });

  it("stays silent about outdated configuration once the key is a header", async () => {
    await testCommand();

    expect(logged.join("\n")).not.toContain("Configuration is outdated");
  });
});
