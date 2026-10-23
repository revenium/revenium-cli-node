import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:https";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import { sendOtlpLogs } from "../../src/_core/api/otlp-client.js";
import { createTestPayload, generateTestSessionId } from "../../src/_core/api/health-check.js";
import { installEnvProxyDispatcher } from "../../src/_core/net/proxy.js";
import { generateTomlBlock } from "../../src/codex-cli/config/writer.js";
import { createOtlpCaptureServer, type OtlpCaptureServer } from "../helpers/otlp-capture-server.js";
import { createConnectProxy } from "../helpers/connect-proxy.js";
import {
  createSelfSignedCertificate,
  isOpensslAvailable,
  type SelfSignedCertificate,
} from "../helpers/self-signed-tls.js";

const apiKey = "hak_tenant_abc123xyz";
const UNBOUND_PROXY_PORT_BELOW_EPHEMERAL_RANGE = 20999;
const MANAGED_PROXY_ENV_VARS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
];

let originalDispatcher: Dispatcher;
let savedEnv: Record<string, string | undefined>;

function payload() {
  return createTestPayload(generateTestSessionId(), "proxy-and-tls-test");
}

async function captureFailureMessage(endpoint: string): Promise<string> {
  try {
    await sendOtlpLogs(endpoint, apiKey, payload());
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`expected sendOtlpLogs to ${endpoint} to reject`);
}

beforeAll(() => {
  originalDispatcher = getGlobalDispatcher();
});

afterAll(() => {
  setGlobalDispatcher(originalDispatcher);
});

beforeEach(() => {
  savedEnv = Object.fromEntries(MANAGED_PROXY_ENV_VARS.map((name) => [name, process.env[name]]));
  for (const name of MANAGED_PROXY_ENV_VARS) {
    delete process.env[name];
  }
});

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  setGlobalDispatcher(originalDispatcher);
});

describe("installEnvProxyDispatcher", () => {
  let capture: OtlpCaptureServer;

  beforeAll(async () => {
    capture = createOtlpCaptureServer();
    await capture.start();
  });

  afterAll(async () => {
    await capture.stop();
  });

  beforeEach(() => {
    capture.reset();
  });

  it("does nothing when no proxy variable is set", async () => {
    expect(await installEnvProxyDispatcher()).toBe(false);
    expect(getGlobalDispatcher()).toBe(originalDispatcher);

    await sendOtlpLogs(capture.baseUrl, apiKey, payload());
    expect(capture.requests).toHaveLength(1);
  });

  it("routes the request through the proxy and reports the proxy connection failure", async () => {
    process.env.HTTP_PROXY = `http://127.0.0.1:${UNBOUND_PROXY_PORT_BELOW_EPHEMERAL_RANGE}`;
    expect(await installEnvProxyDispatcher()).toBe(true);

    const message = await captureFailureMessage(capture.baseUrl);

    expect(message).toContain("ECONNREFUSED");
    expect(message).toContain("HTTPS_PROXY");
    expect(capture.requests).toHaveLength(0);
  });

  it("keeps the command running when the proxy variable has no scheme", async () => {
    process.env.HTTPS_PROXY = "user:s3cr3tpw@proxy.corp.example:8080";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await installEnvProxyDispatcher()).toBe(false);
    expect(getGlobalDispatcher()).toBe(originalDispatcher);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).not.toContain("s3cr3tpw");

    warn.mockRestore();
  });

  it("ignores a whitespace-only proxy variable", async () => {
    process.env.HTTPS_PROXY = "   ";
    expect(await installEnvProxyDispatcher()).toBe(false);
    expect(getGlobalDispatcher()).toBe(originalDispatcher);
  });

  it("sends the payload through a working proxy, which forwards it to the endpoint", async () => {
    const proxy = createConnectProxy();
    await proxy.start();

    try {
      process.env.HTTP_PROXY = proxy.url;
      expect(await installEnvProxyDispatcher()).toBe(true);

      await sendOtlpLogs(capture.baseUrl, apiKey, payload());

      expect(proxy.tunnelledAuthorities).toEqual([`127.0.0.1:${capture.port}`]);
      expect(capture.requests).toHaveLength(1);
    } finally {
      await proxy.stop();
    }
  });

  it("bypasses the proxy for hosts listed in NO_PROXY", async () => {
    process.env.HTTP_PROXY = `http://127.0.0.1:${UNBOUND_PROXY_PORT_BELOW_EPHEMERAL_RANGE}`;
    process.env.NO_PROXY = "127.0.0.1";
    expect(await installEnvProxyDispatcher()).toBe(true);

    await sendOtlpLogs(capture.baseUrl, apiKey, payload());

    expect(capture.requests).toHaveLength(1);
  });
});

const codexEntrypoint = resolve("dist/codex-cli/cli/index.js");

