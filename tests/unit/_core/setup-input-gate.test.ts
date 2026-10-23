import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  enforceSetupFlags,
  enforceSetupInputs,
} from "../../../src/_core/config/setup-input-gate.js";
import { READ_KEY_REJECTION_MESSAGE } from "../../../src/_core/config/key-scope.js";

class ExitError extends Error {}

const METERING_KEY = "rev_mk_TENANT1_0123456789abcdef";

let errors: string[];

beforeEach(() => {
  errors = [];
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new ExitError("exit");
  }) as never);
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.join(" "));
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("enforceSetupInputs", () => {
  it("accepts an https endpoint", () => {
    expect(() =>
      enforceSetupInputs({ apiKey: METERING_KEY, endpoint: "https://api.revenium.ai" }),
    ).not.toThrow();
  });

  it("accepts a loopback endpoint over plain http", () => {
    expect(() =>
      enforceSetupInputs({ apiKey: METERING_KEY, endpoint: "http://127.0.0.1:4318" }),
    ).not.toThrow();
  });

  it("rejects an endpoint carrying embedded credentials", () => {
    expect(() =>
      enforceSetupInputs({ apiKey: METERING_KEY, endpoint: "https://user:pass@api.revenium.ai" }),
    ).toThrow(ExitError);

    expect(errors.join("\n")).toContain(
      "Endpoint must not contain embedded credentials (username:password)",
    );
  });

  it("rejects a malformed email", () => {
    expect(() =>
      enforceSetupInputs({
        apiKey: METERING_KEY,
        endpoint: "https://api.revenium.ai",
        email: "not-an-email",
      }),
    ).toThrow(ExitError);

    expect(errors.join("\n")).toContain("Invalid email format");
  });

  it("reports every failure in a single abort message", () => {
    expect(() =>
      enforceSetupInputs({
        apiKey: METERING_KEY,
        endpoint: "http://[::1]:18962",
        email: "not-an-email",
      }),
    ).toThrow(ExitError);

    const message = errors.join("\n");
    expect(message).toContain("Invalid email format");
    expect(message).toContain("Endpoint must use HTTPS (except for localhost)");
  });

  it("rejects a read key", () => {
    expect(() =>
      enforceSetupInputs({
        apiKey: "rev_rk_TENANT1_0123456789abcdef",
        endpoint: "https://api.revenium.ai",
      }),
    ).toThrow(ExitError);

    expect(errors.join("\n")).toContain(READ_KEY_REJECTION_MESSAGE);
  });

  it("rejects an organization name over the length limit", () => {
    expect(() =>
      enforceSetupInputs({
        apiKey: METERING_KEY,
        endpoint: "https://api.revenium.ai",
        organizationName: "a".repeat(256),
      }),
    ).toThrow(ExitError);

    expect(errors.join("\n")).toContain("Organization name is too long (max 255 characters)");
  });

  it("rejects a management endpoint that would carry the key over plain http", () => {
    expect(() =>
      enforceSetupInputs({
        apiKey: METERING_KEY,
        endpoint: "https://api.revenium.ai",
        managementEndpoint: "http://internal/profitstream",
      }),
    ).toThrow(ExitError);

    expect(errors.join("\n")).toContain("Endpoint must use HTTPS (except for localhost)");
  });

  it("does not print the write key warning once the inputs were refused", () => {
    vi.mocked(process.exit).mockImplementation((() => undefined) as never);
    const logged: string[] = [];
    vi.mocked(console.log).mockImplementation((...args: unknown[]) => {
      logged.push(args.join(" "));
    });

    enforceSetupInputs({
      apiKey: "rev_sk_TENANT1_0123456789abcdef",
      endpoint: "https://api.revenium.ai",
      email: "not-an-email",
    });

    expect(logged.join("\n")).not.toContain("full-access write key");
  });

  it("measures attribution names after trimming surrounding whitespace", () => {
    expect(() =>
      enforceSetupInputs({
        apiKey: METERING_KEY,
        endpoint: "https://api.revenium.ai",
        organizationName: `${"a".repeat(200)}${" ".repeat(60)}`,
        productName: `   ${"b".repeat(200)}   `,
      }),
    ).not.toThrow();
  });
});

describe("enforceSetupFlags", () => {
  it("rejects an invalid endpoint flag before an API key is known", () => {
    expect(() => enforceSetupFlags({ endpoint: "http://[::1]:18962" })).toThrow(ExitError);

    expect(errors.join("\n")).toContain("Endpoint must use HTTPS (except for localhost)");
  });

  it("accepts a run where no validated flag was supplied", () => {
    expect(() => enforceSetupFlags({})).not.toThrow();
  });
});
