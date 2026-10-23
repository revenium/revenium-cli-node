import { describe, it, expect, afterEach, vi } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  generateTomlBlock,
  mergeTomlBlocks,
  generateEnvContent,
  writeCodexToml,
  writeReveniumEnv,
} from "../../../src/codex-cli/config/writer.js";
import type { CodexOtelConfig } from "../../../src/codex-cli/config/writer.js";
import { parseEnvContent } from "../../../src/_core/config/loader.js";
import { findOtelEntries } from "../../../src/codex-cli/config/otel-entries.js";
import { hasFeaturesRuntimeMetrics } from "../../../src/codex-cli/config/loader.js";

const minimalConfig: CodexOtelConfig = {
  apiKey: "hak_testkey123",
  endpoint: "https://api.revenium.ai",
};

const fullConfig: CodexOtelConfig = {
  apiKey: "hak_fullkey456",
  endpoint: "https://api.revenium.ai",
  email: "user@example.com",
  organizationName: "TestOrg",
  productName: "TestProduct",
};

describe("generateTomlBlock — struct-variant [otel] block", () => {
  it("emits inline otlp-http exporter config", () => {
    const output = generateTomlBlock(minimalConfig);
    expect(output).toContain("exporter = { otlp-http = {");
  });

  it("does not use flat dotted-key notation for otel fields", () => {
    const output = generateTomlBlock(minimalConfig);
    expect(output).not.toMatch(/^otel\.[a-z]/m);
  });

  it("includes the x-api-key in the headers sub-table", () => {
    const output = generateTomlBlock(minimalConfig);
    expect(output).toContain('headers = { "x-api-key" = "hak_testkey123" }');
  });

  it("appends /v1/logs to the endpoint", () => {
    const output = generateTomlBlock(minimalConfig);
    expect(output).toContain("https://api.revenium.ai/meter/v2/otlp/v1/logs");
  });

  it("keeps a gateway path prefix in the exporter endpoint", () => {
    const config: CodexOtelConfig = {
      apiKey: "hak_test",
      endpoint: "https://gw.example.com/revenium",
    };
    const output = generateTomlBlock(config);
    expect(output).toContain('endpoint = "https://gw.example.com/revenium/meter/v2/otlp/v1/logs"');
  });

  it("keeps a gateway path prefix when the stored endpoint already carries the OTLP suffix", () => {
    const config: CodexOtelConfig = {
      apiKey: "hak_test",
      endpoint: "https://gw.example.com/revenium/meter/v2/otlp/v1/logs",
    };
    const output = generateTomlBlock(config);
    expect(output).toContain('endpoint = "https://gw.example.com/revenium/meter/v2/otlp/v1/logs"');
  });

  it("does not double-append /v1/logs when already present", () => {
    const config: CodexOtelConfig = {
      apiKey: "hak_test",
      endpoint: "https://api.revenium.ai/meter/v2/otlp/v1/logs",
    };
    const output = generateTomlBlock(config);
    expect(output).not.toContain("/v1/logs/v1/logs");
  });

  it("does not double-append /meter/v2/otlp when already present without /v1/logs", () => {
    const config: CodexOtelConfig = {
      apiKey: "hak_test",
      endpoint: "https://api.revenium.ai/meter/v2/otlp",
    };
    const output = generateTomlBlock(config);
    expect(output).toContain("https://api.revenium.ai/meter/v2/otlp/v1/logs");
    expect(output).not.toContain("/meter/v2/otlp/meter/v2/otlp");
  });

  it("strips trailing slash from endpoint", () => {
    const config: CodexOtelConfig = { ...minimalConfig, endpoint: "https://api.revenium.ai/" };
    const output = generateTomlBlock(config);
    expect(output).toContain("https://api.revenium.ai/meter/v2/otlp/v1/logs");
    expect(output).not.toContain("revenium.ai//");
  });

  it("sets protocol to json", () => {
    const output = generateTomlBlock(minimalConfig);
    expect(output).toContain('protocol = "json"');
  });

  it("sets metrics_exporter to none", () => {
    const output = generateTomlBlock(minimalConfig);
    expect(output).toContain('metrics_exporter = "none"');
  });

  it("selects the otlp-http exporter", () => {
    const output = generateTomlBlock(minimalConfig);
    expect(output).toContain("otlp-http");
  });
});

