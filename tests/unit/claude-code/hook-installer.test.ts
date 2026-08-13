import { describe, it, expect } from "vitest";
import {
  injectGateHooks,
  removeGateHooks,
  buildManagedSettingsTemplate,
  getManagedSettingsPath,
} from "../../../src/claude-code/ticket/hook-installer.js";

const HOOK = "/home/dev/.revenium/hooks/ticket-gate.sh";

describe("injectGateHooks", () => {
  it("adds the hook to both UserPromptSubmit and SessionStart", () => {
    const result = injectGateHooks({}, HOOK);
    for (const event of ["UserPromptSubmit", "SessionStart"]) {
      const entries = result.hooks?.[event];
      expect(entries).toHaveLength(1);
      expect(entries?.[0].hooks[0]).toEqual({ type: "command", command: HOOK });
    }
  });

  it("is idempotent — returns the same reference when already installed", () => {
    const once = injectGateHooks({}, HOOK);
    const twice = injectGateHooks(once, HOOK);
    expect(twice).toBe(once);
  });

  it("preserves unrelated hooks and settings", () => {
    const settings = {
      model: "opus",
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command" as const, command: "/other/hook.sh" }] }],
        PreToolUse: [{ hooks: [{ type: "command" as const, command: "/pre.sh" }] }],
      },
    };
    const result = injectGateHooks(settings, HOOK);
    expect(result.model).toBe("opus");
    expect(result.hooks?.PreToolUse).toHaveLength(1);
    expect(result.hooks?.UserPromptSubmit).toHaveLength(2);
    expect(result.hooks?.SessionStart).toHaveLength(1);
  });

  it("fills in a missing SessionStart entry when only UserPromptSubmit exists", () => {
    const partial = {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command" as const, command: HOOK }] }],
      },
    };
    const result = injectGateHooks(partial, HOOK);
    expect(result).not.toBe(partial);
    expect(result.hooks?.UserPromptSubmit).toHaveLength(1);
    expect(result.hooks?.SessionStart).toHaveLength(1);
  });
});

describe("removeGateHooks", () => {
  it("preserves unrelated hooks sharing an entry with the ticket gate", () => {
    const otherHook = { type: "command" as const, command: "/other/hook.sh" };
    const settings = {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [{ type: "command" as const, command: HOOK }, otherHook],
          },
        ],
        SessionStart: [{ hooks: [{ type: "command" as const, command: HOOK }] }],
      },
    };

    const result = removeGateHooks(settings, HOOK);

    expect(result.hooks?.UserPromptSubmit).toEqual([{ hooks: [otherHook] }]);
    expect(result.hooks?.SessionStart).toEqual([]);
  });

  it("returns the same reference when the ticket gate is absent", () => {
    const settings = {
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command" as const, command: "/other/hook.sh" }] }],
      },
    };

    expect(removeGateHooks(settings, HOOK)).toBe(settings);
  });

  it("preserves malformed entries without a hooks array", () => {
    const malformedEntry = { matcher: "*" };
    const settings = {
      hooks: {
        UserPromptSubmit: [
          malformedEntry,
          { hooks: [{ type: "command" as const, command: HOOK }] },
        ],
      },
    } as unknown as Parameters<typeof removeGateHooks>[0];

    const result = removeGateHooks(settings, HOOK);

    expect(result.hooks?.UserPromptSubmit).toEqual([malformedEntry]);
  });
});

describe("buildManagedSettingsTemplate", () => {
  it("contains hook entries for both events and allowManagedHooksOnly:true", () => {
    const template = buildManagedSettingsTemplate(HOOK);
    expect(template.allowManagedHooksOnly).toBe(true);
    for (const event of ["UserPromptSubmit", "SessionStart"]) {
      const entries = template.hooks?.[event];
      expect(entries).toHaveLength(1);
      expect(entries?.[0].hooks[0].command).toBe(HOOK);
    }
  });

  it("contains nothing else (minimal template)", () => {
    const template = buildManagedSettingsTemplate(HOOK);
    expect(Object.keys(template).sort()).toEqual(["allowManagedHooksOnly", "hooks"]);
  });
});

describe("getManagedSettingsPath", () => {
  it("is an OS-level path, never under the home directory", () => {
    const p = getManagedSettingsPath();
    expect(p).not.toContain(".claude");
    expect(p.endsWith("managed-settings.json")).toBe(true);

    expect(p.startsWith("/") || /^[A-Z]:\\/.test(p)).toBe(true);
  });

  it("returns the macOS MDM path on darwin", () => {
    if (process.platform === "darwin") {
      expect(getManagedSettingsPath()).toBe(
        "/Library/Application Support/ClaudeCode/managed-settings.json",
      );
    }
  });
});
