import { describe, it, expect } from "vitest";

const claudeCodeKey = process.env.CLAUDE_CODE_PROVIDER_KEY;
const geminiCliKey = process.env.GEMINI_CLI_PROVIDER_KEY;
const cursorKey = process.env.CURSOR_PROVIDER_KEY;

describe.skipIf(!claudeCodeKey)("claude-code provider e2e", () => {
  it("placeholder for real provider integration", () => {
    expect(claudeCodeKey).toBeDefined();
  });
});

describe.skipIf(!geminiCliKey)("gemini-cli provider e2e", () => {
  it("placeholder for real provider integration", () => {
    expect(geminiCliKey).toBeDefined();
  });
});

describe.skipIf(!cursorKey)("cursor provider e2e", () => {
  it("placeholder for real provider integration", () => {
    expect(cursorKey).toBeDefined();
  });
});
