import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { isolatedTmpDir } = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  return { isolatedTmpDir: mkdtempSync(join(tmpdir(), "revenium-copilot-sync-")) };
});

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  tmpdir: () => isolatedTmpDir,
}));

vi.mock("../../../src/copilot/config/loader.js", () => ({
  configExists: vi.fn().mockReturnValue(false),
  loadConfig: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../../src/copilot/core/sync/scheduler.js", () => ({
  runSyncCycle: vi.fn(),
  SyncWatcher: vi.fn(),
}));

import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { syncCommand } from "../../../src/copilot/commands/sync.js";
import { configExists, loadConfig } from "../../../src/copilot/config/loader.js";
import { runSyncCycle, SyncWatcher } from "../../../src/copilot/core/sync/scheduler.js";
import { createBillingReport } from "../../../src/copilot/core/billing-match.js";
import { OrganizationUnreachableError } from "../../../src/copilot/core/github-client.js";
import { BILLING_PERMISSION_HINT, LOCK_FILE } from "../../../src/copilot/constants.js";
import type { BillingReport, CopilotConfig, SyncResult } from "../../../src/copilot/types.js";

describe("copilot syncCommand deprecation notice", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  function noticeLines() {
    return logSpy.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes("is deprecated and will be removed in 3.0.0"));
  }

  it("prints the notice once, before the missing-configuration guard", async () => {
    await expect(syncCommand()).rejects.toThrow("process.exit");

    const lines = noticeLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("revenium-copilot sync");
  });

  it("prints the notice once in watch mode", async () => {
    await expect(syncCommand({ watch: true })).rejects.toThrow("process.exit");

    expect(noticeLines()).toHaveLength(1);
  });
});

