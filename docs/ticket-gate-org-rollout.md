# Ticket Gate — Org-wide Rollout Guide

This guide explains how to enforce ticket attribution for all developers in your
organization using Claude Code's managed-settings mechanism.

## What the ticket gate does

The gate hook runs on two Claude Code events:

- **UserPromptSubmit** — blocks prompts until the session is attributed to a
  ticket (or explicitly opted out with `switch-ticket none --reason <reason>`). When the git
  branch contains a confident ticket match, the gate **auto-associates** and
  shows a one-line notice instead of blocking.
- **SessionStart** — silently reconciles state on resume/clear/startup so
  resumed sessions re-attribute immediately instead of waiting for the first
  prompt. Never blocks, never emits output.

Whenever the gate resolves a ticket for a session that hasn't been reported
yet, it fires a **detached background POST** to the session attribution API
(`/v2/api/sessions/{sessionId}/attribution`) with the real `session_id` from the hook's
stdin JSON — the only place that id exists (there is no session-id env var).
The prompt path itself is network-free: a metering outage never blocks a
developer.

## Dev workflow (single developer)

```bash
# Initial setup (once)
npm install -g @revenium/cli
revenium-metering setup

# Start a session attributed to a ticket
revenium-metering ticket launch PRODUCT-1234

# Switch tickets mid-session — type this AS YOUR NEXT PROMPT, in the
# terminal you want to switch (the gate hook receives that terminal's real
# session_id, so this is the only mechanism that can't mis-attribute a
# concurrent, co-located session). Plain text, no "!" or "/" prefix — "!" is
# Claude Code's shell-mode prefix and would run this as a shell command
# instead of reaching the hook:
switch-ticket BACK-42

# Opt out explicitly, in-session:
switch-ticket none --reason exploratory-spike

# Out-of-band `ticket switch` still works, but only when it can resolve a
# session id unambiguously (an explicit --session-id, or exactly one live
# session in this cwd) — otherwise it refuses to guess and just updates the
# repo-level hint for the next brand-new session.
revenium-metering ticket switch BACK-42
revenium-metering ticket switch none --reason "exploratory spike"

# Check what's active
revenium-metering ticket status
```

### Concurrent sessions in the same directory

If ≥2 Claude Code sessions share a working directory on different tickets,
each session's attribution is keyed to its own `session_id` and is never
affected by another session's state. Use the in-session `switch-ticket`
directive (above) to change a specific terminal's ticket — out-of-band
`ticket switch` will refuse to guess which session you meant.

If your branch is named after a ticket (e.g. `feature/PRODUCT-1234-foo` or
`product-1234-foo`), you usually don't need to run anything: the gate infers
the ticket and auto-associates on your first prompt. You can also just mention
the ticket in your first message (e.g. `fix BACK-42 ...`) and the gate
attributes the session to it.

## Gate configuration (env vars)