describe("generateTomlBlock — [features] block", () => {
  it("contains the [features] table header", () => {
    const output = generateTomlBlock(minimalConfig);
    expect(output).toContain("[features]");
  });

  it("sets runtime_metrics = true", () => {
    const output = generateTomlBlock(minimalConfig);
    expect(output).toContain("runtime_metrics = true");
  });

  it("places [features] after [otel] sections", () => {
    const output = generateTomlBlock(minimalConfig);
    const otelIdx = output.indexOf("[otel]");
    const featuresIdx = output.indexOf("[features]");
    expect(featuresIdx).toBeGreaterThan(otelIdx);
  });
});

describe("generateTomlBlock — optional fields", () => {
  it("does not write email to TOML (resource-attrs path only)", () => {
    const output = generateTomlBlock(fullConfig);
    expect(output).not.toContain("user@example.com");
    expect(output).not.toContain("email");
  });

  it("does not write organization to TOML", () => {
    const output = generateTomlBlock(fullConfig);
    expect(output).not.toContain("TestOrg");
  });

  it("does not write product to TOML", () => {
    const output = generateTomlBlock(fullConfig);
    expect(output).not.toContain("TestProduct");
  });

  it("uses DEFAULT_REVENIUM_URL when endpoint is undefined", () => {
    const config: CodexOtelConfig = { apiKey: "hak_test" };
    const output = generateTomlBlock(config);
    expect(output).toContain("revenium.ai");
  });

  it("escapes newlines in inline TOML strings", () => {
    const output = generateTomlBlock({
      apiKey: "hak_test\nmalicious",
      endpoint: "https://api.revenium.ai",
    });
    expect(output).toContain("\\n");
    expect(output).not.toContain("hak_test\nmalicious");
  });
});

