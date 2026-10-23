import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

import { readFile } from "node:fs/promises";
import { loadConfig, findUnknownConfigKeys } from "../../../src/cursor/config/loader.js";
import { extractBaseEndpoint } from "../../../src/_core/config/loader.js";
import { ENV_KEYS } from "../../../src/cursor/constants.js";

const REVENIUM_CREDENTIAL = "REVENIUM_API_KEY=hak_tenant_abc123xyz";

const CREDENTIALS = ["REVENIUM_CURSOR_API_KEY=key_cursoradmin123", REVENIUM_CREDENTIAL];

describe("cursor loadConfig — Cursor admin key name", () => {
  beforeEach(() => {
    vi.mocked(readFile).mockReset();
  });

  it("reads the Revenium-prefixed name", async () => {
    vi.mocked(readFile).mockResolvedValue(CREDENTIALS.join("\n"));

    const config = await loadConfig();

    expect(config?.cursorApiKey).toBe("key_cursoradmin123");
  });

  it("falls back to the legacy name", async () => {
    vi.mocked(readFile).mockResolvedValue(
      ["CURSOR_API_KEY=key_legacy123", REVENIUM_CREDENTIAL].join("\n"),
    );

    const config = await loadConfig();

    expect(config?.cursorApiKey).toBe("key_legacy123");
  });

  it("prefers the Revenium-prefixed name when both are present", async () => {
    vi.mocked(readFile).mockResolvedValue(
      [...CREDENTIALS, "CURSOR_API_KEY=key_legacy123"].join("\n"),
    );

    const config = await loadConfig();

    expect(config?.cursorApiKey).toBe("key_cursoradmin123");
  });

  it("returns null when neither name is present", async () => {
    vi.mocked(readFile).mockResolvedValue(REVENIUM_CREDENTIAL);

    await expect(loadConfig()).resolves.toBeNull();
  });
});

describe("cursor loadConfig — endpoint normalization", () => {
  beforeEach(() => {
    vi.mocked(readFile).mockReset();
  });

  it("normalizes a stored endpoint that already carries the OTLP path, keeping the gateway prefix", async () => {
    vi.mocked(readFile).mockResolvedValue(
      [...CREDENTIALS, "REVENIUM_ENDPOINT=https://gw.example.com/revenium/meter/v2/otlp"].join(
        "\n",
      ),
    );

    const config = await loadConfig();

    expect(config?.reveniumEndpoint).toBe("https://gw.example.com/revenium");
  });

  it("keeps a plain gateway prefix untouched", async () => {
    vi.mocked(readFile).mockResolvedValue(
      [...CREDENTIALS, "REVENIUM_ENDPOINT=https://gw.example.com/revenium"].join("\n"),
    );

    const config = await loadConfig();

    expect(config?.reveniumEndpoint).toBe("https://gw.example.com/revenium");
  });

  it("loads back the exact base setup validated and saved", async () => {
    const saved = extractBaseEndpoint("https://gw.example.com/api/v1/logs/meter/v2/otlp/v1/logs");
    vi.mocked(readFile).mockResolvedValue(
      [...CREDENTIALS, `REVENIUM_ENDPOINT=${saved}`].join("\n"),
    );

    const config = await loadConfig();

    expect(config?.reveniumEndpoint).toBe("https://gw.example.com/api/v1/logs");
  });
});

describe("cursor findUnknownConfigKeys", () => {
  beforeEach(() => {
    vi.mocked(readFile).mockReset();
  });

  it("names a key written from the old README names", async () => {
    vi.mocked(readFile).mockResolvedValue(
      [...CREDENTIALS, "REVENIUM_EMAIL=developer@company.com"].join("\n"),
    );

    await expect(findUnknownConfigKeys()).resolves.toEqual(["REVENIUM_EMAIL"]);
  });

  it("names nothing for a file holding only the keys setup writes", async () => {
    vi.mocked(readFile).mockResolvedValue(
      Object.values(ENV_KEYS)
        .map((key) => `${key}=value`)
        .join("\n"),
    );

    await expect(findUnknownConfigKeys()).resolves.toEqual([]);
  });

  it("names nothing for a file still carrying the legacy Cursor key name", async () => {
    vi.mocked(readFile).mockResolvedValue(
      ["CURSOR_API_KEY=key_legacy123", REVENIUM_CREDENTIAL].join("\n"),
    );

    await expect(findUnknownConfigKeys()).resolves.toEqual([]);
  });

  it("returns an empty list when the config file cannot be read", async () => {
    vi.mocked(readFile).mockRejectedValue(new Error("ENOENT"));

    await expect(findUnknownConfigKeys()).resolves.toEqual([]);
  });
});
