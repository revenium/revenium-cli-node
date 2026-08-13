import { describe, expect, it } from "vitest";
import {
  program,
  splitTicketLaunchArguments,
  toSetupOptions,
} from "../../../src/claude-code/cli/index.js";

describe("ticket launch CLI arguments", () => {
  it("does not absorb Claude arguments into the optional title", () => {
    const result = splitTicketLaunchArguments(
      ["Fix", "login", "-p", "prompt"],
      ["node", "cli.js", "ticket", "launch", "PRODUCT-1234", "Fix", "login", "--", "-p", "prompt"],
    );

    expect(result).toEqual({ title: "Fix login", claudeArgs: ["-p", "prompt"] });
  });

  it("leaves the title empty when every variadic token follows --", () => {
    const result = splitTicketLaunchArguments(
      ["-p", "prompt"],
      ["node", "cli.js", "ticket", "launch", "PRODUCT-1234", "--", "-p", "prompt"],
    );

    expect(result).toEqual({ title: undefined, claudeArgs: ["-p", "prompt"] });
  });

  it("preserves positional title support when no separator is present", () => {
    expect(splitTicketLaunchArguments(["Fix", "login"], ["node", "cli.js"])).toEqual({
      title: "Fix login",
      claudeArgs: [],
    });
  });
});

describe("setup CLI options", () => {
  it("maps scripted ticket-gate choices to SetupOptions", () => {
    expect(toSetupOptions({ installTicketGate: true }).installTicketGate).toBe(true);
    expect(toSetupOptions({ skipTicketGate: true }).skipTicketGate).toBe(true);
  });

  it("exposes mutually exclusive install and skip flags", () => {
    const setup = program.commands.find((command) => command.name() === "setup");
    const install = setup?.options.find((option) => option.long === "--install-ticket-gate");
    const skip = setup?.options.find((option) => option.long === "--skip-ticket-gate");

    expect(install?.conflictsWith).toContain("skipTicketGate");
    expect(skip?.conflictsWith).toContain("installTicketGate");
  });
});