describe("mergeTomlBlocks — idempotency on re-run", () => {
  it("does not leave orphaned nested otel sub-tables on a second run", () => {
    const block = generateTomlBlock(minimalConfig);
    const firstRun = mergeTomlBlocks("", block);
    const secondRun = mergeTomlBlocks(firstRun, block);

    const exporterCount = (secondRun.match(/^\s*exporter\s*=\s*\{.*otlp-http.*$/gm) ?? []).length;
    expect(exporterCount).toBe(1);

    expect(secondRun).not.toContain("[otel.exporter.otlp-http]");
    expect(secondRun).not.toContain("[otel.exporter.otlp-http.headers]");
  });
});

describe("mergeTomlBlocks — legacy flat-key removal", () => {
  it("removes legacy flat otel.* dotted keys during migration", () => {
    const legacy = 'otel.endpoint = "https://old.example.com"\notel.api_key = "old_key"\n';
    const block = generateTomlBlock(minimalConfig);
    const result = mergeTomlBlocks(legacy, block);
    expect(result).not.toContain("otel.endpoint");
    expect(result).not.toContain("otel.api_key");
    expect(result).toContain("exporter = { otlp-http = {");
  });
});

describe("mergeTomlBlocks — feature flag preservation", () => {
  it("preserves unrelated feature flags while adding runtime_metrics", () => {
    const existing = "[features]\ncode_search = true\nsandbox = false\n";
    const block = generateTomlBlock(minimalConfig);
    const result = mergeTomlBlocks(existing, block);
    expect(result).toContain("code_search = true");
    expect(result).toContain("sandbox = false");
    expect(result).toContain("runtime_metrics = true");
  });

  it("removes only exact [otel] sections and preserves [otel_extra]", () => {
    const existing = "[otel_extra]\ncustom = true\n";
    const block = generateTomlBlock(minimalConfig);
    const result = mergeTomlBlocks(existing, block);
    expect(result).toContain("custom = true");
  });
});

describe("generateEnvContent — attribution data, never a shell export", () => {
  it("keeps the API key out of the file entirely", () => {
    const output = generateEnvContent(fullConfig);
    expect(output).not.toContain("REVENIUM_API_KEY=");
    expect(output).not.toContain("revenium.api_key");
    expect(output).not.toContain(fullConfig.apiKey);
  });

  it("never exports a variable into the shell that sources it", () => {
    expect(generateEnvContent(fullConfig)).not.toContain("export ");
  });

  it("stops a legacy `source` before it reaches any assignment", () => {
    const lines = generateEnvContent(fullConfig).split("\n");
    const guardIndex = lines.indexOf("return 0 2>/dev/null");

    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(lines.slice(0, guardIndex).every((line) => line.startsWith("#"))).toBe(true);
  });

  it("still carries the attribution live sessions and backfill depend on", () => {
    const keys = parseEnvContent(generateEnvContent(fullConfig));

    expect(keys.REVENIUM_SUBSCRIBER_EMAIL).toBe("user@example.com");
    expect(keys.REVENIUM_ORGANIZATION_NAME).toBe("TestOrg");
    expect(keys.REVENIUM_PRODUCT_NAME).toBe("TestProduct");
  });

  it("keeps a name with attribute delimiters verbatim, encoding it is `run`'s job", () => {
    const keys = parseEnvContent(
      generateEnvContent({
        ...fullConfig,
        organizationName: "Acme, Inc.",
        productName: "R=D 100%",
      }),
    );

    expect(keys.REVENIUM_ORGANIZATION_NAME).toBe("Acme, Inc.");
    expect(keys.REVENIUM_PRODUCT_NAME).toBe("R=D 100%");
  });

  it("writes no encoded copy of the names that could drift from the raw keys", () => {
    expect(generateEnvContent(fullConfig)).not.toContain("OTEL_RESOURCE_ATTRIBUTES");
  });
});

describe("generateTomlBlock — prompt and tool payload export", () => {
  it("turns Codex prompt logging off by default", () => {
    expect(generateTomlBlock(minimalConfig)).toContain("log_user_prompt = false");
  });

  it("keeps live export on by default", () => {
    expect(generateTomlBlock(minimalConfig)).toContain("exporter = { otlp-http = {");
  });

  it("disables the exporter when the developer opts out of tool details", () => {
    const output = generateTomlBlock({ ...minimalConfig, logToolDetails: false });

    expect(output).toContain('exporter = "none"');
    expect(output).not.toContain("otlp-http");
  });

  it("writes no API key when there is no exporter to authenticate", () => {
    const output = generateTomlBlock({ ...fullConfig, logToolDetails: false });

    expect(output).not.toContain(fullConfig.apiKey);
    expect(output).not.toContain("x-api-key");
  });

  it("keeps runtime metrics on so backfill still has local sessions to read", () => {
    expect(generateTomlBlock({ ...minimalConfig, logToolDetails: false })).toContain(
      "[features]\nruntime_metrics = true",
    );
  });

  it("stays idempotent across re-runs in opt-out mode", () => {
    const block = generateTomlBlock({ ...minimalConfig, logToolDetails: false });
    const merged = mergeTomlBlocks(mergeTomlBlocks("", block), block);

    expect(merged.match(/^\s*exporter\s*=/gm)).toHaveLength(1);
    expect(merged).not.toMatch(/^\[otel\.exporter/m);
  });
});

describe("generateEnvContent — credentials under the export opt-out", () => {
  const optOutConfig: CodexOtelConfig = { ...fullConfig, logToolDetails: false };

  it("keeps backfill usable by persisting the key the config.toml no longer holds", () => {
    const env = parseEnvContent(generateEnvContent(optOutConfig));

    expect(env.REVENIUM_API_KEY).toBe(fullConfig.apiKey);
    expect(env.REVENIUM_ENDPOINT).toBe("https://api.revenium.ai");
  });

  it("normalizes an endpoint given with an OTLP suffix", () => {
    const env = parseEnvContent(
      generateEnvContent({ ...optOutConfig, endpoint: "https://api.revenium.ai/meter/v2/otlp" }),
    );

    expect(env.REVENIUM_ENDPOINT).toBe("https://api.revenium.ai");
  });

  it("still refuses to export the key into the shell that sources it", () => {
    expect(generateEnvContent(optOutConfig)).not.toContain("export ");
  });
});

describe("mergeTomlBlocks — unrelated user content", () => {
  it("preserves an array-of-tables sitting between the sections it rewrites", () => {
    const existing = [
      "[otel]",
      'exporter = "none"',
      "",
      "[[mcp_servers]]",
      'name = "local"',
      "",
    ].join("\n");

    const result = mergeTomlBlocks(existing, generateTomlBlock(minimalConfig));

    expect(result).toContain('name = "local"');
    expect(result.indexOf("[[mcp_servers]]")).toBeLessThan(result.lastIndexOf("[otel]"));
  });

  it("does not swallow an array-of-tables that follows [features]", () => {
    const existing = [
      "[features]",
      "web_search = true",
      "",
      "[[mcp_servers]]",
      'name = "local"',
      'command = "serve"',
      "",
    ].join("\n");

    const result = mergeTomlBlocks(existing, generateTomlBlock(minimalConfig));

    expect(result).toContain('command = "serve"');
    expect(result).not.toMatch(/\[features\][\s\S]*\[\[mcp_servers\]\]/);
    expect(result).toContain("web_search = true");
  });
});

describe("writeCodexToml / writeReveniumEnv — file permissions", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  function createTempDir(): string {
    tempDir = mkdtempSync(join(tmpdir(), "codex-writer-"));
    return tempDir;
  }

  function fileMode(path: string): number {
    return statSync(path).mode & 0o777;
  }

  it("restricts a pre-existing config.toml and revenium.env to the owner", async () => {
    const dir = createTempDir();
    const configPath = join(dir, "config.toml");
    const envPath = join(dir, "revenium.env");
    const credentialConfig: CodexOtelConfig = { ...fullConfig, logToolDetails: false };
    writeFileSync(configPath, 'model = "gpt-5"\n');
    writeFileSync(envPath, "");
    chmodSync(configPath, 0o644);
    chmodSync(envPath, 0o644);

    expect(fileMode(configPath)).toBe(0o644);
    expect(fileMode(envPath)).toBe(0o644);

    await writeCodexToml(generateTomlBlock(credentialConfig), configPath);
    await writeReveniumEnv(credentialConfig, configPath);

    expect(fileMode(configPath)).toBe(0o600);
    expect(fileMode(envPath)).toBe(0o600);
    expect(readFileSync(configPath, "utf-8")).toContain('model = "gpt-5"');
    expect(readFileSync(envPath, "utf-8")).toContain("hak_fullkey456");
  });

  it("creates both files owner-only in an empty directory", async () => {
    const dir = createTempDir();
    const configPath = join(dir, "config.toml");

    await writeCodexToml(generateTomlBlock(minimalConfig), configPath);
    await writeReveniumEnv(minimalConfig, configPath);

    expect(fileMode(configPath)).toBe(0o600);
    expect(fileMode(join(dir, "revenium.env"))).toBe(0o600);
  });
});

describe("mergeTomlBlocks — removes exactly what findOtelEntries reports", () => {
  const CUSTOMER_ENDPOINT = "https://collector.customer.example";

  const layouts = {
    "nested exporter sub-table": `[otel.trace_exporter.otlp-http]\nendpoint = "${CUSTOMER_ENDPOINT}/v1/traces"\n`,
    "indented [otel] header": `  [otel]\nexporter = { otlp-http = { endpoint = "${CUSTOMER_ENDPOINT}" } }\n`,
    "root-level dotted key": `otel.exporter = { otlp-http = { endpoint = "${CUSTOMER_ENDPOINT}" } }\n`,
    "plain [otel] header": `[otel]\nendpoint = "${CUSTOMER_ENDPOINT}"\n`,
  };

  for (const [layout, existing] of Object.entries(layouts)) {
    it(`reports and removes the ${layout}`, () => {
      expect(findOtelEntries(existing).length).toBeGreaterThan(0);

      const result = mergeTomlBlocks(existing, generateTomlBlock(minimalConfig));

      expect(result).not.toContain(CUSTOMER_ENDPOINT);
    });
  }

  it("keeps an otel key owned by another table, which it never reported", () => {
    const existing = `[profiles.foo]\notel.endpoint = "${CUSTOMER_ENDPOINT}"\n`;

    expect(findOtelEntries(existing)).toEqual([]);

    const result = mergeTomlBlocks(existing, generateTomlBlock(minimalConfig));

    expect(result).toContain(`otel.endpoint = "${CUSTOMER_ENDPOINT}"`);
    expect(result).toContain("[profiles.foo]");
  });

  it("keeps a table whose header carries a trailing comment", () => {
    const existing = `[otel]\nexporter = "otlp-http"\n\n[mcp_servers.foo] # my server\ncommand = "node"\n\n[profiles.work]\nmodel = "o3"\n`;

    const result = mergeTomlBlocks(existing, generateTomlBlock(minimalConfig));

    expect(result).toContain("[mcp_servers.foo] # my server");
    expect(result).toContain(`command = "node"`);
    expect(result).toContain("[profiles.work]");
  });

  it("keeps runtime_metrics inside [features] when the next header carries a comment", () => {
    const existing = `[features]\nweb_search = true\n\n[mcp_servers.db] # prod\ncommand = "psql"\n`;

    const result = mergeTomlBlocks(existing, generateTomlBlock(minimalConfig));

    expect(hasFeaturesRuntimeMetrics(result)).toBe(true);
    expect(result).toContain("web_search = true");
    expect(result).toContain("[mcp_servers.db] # prod");
  });

  it("removes every line of a dotted otel key spanning several lines", () => {
    const existing = `otel.headers = [\n  "${CUSTOMER_ENDPOINT}",\n]\nmodel = "o3"\n`;

    const result = mergeTomlBlocks(existing, generateTomlBlock(minimalConfig));

    expect(result).not.toContain(CUSTOMER_ENDPOINT);
    expect(result.startsWith(`model = "o3"`)).toBe(true);
  });

  it("removes an otel table containing a multi-line array value", () => {
    const existing = `[otel]\nmatrix = [\n  [1, 2]\n]\nendpoint = "${CUSTOMER_ENDPOINT}"\n\n[profiles.work]\nmodel = "o3"\n`;

    const result = mergeTomlBlocks(existing, generateTomlBlock(minimalConfig));

    expect(result).not.toContain(CUSTOMER_ENDPOINT);
    expect(result).not.toContain("[1, 2]");
    expect(result).toContain("[profiles.work]");
  });

  it("removes a root otel assignment written as an inline table", () => {
    const existing = `otel = { exporter = { otlp-http = { endpoint = "${CUSTOMER_ENDPOINT}" } } }\nmodel = "o3"\n`;

    const result = mergeTomlBlocks(existing, generateTomlBlock(minimalConfig));

    expect(result).not.toContain(CUSTOMER_ENDPOINT);
    expect(result).toContain(`model = "o3"`);
    expect(result.match(/^\[otel\]$/gm)).toHaveLength(1);
  });

  it("keeps a table whose single quoted key merely contains a dot", () => {
    const existing = `["otel.exporter"]\nendpoint = "${CUSTOMER_ENDPOINT}"\n\n["features.custom"]\nenabled = true\n`;

    const result = mergeTomlBlocks(existing, generateTomlBlock(minimalConfig));

    expect(result).toContain(`["otel.exporter"]`);
    expect(result).toContain(CUSTOMER_ENDPOINT);
    expect(result).toContain(`["features.custom"]`);
    expect(result).toContain("enabled = true");
  });

  it("removes an otel table hidden behind a multi-line string with an unbalanced bracket", () => {
    const existing = `developer_instructions = """\nTicket ids look like [ABC-123\n"""\n\n[otel]\nendpoint = "${CUSTOMER_ENDPOINT}"\n`;

    const result = mergeTomlBlocks(existing, generateTomlBlock(minimalConfig));

    expect(result).not.toContain(CUSTOMER_ENDPOINT);
    expect(result).toContain("Ticket ids look like [ABC-123");
    expect(result.match(/^\[otel\]$/gm)).toHaveLength(1);
  });

  it("keeps a header that only looks like one because it sits inside a multi-line string", () => {
    const existing = `developer_instructions = """\n[otel]\nendpoint = "${CUSTOMER_ENDPOINT}"\n"""\n`;

    const result = mergeTomlBlocks(existing, generateTomlBlock(minimalConfig));

    expect(result).toContain(CUSTOMER_ENDPOINT);
    expect(result).toContain(`developer_instructions = """`);
  });

  it("keeps a comment that introduces the table following the removed otel block", () => {
    const existing = `[otel]\nendpoint = "${CUSTOMER_ENDPOINT}"\n\n# comment for the next table\n[model_options]\nreasoning = "high"\n`;

    const result = mergeTomlBlocks(existing, generateTomlBlock(minimalConfig));

    expect(result).toContain("# comment for the next table");
    expect(result).toContain("[model_options]");
  });
});

describe("writeCodexToml — backup of the previous config", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  function backupsIn(dir: string): string[] {
    return readdirSync(dir).filter((name) => name.startsWith("config.toml.revenium-backup-"));
  }

  it("preserves the overwritten config byte for byte, owner-only", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "codex-backup-"));
    const configPath = join(tempDir, "config.toml");
    const original =
      '[otel.trace_exporter.otlp-http]\nendpoint = "https://collector.customer.example/v1/traces"\n';
    writeFileSync(configPath, original);

    const { backupPath } = await writeCodexToml(generateTomlBlock(minimalConfig), configPath);

    expect(backupPath).not.toBeNull();
    expect(readFileSync(backupPath as string, "utf-8")).toBe(original);
    expect(statSync(backupPath as string).mode & 0o777).toBe(0o600);
  });

  it("reports no backup when there was no previous config", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "codex-backup-"));

    const { backupPath } = await writeCodexToml(
      generateTomlBlock(minimalConfig),
      join(tempDir, "config.toml"),
    );

    expect(backupPath).toBeNull();
  });

  it("retains only the five most recent backups", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "codex-backup-"));
    const configPath = join(tempDir, "config.toml");
    writeFileSync(configPath, '[otel]\nendpoint = "https://collector.customer.example"\n');
    for (let i = 1; i <= 6; i++) {
      writeFileSync(
        join(tempDir, `config.toml.revenium-backup-2026-01-0${i}T00-00-00-000Z`),
        "old",
      );
    }

    const { backupPath } = await writeCodexToml(generateTomlBlock(minimalConfig), configPath);

    const backups = backupsIn(tempDir);
    expect(backups).toHaveLength(5);
    expect(backups).toContain(basename(backupPath as string));
  });

  it("retains five backups even when the new one sorts before every existing backup", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "codex-backup-"));
    const configPath = join(tempDir, "config.toml");
    writeFileSync(configPath, '[otel]\nendpoint = "https://collector.customer.example"\n');
    for (let i = 1; i <= 5; i++) {
      writeFileSync(
        join(tempDir, `config.toml.revenium-backup-2099-01-0${i}T00-00-00-000Z`),
        "future",
      );
    }

    const { backupPath } = await writeCodexToml(generateTomlBlock(minimalConfig), configPath);

    const backups = backupsIn(tempDir);
    expect(backups).toHaveLength(5);
    expect(backups).toContain(basename(backupPath as string));
  });
});