describe("copilot syncCommand exit status", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  const CONFIG = {
    reveniumApiKey: "revenium-key",
    reveniumEndpoint: "https://endpoint",
    githubToken: "github-token",
    githubOrg: "acme",
  } as CopilotConfig;

  function syncResult(overrides: Partial<SyncResult>): SyncResult {
    return {
      fetched: 2,
      sent: 0,
      duplicatesSkipped: 0,
      errors: 0,
      ...overrides,
    };
  }

  function removeLock() {
    try {
      unlinkSync(join(tmpdir(), LOCK_FILE));
    } catch {
      // the lock is absent unless a previous cycle crashed
    }
  }

  beforeEach(() => {
    removeLock();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);
    vi.mocked(configExists).mockReturnValue(true);
    vi.mocked(loadConfig).mockResolvedValue(CONFIG);
  });

  afterEach(() => {
    removeLock();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("exits non-zero and announces the retry when Revenium refused events", async () => {
    vi.mocked(runSyncCycle).mockResolvedValue({ result: syncResult({ errors: 2 }) });

    await expect(syncCommand()).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(logSpy.mock.calls.map(([line]) => String(line)).join("\n")).toContain(
      "Revenium did not accept 2 event(s)",
    );
  });

  it("exits zero when every event was accepted", async () => {
    vi.mocked(runSyncCycle).mockResolvedValue({ result: syncResult({ sent: 2 }) });

    await expect(syncCommand()).resolves.toBeUndefined();

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("exits non-zero and names the organization when the cycle cannot reach it", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(runSyncCycle).mockRejectedValue(
      new Error('GitHub organization "revenium-no-such-org" could not be reached with this token.'),
    );

    await expect(syncCommand()).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy.mock.calls.map(([line]) => String(line)).join("\n")).toContain(
      "revenium-no-such-org",
    );
  });

  it("exits non-zero and names the day whose billing could not be read", async () => {
    vi.mocked(runSyncCycle).mockImplementation(async (_config, _credential, options) => {
      options.billingReport.unavailable.push({
        day: "2026-06-04",
        reason: `GitHub API 403 Forbidden - denied ${BILLING_PERMISSION_HINT}`,
        withheldRecords: 3,
        zeroCostRecords: 0,
        unresolved: true,
      });
      return { result: syncResult({ sent: 1 }) };
    });

    await expect(syncCommand()).rejects.toThrow("process.exit");

    const text = logSpy.mock.calls.map(([line]) => String(line)).join("\n");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(text).toContain("Billing data unavailable");
    expect(text).toContain("2026-06-04");
    expect(text).toContain("403 Forbidden");
    expect(text).toContain("Administration (read-only)");
    expect(text).toContain("3 record(s) withheld");
    expect(text).toContain("The sync window is held at those days");
  });

  it("keeps a dry run successful when billing could not be read", async () => {
    vi.mocked(runSyncCycle).mockImplementation(async (_config, _credential, options) => {
      options.billingReport.unavailable.push({
        day: "2026-06-04",
        reason: "GitHub API 403 Forbidden",
        withheldRecords: 3,
        zeroCostRecords: 0,
        unresolved: true,
      });
      return { result: syncResult({ sent: 0 }) };
    });

    await expect(syncCommand({ dryRun: true })).resolves.toBeUndefined();

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("exits zero when the failed billing lookup withheld nothing", async () => {
    vi.mocked(runSyncCycle).mockImplementation(async (_config, _credential, options) => {
      options.billingReport.unavailable.push({
        day: "2026-06-04",
        reason: "GitHub API 403 Forbidden",
        withheldRecords: 0,
        zeroCostRecords: 0,
        unresolved: true,
      });
      return { result: syncResult({ sent: 2 }) };
    });

    await expect(syncCommand({ allowMissingBilling: true })).resolves.toBeUndefined();

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("passes --allow-missing-billing through to the sync cycle", async () => {
    vi.mocked(runSyncCycle).mockResolvedValue({ result: syncResult({ sent: 2 }) });

    await syncCommand({ allowMissingBilling: true });

    expect(vi.mocked(runSyncCycle).mock.calls[0][2]).toMatchObject({
      allowMissingBilling: true,
    });
  });

  describe("watch mode", () => {
    type CycleHandler = (result: SyncResult, billingReport: BillingReport) => void;
    type ErrorHandler = (error: Error, billingReport: BillingReport) => void;

    function startWatcher(): Promise<CycleHandler> {
      return new Promise((resolveHandler) => {
        vi.mocked(SyncWatcher).mockImplementation(function () {
          return {
            start: async (onCycle: CycleHandler) => {
              resolveHandler(onCycle);
            },
            stop: vi.fn(),
          };
        } as unknown as typeof SyncWatcher);
        void syncCommand({ watch: true });
      });
    }

    function startWatcherCapturingErrors(): Promise<{ onError: ErrorHandler; stop: () => void }> {
      return new Promise((resolveHandlers) => {
        vi.mocked(SyncWatcher).mockImplementation(function () {
          let release: (() => void) | null = null;
          const stopped = new Promise<void>((resolve) => {
            release = resolve;
          });
          const stop = vi.fn(() => release?.());

          return {
            start: async (_onCycle: CycleHandler, onError: ErrorHandler) => {
              resolveHandlers({ onError, stop });
              await stopped;
            },
            stop,
          };
        } as unknown as typeof SyncWatcher);
        void syncCommand({ watch: true });
      });
    }

    function billingReport(withheldRecords: number): BillingReport {
      const report = createBillingReport();
      if (withheldRecords > 0) {
        report.unavailable.push({
          day: "2026-06-04",
          reason: "GitHub API 403 Forbidden",
          withheldRecords,
          zeroCostRecords: 0,
        });
      }
      return report;
    }

    async function shutdown(): Promise<void> {
      process.emit("SIGINT");
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalled());
    }

    beforeEach(() => {
      exitSpy.mockImplementation((() => undefined) as never);
    });

    afterEach(() => {
      process.removeAllListeners("SIGINT");
      process.removeAllListeners("SIGTERM");
    });

    it("exits non-zero when an earlier cycle withheld records and the last one was clean", async () => {
      const onCycle = await startWatcher();

      onCycle(syncResult({ sent: 1 }), billingReport(3));
      onCycle(syncResult({ sent: 1 }), billingReport(0));
      await shutdown();

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("exits zero when no cycle withheld records", async () => {
      const onCycle = await startWatcher();

      onCycle(syncResult({ sent: 1 }), billingReport(0));
      await shutdown();

      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it("stops the watcher and exits non-zero when the organization cannot be reached", async () => {
      const { onError, stop } = await startWatcherCapturingErrors();

      onError(new OrganizationUnreachableError("acme"), billingReport(0));

      expect(stop).toHaveBeenCalled();
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
    });
  });
});