describe.skipIf(!existsSync(codexEntrypoint))("revenium-codex status start-up", () => {
  let capture: OtlpCaptureServer;
  let configDir: string;
  let configPath: string;

  function runStatus(proxyEnv: Record<string, string>): Promise<string> {
    return new Promise((resolveOutput, reject) => {
      const child = spawn(
        process.execPath,
        [codexEntrypoint, "status", "--config-path", configPath],
        { env: { ...process.env, NODE_ENV: "production", NODE_OPTIONS: "", ...proxyEnv } },
      );
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      child.on("error", reject);
      child.on("close", () => resolveOutput(output));
    });
  }

  beforeAll(async () => {
    capture = createOtlpCaptureServer();
    await capture.start();
    configDir = mkdtempSync(join(tmpdir(), "revenium-codex-status-"));
    configPath = join(configDir, "config.toml");
    writeFileSync(configPath, generateTomlBlock({ apiKey, endpoint: capture.baseUrl }));
  });

  afterAll(async () => {
    await capture.stop();
    rmSync(configDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    capture.reset();
  });

  it("reaches the endpoint directly when no proxy is configured", async () => {
    const output = await runStatus({});

    expect(output).toContain("Endpoint healthy");
    expect(capture.requests).toHaveLength(1);
  });

  it("sends the connection check through the proxy and names the refused connection", async () => {
    const output = await runStatus({
      HTTP_PROXY: `http://127.0.0.1:${UNBOUND_PROXY_PORT_BELOW_EPHEMERAL_RANGE}`,
    });

    expect(output).toContain("Connection check failed");
    expect(output).toContain("ECONNREFUSED");
    expect(output).toContain("HTTPS_PROXY");
    expect(capture.requests).toHaveLength(0);
  });
});

describe.skipIf(!isOpensslAvailable())("untrusted TLS certificate", () => {
  let certificate: SelfSignedCertificate;
  let server: Server;
  let baseUrl: string;
  let serverPort = 0;
  let receivedRequests = 0;

  beforeAll(async () => {
    certificate = createSelfSignedCertificate();
    server = createServer({ key: certificate.key, cert: certificate.cert }, (_req, res) => {
      receivedRequests += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "tls-1",
          resourceType: "logs",
          processedEvents: 1,
          created: new Date().toISOString(),
        }),
      );
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        serverPort = typeof address === "object" && address ? address.port : 0;
        baseUrl = `https://127.0.0.1:${serverPort}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    certificate.dispose();
  });

  it("names the certificate code and the CA hint instead of a bare fetch failed", async () => {
    const message = await captureFailureMessage(baseUrl);

    expect(message).toMatch(/SELF_SIGNED|UNABLE_TO_/);
    expect(message).toContain("NODE_EXTRA_CA_CERTS");
    expect(message).not.toBe("fetch failed");
  });

  it("succeeds when the certificate authority is supplied through NODE_EXTRA_CA_CERTS", async () => {
    const probe =
      "fetch(process.argv[1]).then((r) => process.exit(r.status === 200 ? 0 : 1)).catch(() => process.exit(2))";

    function probeExitCode(env: NodeJS.ProcessEnv): Promise<number | null> {
      const child = spawn(process.execPath, ["-e", probe, baseUrl], { stdio: "pipe", env });
      return new Promise((resolve) => child.on("close", resolve));
    }

    expect(await probeExitCode(process.env)).toBe(2);
    expect(await probeExitCode({ ...process.env, NODE_EXTRA_CA_CERTS: certificate.certPath })).toBe(
      0,
    );
  });

  it.skipIf(!existsSync(codexEntrypoint))(
    "tunnels an inspected HTTPS endpoint through the proxy named by HTTPS_PROXY",
    async () => {
      const proxy = createConnectProxy();
      await proxy.start();
      const configDir = mkdtempSync(join(tmpdir(), "revenium-codex-https-proxy-"));
      const configPath = join(configDir, "config.toml");
      writeFileSync(configPath, generateTomlBlock({ apiKey, endpoint: baseUrl }));
      receivedRequests = 0;

      try {
        const output = await new Promise<string>((resolveOutput, reject) => {
          const child = spawn(
            process.execPath,
            [codexEntrypoint, "status", "--config-path", configPath],
            {
              env: {
                ...process.env,
                NODE_ENV: "production",
                NODE_OPTIONS: "",
                HTTPS_PROXY: proxy.url,
                NODE_EXTRA_CA_CERTS: certificate.certPath,
              },
            },
          );
          let collected = "";
          child.stdout.on("data", (chunk) => (collected += chunk));
          child.stderr.on("data", (chunk) => (collected += chunk));
          child.on("error", reject);
          child.on("close", () => resolveOutput(collected));
        });

        expect(output).toContain("Endpoint healthy");
        expect(proxy.tunnelledAuthorities).toEqual([`127.0.0.1:${serverPort}`]);
        expect(receivedRequests).toBe(1);
      } finally {
        await proxy.stop();
        rmSync(configDir, { recursive: true, force: true });
      }
    },
  );
});