describe("setup writes into CODEX_HOME when no --config-path is given", () => {
  let root: string | undefined;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it("creates config.toml with [otel] and revenium.env under CODEX_HOME, not under ~/.codex", async () => {
    root = mkdtempSync(join(tmpdir(), "codex-setup-"));
    const home = join(root, "home");
    const codexHome = join(root, "elsewhere");
    vi.stubEnv("HOME", home);
    vi.stubEnv("CODEX_HOME", codexHome);
    const credentialConfig: CodexOtelConfig = { ...fullConfig, logToolDetails: false };

    await writeCodexToml(generateTomlBlock(credentialConfig));
    await writeReveniumEnv(credentialConfig);

    expect(readFileSync(join(codexHome, "config.toml"), "utf-8")).toContain("[otel]");
    expect(readFileSync(join(codexHome, "revenium.env"), "utf-8")).toContain("hak_fullkey456");
    expect(existsSync(join(home, ".codex"))).toBe(false);
  });

  it("creates a missing CODEX_HOME private to the owner, since the API key lands inside it", async () => {
    root = mkdtempSync(join(tmpdir(), "codex-setup-"));
    const codexHome = join(root, "elsewhere");
    vi.stubEnv("CODEX_HOME", codexHome);

    await writeReveniumEnv({ ...fullConfig, logToolDetails: false });

    expect(statSync(codexHome).mode & 0o777).toBe(0o700);
  });
});
