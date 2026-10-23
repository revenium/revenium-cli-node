import { describe, expect, it } from "vitest";

import { program } from "../../../src/cursor/cli/index.js";

describe("cursor CLI end-date help", () => {
  function endDateDescription(commandName: string): string | undefined {
    return program.commands
      .find((command) => command.name() === commandName)
      ?.options.find((candidate) => candidate.long === "--to")?.description;
  }

  it("tells the reader a date-only backfill end date covers the whole day", () => {
    expect(endDateDescription("backfill")).toContain("whole day");
  });

  it("tells the reader a date-only sync end date covers the whole day", () => {
    expect(endDateDescription("sync")).toContain("whole day");
  });
});