| Variable | Default | Behaviour |
|----------|---------|-----------|
| `REVENIUM_TICKET_BLOCK_POLICY` | `remind-only` | `remind-only` (default) shows a notice but lets the prompt through, leaving unattributed work in the general/unclassified bucket; `hard-block` blocks every prompt until attributed (stricter opt-in); an integer `N` allows the first N prompts then blocks |
| `REVENIUM_TICKET_AUTO_ASSOCIATE` | `true` | When `false`/`0`, branch inference only *suggests* the ticket in the block message instead of auto-associating |
| `REVENIUM_TICKET_REGEX` | `[A-Za-z][A-Za-z0-9_]{0,63}-[0-9]{1,10}` | Restrict valid ticket IDs, e.g. `(PRODUCT\|BACK)-[0-9]+`. Must be **POSIX ERE** (used by both the gate hook's `grep`/bash and the CLI) — do not use PCRE-only constructs like `\d`, `\w`, `(?:…)`, or lookarounds, as they silently diverge between launch-time and the gate. Surrounding `^`/`$` anchors are optional and stripped for substring extraction. |
| `REVENIUM_TEAM_ID` | unset | Optional in the target client contract. Against the current backend it is mandatory; configure it directly or via `--team-id` until the backend derives the organization from the metering key |
| `REVVIE_AUTONOMOUS` / `REVENIUM_AUTONOMOUS` | unset | Set to any value in CI/autonomous runners to bypass the gate |

### Fleet rollout prerequisite: backend organization derivation

The target client contract keeps `teamId` optional because the backend will
derive the organization from the metering key. Until that backend change is
deployed, every installation must provide the organization hashid through
`--team-id` or `REVENIUM_TEAM_ID`.
Omitting it against the current backend causes server attribution requests to
be rejected and the attribution is not recorded.

## Claude Code settings precedence

Highest to lowest:

1. **Managed settings** (OS-level, root/MDM-controlled)
2. CLI arguments
3. `<repo>/.claude/settings.local.json` (project-local, not committed)
4. `<repo>/.claude/settings.json` (project, committed)
5. `~/.claude/settings.json` (user-global)

Identical hook commands registered in multiple scopes are deduplicated by
Claude Code automatically.

## Org-wide enforcement

### Option A — per-developer install (recommended for gradual rollout)

Each developer runs:
```bash
revenium-metering setup          # installs hook into ~/.claude/settings.json
# or manually:
revenium-metering ticket-gate install
```

This registers the gate for both `UserPromptSubmit` and `SessionStart` in
the user-global scope. Developers can remove it (`ticket-gate uninstall`) —
suitable for opt-in phases, not enforcement.

### Option B — managed settings (enforced, cannot be overridden)

Managed settings live OUTSIDE the home directory and must be root/MDM-owned —
that is what makes enforcement real. A user-writable file cannot enforce
anything (`~/.claude/managed-settings.json` is not a real location).

| OS | Managed settings path |
|----|----------------------|
| macOS | `/Library/Application Support/ClaudeCode/managed-settings.json` |
| Linux | `/etc/claude-code/managed-settings.json` |
| Windows | `C:\ProgramData\ClaudeCode\managed-settings.json` |

Generate the template:

```bash
revenium-metering ticket-gate install-managed
# → writes ./managed-settings-template.json + prints the target path
```

Then deploy `managed-settings-template.json` to the OS path on every
developer machine via your MDM (Jamf, Kandji, Intune, …) or configuration
management, root-owned. For a quick single-machine test:

```bash
revenium-metering ticket-gate install-managed --write   # attempts direct write
# on EACCES it prints the exact sudo cp command to run
```

The template contains:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "<home>/.revenium/hooks/ticket-gate.sh" }] }
    ],
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "<home>/.revenium/hooks/ticket-gate.sh" }] }
    ]
  },
  "allowManagedHooksOnly": true
}
```

`allowManagedHooksOnly: true` means user/project hooks cannot override or
disable the gate. Note the hook script path is per-user (`~/.revenium/hooks/`);
for MDM fleets, deploy the script to a fixed shared path (e.g.
`/usr/local/lib/revenium/ticket-gate.sh`) and point the template there.

## Architecture notes

- **The gate is local-state fast**: it reads/writes
  `~/.revenium/ticket-state/` on every prompt; the attribution POST runs as a
  detached background process (`revenium-metering ticket-gate associate`,
  a hidden subcommand). No network on the prompt path.
- **Concurrency invariant**: attribution is keyed to the durable per-session
  identity (`session_id`, present on every hook call). Session state is
  authoritative and is NEVER overridden by another session or by repo
  state — a co-located session's state change can't move another session's
  attribution. Repo-level (cwd) state is a HINT only: written by deliberate
  declarations (`ticket launch` / a resolved `ticket switch`), and read only
  to seed a brand-new session that has no state of its own (e.g. a resumed
  session's first prompt). It carries no session pointer.
- **In-session switch (`switch-ticket <ID>`)**: the only concurrency-correct
  way to switch mid-session — typed as the prompt itself, so the hook
  receives THAT terminal's real `session_id` on stdin. Deliberately plain
  text with no `!`/`/` prefix: `!` is Claude Code's shell-mode prefix (the
  line would run as a shell command and never reach the hook), and `/` is
  reserved for slash commands. Swallowed via `decision:block` (the only
  `UserPromptSubmit` return shape that stops a prompt reaching the model;
  `systemMessage` alone does not — the original prompt still proceeds), with
  the block `reason` doubling as the confirmation shown to the user.
- **Out-of-band `ticket switch`**: resolves a session id only when
  unambiguous — an explicit `--session-id`, or exactly one live
  session-state file for the cwd (`listSessionStatesForCwd`, live = touched
  within the last 24h). Zero or ≥2 candidates → refuses to POST a guessed
  attribution; it persists the repo-level hint (for the next brand-new
  session) and prints a message pointing at the in-session directive or
  `--session-id`. Worst case is a no-op, never a mis-attribution.
- **Dedupe and retry**: each confirmed (session, ticket) pair POSTs once. An
  unconfirmed delivery is tracked in a separate ticket-scoped pending marker;
  retries never rewrite authoritative session state. Requests omit
  `effectiveFrom`, so a retry after a lost response is a server-side no-op for
  the still-current ticket, while a real A → B → A switch creates a new interval.
- **Fail-open**: config is read from `~/.claude/revenium.env` (a file —
  unaffected by Claude Code stripping `OTEL_*` env vars from hook
  subprocesses). Any POST failure leaves the prompt path available. Transient
  failures (network/timeout/408/409/425/429/5xx) retry on a later prompt;
  permanent 4xx responses stop retrying until the developer corrects the
  configuration and switches again. Launch-time OTel attributes remain the
  fallback for sessions started with `ticket launch`.
- **Hook output contract**: blocks use `{"decision":"block","reason":"..."}`
  (also used to swallow the in-session directive); user-visible notices use
  `{"systemMessage":"..."}` on exit 0 (original prompt still proceeds to the
  model). Plain non-JSON stdout is injected into the model's context, so the
  gate never emits it.
- **State hygiene**: the background worker opportunistically prunes state
  files older than 30 days.
- **Resume lineage gap**: Claude Code's `SessionStart` hook does not expose
  the prior session id on resume/compact — there is no programmatic way to
  map a resumed session back to its predecessor. The repo-state hint (above)
  is the fallback for this case; it's a best-effort cwd-based guess bounded
  to seeding a brand-new session only, never overriding an existing one.
