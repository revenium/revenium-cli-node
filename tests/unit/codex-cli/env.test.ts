import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/codex-cli/config/loader.js", () => ({
  readReveniumEnv: vi.fn(),
  reveniumEnvExists: vi.fn(),
}));

import { buildCodexEnv, loadCodexAttribution } from "../../../src/codex-cli/config/env.js";
import { readReveniumEnv, reveniumEnvExists } from "../../../src/codex-cli/config/loader.js";
import { HOSTILE_SHELL_VALUES } from "../../helpers/shell-env.js";

const TICKET_CHARACTER_ENCODINGS: Array<[string, string]> = [
  [",", "%2C"],
  ["=", "%3D"],
  ["%", "%25"],
  ["$", "%24"],
  ["`", "%60"],
  ["\\", "%5C"],
  ['"', "%22"],
];

const ENCODED_SEQUENCE = /%[0-9A-F]{2}/g;
const CHARACTERS_THAT_MUST_NOT_TRAVEL_RAW = /[,="$`\\%]/;

describe("buildCodexEnv", () => {
  it("encodes the delimiters that would otherwise split the attribute list", () => {
    const attrs = buildCodexEnv({
      organizationName: "Acme, Inc.",
      productName: "R=D 100%",
    }).OTEL_RESOURCE_ATTRIBUTES;

    expect(attrs).toBe("organization.name=Acme%2C Inc.,product.name=R%3DD 100%25");
  });

  it.each(TICKET_CHARACTER_ENCODINGS)(
    "sends %s in an organization name as %s",
    (character, encoded) => {
      const attrs = buildCodexEnv({
        organizationName: `Acme ${character} Inc`,
      }).OTEL_RESOURCE_ATTRIBUTES;

      expect(attrs).toBe(`organization.name=Acme ${encoded} Inc`);
    },
  );

  it.each(HOSTILE_SHELL_VALUES)("leaves no raw delimiter in the product name %j", (productName) => {
    const value = buildCodexEnv({ productName }).OTEL_RESOURCE_ATTRIBUTES.replace(
      "product.name=",
      "",
    );

    expect(value.replace(ENCODED_SEQUENCE, "")).not.toMatch(CHARACTERS_THAT_MUST_NOT_TRAVEL_RAW);
  });

  it("leaves an inherited attribute value alone when there is nothing to attribute", () => {
    expect(buildCodexEnv({})).toEqual({});
  });
});

describe("loadCodexAttribution", () => {
  beforeEach(() => {
    vi.mocked(reveniumEnvExists).mockReturnValue(true);
    vi.mocked(readReveniumEnv).mockResolvedValue({
      REVENIUM_SUBSCRIBER_EMAIL: "dev@example.com",
      REVENIUM_ORGANIZATION_NAME: "Acme, Inc.",
      REVENIUM_PRODUCT_NAME: "R=D 100%",
    });
  });

  it("omits the configured email, which live sessions resolve from the signed-in identity", async () => {
    expect(await loadCodexAttribution()).toEqual({
      organizationName: "Acme, Inc.",
      productName: "R=D 100%",
    });
  });

  it("reports missing configuration only when the environment file is absent", async () => {
    vi.mocked(reveniumEnvExists).mockReturnValue(false);

    expect(await loadCodexAttribution()).toBeNull();
  });

  it("treats a setup that configured no attribution as healthy", async () => {
    vi.mocked(readReveniumEnv).mockResolvedValue({});

    expect(await loadCodexAttribution()).toEqual({
      organizationName: undefined,
      productName: undefined,
    });
  });
});
