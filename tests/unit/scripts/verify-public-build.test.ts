import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findInternalOnlyPaths } from "../../../scripts/verify-public-build.cjs";

describe("findInternalOnlyPaths", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "verify-public-build-test-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reports nothing for a clean tree with no docs/ or enterprise/ files", () => {
    expect(findInternalOnlyPaths(root, [])).toEqual([]);
  });

  it("reports nothing when the only docs/ files are in the public allowlist", () => {
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "readme.md"), "public doc");

    expect(findInternalOnlyPaths(root, ["docs/readme.md"])).toEqual([]);
  });

  it("reports a stray docs/ file that is not in the public allowlist", () => {
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "internal.md"), "internal doc");

    expect(findInternalOnlyPaths(root, [])).toContain("docs/internal.md");
  });

  it("reports a file under enterprise/", () => {
    mkdirSync(join(root, "enterprise"), { recursive: true });
    writeFileSync(join(root, "enterprise", "notes.md"), "enterprise doc");

    expect(findInternalOnlyPaths(root, [])).toContain("enterprise/notes.md");
  });

  it("reports a nested file under enterprise/, not just top-level files", () => {
    mkdirSync(join(root, "enterprise", "sub"), { recursive: true });
    writeFileSync(join(root, "enterprise", "sub", "a.md"), "nested enterprise doc");

    expect(findInternalOnlyPaths(root, [])).toContain("enterprise/sub/a.md");
  });

  it("exempts only the allowlisted docs/ file, not every stray doc in the same tree", () => {
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "readme.md"), "public doc");
    writeFileSync(join(root, "docs", "internal.md"), "internal doc");

    const result = findInternalOnlyPaths(root, ["docs/readme.md"]);

    expect(result).not.toContain("docs/readme.md");
    expect(result).toContain("docs/internal.md");
    expect(result).toHaveLength(1);
  });
});
