# Revenium CLI for Node.js

[![npm version](https://img.shields.io/npm/v/@revenium/cli.svg)](https://www.npmjs.com/package/@revenium/cli)
[![Node.js](https://img.shields.io/badge/Node.js-20.19%2B-green)](https://nodejs.org/)
[![Documentation](https://img.shields.io/badge/docs-revenium.io-blue)](https://docs.revenium.io)
[![Website](https://img.shields.io/badge/website-revenium.ai-blue)](https://www.revenium.ai)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Unified CLI tools for Claude Code, Gemini CLI, Cursor IDE, GitHub Copilot, and Codex metering**

A professional-grade set of CLI tools that configure automatic AI usage tracking for Claude Code, Gemini CLI, Cursor IDE, GitHub Copilot, and OpenAI Codex CLI. Features interactive setup wizards, OTLP telemetry, credentials scoped to the assistant process instead of the shell, Cursor/Copilot sync engines with SHA-256 deduplication, and historical backfill with batch processing.

## Where this CLI fits

**An organization-wide Claude Code rollout does not need this CLI.** Claude Code reads centrally-managed configuration: an administrator defines the telemetry settings once in the Claude admin console, or delivers them through MDM, and every authenticated user picks them up on next startup with nothing installed on their machine. That is the recommended path for customer rollouts. See [Setup Claude Code](https://docs.revenium.io/track-and-control-costs/analyze-ai-tooling-spend/setup-claude-code) in the Revenium documentation.

**Cursor and GitHub Copilot are dashboard integrations.** Both are organization-wide provider connections: add the credential once under Connections > Providers in the Revenium dashboard and Revenium syncs on its own.

This CLI covers what those paths do not:

- **Historical backfill** — importing past usage from local session files or a vendor API. Managed settings only ever meter from the moment they land, so backfill is CLI-only.
- **Fast individual onboarding** — a single developer metering themselves without waiting on an administrator, and testing an endpoint before a fleet rollout.

Claude Code telemetry carries `revenium.middleware.source`, so its deployment routes stay separable in Revenium reporting: a per-developer install from this CLI reports `revenium-cli`, and a centrally-managed deployment reports the channel the dashboard generated its settings block for. Records imported by `revenium-metering backfill` or `revenium-codex backfill` report `revenium-cli-backfill`, so a historical import is distinguishable from usage metered as it happened.

## Features

- **Five CLIs Unified** - Claude Code, Gemini CLI, Cursor IDE, GitHub Copilot, and Codex metering in one package
- **Interactive Setup Wizard** - Guided configuration that scopes credentials to the assistant that needs them
- **OTLP Telemetry** - Standard OpenTelemetry log format with retry logic and exponential backoff
- **Historical Backfill** - Import past usage data with batch processing, dry-run mode, and date filtering
- **Cursor Sync Engine** - Continuous sync with SHA-256 deduplication, state persistence, and process locking (deprecated, removed in `2.0.0`)
- **Shell Management** - Auto-detection (bash/zsh/fish) and profile modification with timestamped backups, used to install the Gemini CLI wrapper
- **Security** - PII masking, restricted file permissions (0o600), safe shell escaping
- **Programmatic API** - Validation, OTLP client, health checks, masking, and shell detection

## Architecture

```
@revenium/cli
|
|-- _core/                  Shared infrastructure across all CLIs
|   |-- api/
|   |   |-- otlp-client     OTLP HTTP client (retry, backoff, 30s timeout)
|   |   |-- retry-handler   Shared batch retry with exponential backoff
|   |   +-- health-check    Endpoint connectivity testing
|   |-- config/
|   |   |-- validator        API key, email, URL validation
|   |   +-- loader           Env file parsing, OTEL attribute decoding
|   |-- shell/
|   |   |-- detector         Shell type detection (bash/zsh/fish)
|   |   |-- escaping         Shell-safe value escaping per shell type
|   |   +-- profile-updater  Profile modification with backup/restore
|   |-- utils/
|   |   +-- masking          PII masking for API keys and emails
|   |-- types/               Core TypeScript interfaces
|   +-- constants            Shared defaults and paths
|
|-- claude-code/            Claude Code CLI (revenium-metering)
|   |-- cli/                 Commander entry point
|   |-- commands/            setup, status, test, backfill
|   |-- config/              ~/.claude/settings.json env writer + revenium.env data file
|   +-- constants            Env var names and resource-attribute keys
|
|-- gemini-cli/             Gemini CLI (revenium-gemini)
|   |-- cli/                 Commander entry point
|   |-- commands/            setup, status, test, run
|   |-- config/              ~/.gemini/revenium.env loader/writer + env builder
|   |-- shell/               gemini wrapper function installed in the shell profile
|   +-- constants            Gemini-specific env vars
|
|-- cursor/                 Cursor IDE CLI (revenium-cursor)
|   |-- cli/                 Commander entry point
|   |-- commands/            setup, status, test, sync, reset, backfill
|   |-- config/              ~/.cursor/revenium/revenium.env loader/writer
|   |-- core/
|   |   |-- cursor-client    Cursor Admin API client (pagination, 30-day chunking)
|   |   +-- sync/
|   |       |-- scheduler    Sync cycle orchestration and watch mode
|   |       |-- state-manager Persistent sync state (JSON)
|   |       +-- deduplicator SHA-256 hash-based event deduplication
|   +-- transform/
|       +-- otlp-mapper      Cursor events -> OTLP log records
|
|-- copilot/                GitHub Copilot CLI (revenium-copilot)
|   |-- cli/                 Commander entry point
|   |-- commands/            setup, status, test, sync, reset, backfill
|   |-- config/              ~/.github-copilot/revenium/ loader/writer
|   |-- core/
|   |   |-- github-client    GitHub Copilot Metrics API + Billing API client
|   |   |-- billing-match    Billing lines -> usage rows by normalized model name
|   |   +-- sync/
|   |       |-- scheduler    Sync cycle orchestration and watch mode
|   |       |-- state-manager Persistent sync state (JSON)
|   |       +-- deduplicator Natural key deduplication
|   +-- constants            Subscription tiers and env keys
|
+-- codex-cli/              OpenAI Codex CLI (revenium-codex)
    |-- cli/                 Commander entry point
    |-- commands/            setup, status, test, backfill, run
    |-- config/              ~/.codex/config.toml [otel] section + revenium.env attribution
    |-- shell/               codex wrapper function installed in the shell profile
    +-- constants            Codex-specific paths and defaults
```

### Data Flow

```
User runs CLI command
       |
       v
Interactive Setup (Inquirer prompts)
       |
       v
Validate inputs (API key prefix and scope, email RFC, URL protocol)
       |
       v
Test endpoint connectivity (OTLP health check with latency)
       |
       v
Write config to tool-specific location:
  - Claude Code:      ~/.claude/settings.json (env) + ~/.claude/revenium.env
  - Gemini CLI:       ~/.gemini/revenium.env
  - Cursor IDE:       ~/.cursor/revenium/revenium.env
  - GitHub Copilot:   ~/.github-copilot/revenium/revenium.env
  - Codex CLI:        ~/.codex/config.toml [otel] section
       |
       v
Scope the credentials to the assistant's own process
  - Claude Code reads them from the `env` block of ~/.claude/settings.json
  - Gemini CLI receives them from the `gemini` wrapper, per child process
  - Codex CLI reads its key from ~/.codex/config.toml, and receives organization
    and product from the `codex` wrapper, per child process
  - Any Revenium block left in a shell profile by an older release is removed
  - Creates timestamped backups before modifying any file, keeping the last 5
```

### Cursor Sync Flow

```
revenium-cursor sync [--watch]
       |
       v
Load sync state from ~/.cursor/revenium/state.json
       |
       v
Acquire process lock (prevent concurrent syncs)
       |
       v
Fetch events from Cursor Admin API
  - Async generator with pagination
  - 30-day chunking for API limits
  - Retry with exponential backoff
       |
       v
Deduplicate via SHA-256 hash (delivered records kept per UTC day)
       |
       v
Transform to OTLP log records (token counts, costs, billing)
       |
       v
Send to Revenium endpoint (retry on 5xx, 30s timeout)
       |
       v
Persist updated sync state (atomic write via temp file)
       |
       v (--watch mode)
Wait sync interval (default 5 min) -> repeat
```

### Copilot Sync Flow

```
revenium-copilot sync [--watch]
       |
       v
Load sync state from ~/.github-copilot/revenium/state.json
       |
       v
Acquire process lock (prevent concurrent syncs)
       |
       v
Fetch usage data from GitHub Copilot Metrics API
  - Per-user daily metrics via /copilot/metrics/reports/users-1-day
  - Two-step: download URLs then NDJSON reports
  - Enrich with billing cost from /settings/billing/ai_credit/usage
    matched to usage rows by normalized model name ("Claude Sonnet 4.6" = "claude-sonnet-4.6"),
    with billing lines that match no usage row imported as organization-level records
  - Code completion, Copilot CLI and Copilot app use are imported as their own records
    alongside the per-model chat records
  - Retry with exponential backoff
       |
       v
Deduplicate via natural key (day + user + language + model + editor + surface)
       |
       v
Transform to OTLP log records (suggestions, acceptances, active users, tokens)
       |
       v
Send to Revenium endpoint (retry on 5xx, 30s timeout)
       |
       v
Persist updated sync state (atomic write via temp file)
       |
       v (--watch mode)
Wait sync interval (default 5 min) -> repeat
```

## CLI Tools

| Binary              | Tool           | Commands                                                  |
| ------------------- | -------------- | --------------------------------------------------------- |
| `revenium-metering` | Claude Code    | `setup` `status` `test` `backfill`                  |
| `revenium-gemini`   | Gemini CLI     | `setup` `status` `test` `run`                             |
| `revenium-cursor`   | Cursor IDE     | `setup` `status` `test` `sync` `reset` `backfill`         |
| `revenium-copilot`  | GitHub Copilot | `setup` `status` `test` `sync` `reset` `backfill`         |
| `revenium-codex`    | OpenAI Codex   | `setup` `status` `test` `backfill`                        |

## Installation

```bash
npm install -g @revenium/cli
```

## Getting Started

### Configuration

Each tool keeps its own configuration file, written for you by its `setup` command — there is no
project `.env` to create, and the CLIs do not read one. Run the `setup` of the tool you want to
meter and answer the prompts:

```bash
revenium-metering setup   # Claude Code
revenium-gemini setup     # Gemini CLI
revenium-cursor setup     # Cursor IDE
revenium-copilot setup    # GitHub Copilot
revenium-codex setup      # OpenAI Codex CLI
```

You need a Revenium metering key (it starts with `rev_mk_`) before running any of them. A read key
(`rev_rk_`) is rejected because it cannot send metering data, and a write key (`rev_sk_`) is
accepted with a warning because it grants organization-wide access. The file
each wizard writes is listed under [Configuration File Locations](#configuration-file-locations),
and the keys it may contain under [Configuration File Keys](#configuration-file-keys).

Start with the Quick Start of your tool: [Claude Code](#quick-start---claude-code),
[Gemini CLI](#quick-start---gemini-cli), [Cursor IDE](#quick-start---cursor-ide),
[GitHub Copilot](#quick-start---github-copilot), [Codex CLI](#quick-start---codex-cli).

### Quick Start - Claude Code

```bash
revenium-metering setup
```

The setup wizard will prompt for your API key, email, and endpoint. It automatically:

1. Validates your API key format and scope (a metering key `rev_mk_` is the recommended key)
2. Tests connectivity to the Revenium endpoint
3. Writes the telemetry variables into the `env` block of `~/.claude/settings.json`, so only
   Claude Code sees them, and saves the same values as a data file at `~/.claude/revenium.env`
   for the other `revenium-metering` commands to read
4. Removes any Revenium block an older release left in your shell profiles

Start a new Claude Code session afterwards to pick up the settings.

After setup, verify with:

```bash
revenium-metering status    # Check configuration and connectivity
revenium-metering test      # Send a test metric to verify integration
```

### Quick Start - Gemini CLI

```bash
revenium-gemini setup
```

Writes `~/.gemini/revenium.env` and adds a `gemini` wrapper to your shell profile that launches
Gemini CLI through `revenium-gemini run`. Restart your terminal after setup so the wrapper is
picked up.

The API key travels as the `x-api-key` OTLP header and is injected into the Gemini process only —
it is never exported into your interactive shell.

The wrapper is a shell function, so it only applies to interactive shells. Scripts, Makefiles, CI
jobs, editor integrations and `command gemini` call the real binary directly and are not metered;
call `revenium-gemini run -- <args>` there instead.

```bash
revenium-gemini status
revenium-gemini test
```

### Quick Start - Cursor IDE

```bash
revenium-cursor setup
```

Requires both a Cursor Admin API key and a Revenium API key. Tests connectivity to both APIs during setup.

```bash
revenium-cursor status              # Check config, sync state, connectivity
revenium-cursor test                # Send test metric
revenium-cursor backfill --since 28d
```

`revenium-cursor sync` and `sync --watch` are deprecated and will be removed in `2.0.0`. Ongoing metering comes from the dashboard provider credential. `backfill`, `status`, `test` and `reset` are unaffected.

### Quick Start - GitHub Copilot

```bash
revenium-copilot setup
```

Configures the Revenium credentials the CLI needs. The GitHub credential itself is registered in the Revenium dashboard under Connections > Providers > GitHub Copilot — `setup` neither prompts for nor stores a GitHub PAT.

The dashboard credential requires a GitHub personal access token owned by an organization owner: fine-grained (recommended) with the organization permissions **Organization Copilot metrics** (read-only) and **Administration** (read-only), or classic with the `admin:org` and `manage_billing:copilot` scopes. The org must also have the "Copilot usage metrics" policy enabled (GitHub Org > Settings > Copilot > Policies).

CLI commands that read the GitHub API take the credential per invocation. Prefer the `GITHUB_TOKEN` / `GITHUB_ORG` environment variables: a token passed as `--github-token` is visible to other local users through the process list and is usually persisted in shell history and CI logs.

```bash
export GITHUB_TOKEN=ghp_...
export GITHUB_ORG=your-org

revenium-copilot status              # Check config, sync state, connectivity
revenium-copilot test                # Send test metric
revenium-copilot backfill --since 28d
```

The equivalent `--github-token` / `--github-org` flags remain available for environments that cannot set variables.

`revenium-copilot sync` and `sync --watch` are deprecated and will be removed in `2.0.0`. Ongoing metering comes from the dashboard provider credential.

### Quick Start - Codex CLI

```bash
revenium-codex setup
```

Writes OTLP configuration to the `[otel]` section of `~/.codex/config.toml`, the attribution values
to `~/.codex/revenium.env`, and adds a `codex` wrapper to your shell profile that launches Codex CLI
through `revenium-codex run`. Codex CLI natively exports telemetry using the `[otel]` config, and
the wrapper is what carries organization and product into the live session. Restart your terminal
after setup so the wrapper is picked up.

The wrapper is a shell function, so it only applies to interactive shells. Scripts, Makefiles, CI
jobs, editor integrations and `command codex` call the real binary directly and report no
organization or product; call `revenium-codex run -- <args>` there instead.

```bash
revenium-codex status                # Check otel config, wrapper and connectivity
revenium-codex test                  # Send test metric
revenium-codex backfill --since 7d   # Import historical sessions
```

Codex exports usage to Revenium as calls happen, so calls inside the backfill window that were already exported live are imported a second time. Set `--to` to the exact moment live export was configured, so the window ends before live data begins and those calls are not counted twice. A date-only `--to` covers that whole UTC day, including the calls exported live after setup.

## Command Reference

### Claude Code (`revenium-metering`)

#### `setup`

Interactive setup wizard for Claude Code metering.

| Option                  | Description                                                                |
| ----------------------- | -------------------------------------------------------------------------- |
| `--api-key <key>`       | Revenium API key (skips prompt)                                            |
| `--email <email>`       | Email for usage attribution                                                |
| `--endpoint <url>`      | Revenium API endpoint (default: `https://api.revenium.ai`)                 |
| `--organization <name>` | Organization name                                                          |
| `--product <name>`      | Product name                                                               |
| `--no-log-tool-details` | Write `OTEL_LOG_TOOL_DETAILS=0` instead of `1` (skill names stay redacted in live telemetry and are withheld from `backfill`) |

#### `status`

Displays current configuration (masked credentials), the telemetry variables Claude Code reads
from `~/.claude/settings.json` (including any your organization's managed settings override),
skill name attribution, and endpoint health with latency.

| Option  | Description                                                                             |
| ------- | --------------------------------------------------------------------------------------- |
| `--fix` | Re-apply the Revenium telemetry variables to `~/.claude/settings.json` (idempotent)     |

#### `test`

Sends a test OTLP metric and displays the response.

| Option      | Description                        |
| ----------- | ---------------------------------- |
| `--verbose` | Show full request/response details |

#### `backfill`

Imports historical usage data from Claude Code JSONL files (`$CLAUDE_CONFIG_DIR/projects/`, or `~/.claude/projects/` when `CLAUDE_CONFIG_DIR` is unset).

| Option                      | Description                                                                |
| --------------------------- | -------------------------------------------------------------------------- |
| `--since <date>`            | Import since date (ISO format or relative: `7d`, `1m`, `3m`)               |
| `--dry-run`                 | Preview records without sending                                            |
| `--batch-size <n>`          | Records per batch, max 100 (default: 10)                                   |
| `--delay <ms>`              | Minimum delay between batches in ms (default: 0)                           |
| `--verbose`                 | Show per-record details                                                    |
| `--project <paths>`         | Import only these projects, comma-separated (full path or its folder name) |
| `--exclude-project <paths>` | Skip these projects, comma-separated (full path or its folder name)        |

Every run, dry or not, lists each project it found with its record count, and marks the ones it is
leaving out, so the projects an import carries are visible before and after it is sent. A project is
the directory a session ran in, and naming one covers the subdirectories its sessions were started
from. Without `--project` or `--exclude-project` every project on the machine is imported, as
before. A value of either option that matches no project, or a folder name that more than one
project answers to, sends nothing and exits non-zero, and once either option is given, records whose
project could not be read are left out.

When `OTEL_LOG_TOOL_DETAILS=0` is in effect — set in `~/.claude/settings.json`, in your
organization's `managed-settings.json`, or in the Revenium configuration — the import withholds
skill names: no `skill.name` attribute and no skill activation events are sent, while every usage
record, with its token counts and cost, is still imported.

Cache writes are reported both as a flat total (`cache_creation_tokens`) and, when the session file
carries the breakdown, split by TTL into `cache_creation_1h_tokens` and `cache_creation_5m_tokens`.
The split is sent, not yet priced: Revenium stores it today and pricing 1-hour cache writes at their
own rate depends on a platform-side change that ships separately, so the TTL split on its own does
not change what an import costs. The other signals do: the `speed` of each call is reported the same
way, when present, and is already read by Revenium, and each call also carries its inference region
(`inference_geo`), its web-search count (`web_search_requests`, only when the call ran at least one
search) and, when the session file records it, the cost Claude Code itself computed for that call
(`cost_usd`). An imported call therefore prices like its live counterpart, which means fast-mode
calls, calls that ran web searches and calls with a recorded cost can import at a higher figure than
the same sessions imported by an earlier version.

Session files written by older Claude Code versions do not carry these fields and are imported
exactly as before. A record's `transaction_id` is unchanged by this release, so re-running a backfill
over sessions already imported by an earlier version sends no new spend — which also means records
already imported keep their flat cache-write total and gain no split; only calls imported from now
on carry one.

### Gemini CLI (`revenium-gemini`)

#### `setup`

Interactive setup wizard for Gemini CLI metering. Writes `~/.gemini/revenium.env` and installs the
`gemini` wrapper in your shell profile, removing any wrapper block left in the other shells'
profiles. The key is only accepted after Revenium confirms it processed a test event.

| Option                  | Description                                               |
| ----------------------- | --------------------------------------------------------- |
| `--api-key <key>`       | Revenium API key                                          |
| `--email <email>`       | Email for usage attribution                               |
| `--organization <name>` | Organization name                                         |
| `--product <name>`      | Product name                                              |
| `--endpoint <url>`      | Revenium API endpoint                                     |
| `--skip-shell-update`   | Skip installing the `gemini` wrapper in the shell profile |

The `gemini` wrapper is how the credentials reach the Gemini process. `revenium-codex setup`
installs its own `codex` wrapper, which is how organization and product reach a live Codex session,
and accepts the same `--skip-shell-update`.

#### `status`

Displays configuration, whether the `gemini` wrapper is installed, and endpoint health. Warns when
the configuration still carries the API key as a resource attribute and needs `setup` re-run.

#### `test`

Sends a test OTLP metric.

| Option      | Description                        |
| ----------- | ---------------------------------- |
| `--verbose` | Show full request/response details |

#### `run`

Launches `gemini` with the Revenium telemetry variables injected into that process only. Arguments
after `--` are forwarded verbatim, and the exit code is propagated. The shell wrapper installed by
`setup` calls this command, so running `gemini` normally is enough.

```bash
revenium-gemini run -- --version
```

### Cursor IDE (`revenium-cursor`)

#### `setup`

Interactive setup wizard requiring both Cursor Admin API and Revenium API keys.

| Option                       | Description                                         |
| ---------------------------- | --------------------------------------------------- |
| `--cursor-api-key <key>`     | Cursor admin API key                                |
| `--api-key <key>`            | Revenium API key                                    |
| `--email <email>`            | Email for usage attribution                         |
| `--organization <name>`      | Organization name                                   |
| `--product <name>`           | Product name                                        |
| `--endpoint <url>`           | Revenium API endpoint                               |
| `--subscription-tier <tier>` | Cursor tier: `pro`, `business`, `enterprise`, `api` |
| `--sync-interval <min>`      | Sync interval in minutes (default: 5)               |

#### `status`

Displays configuration, sync state (last sync time, event count), and connectivity to both Cursor and Revenium APIs.

#### `test`

Sends a test OTLP metric.

| Option      | Description                        |
| ----------- | ---------------------------------- |
| `--verbose` | Show full request/response details |

#### `sync` (deprecated)

Syncs Cursor usage events to Revenium. Deprecated and removed in `2.0.0`; register the Cursor credential under Connections > Providers in the Revenium dashboard instead.

| Option          | Description                         |
| --------------- | ----------------------------------- |
| `--watch`       | Run continuously with periodic sync |
| `--from <date>` | Sync from date (ISO format)         |
| `--to <date>`   | Sync to date (ISO format)           |

#### `reset`

Clears sync state for a fresh sync. Displays current state before resetting.

#### `backfill`

Imports historical Cursor usage data.

| Option               | Description                                                           |
| -------------------- | --------------------------------------------------------------------- |
| `--since <date>`     | Import since date                                                     |
| `--to <date>`        | Import until date                                                     |
| `--dry-run`          | Preview without sending                                               |
| `--batch-size <n>`   | Records per batch, max 100 (default: 10)                              |
| `--delay <ms>`       | Minimum delay between Revenium send batches in ms (default: 0)        |
| `--fetch-delay <ms>` | Minimum delay between Cursor API fetch requests in ms (default: 7500) |
| `--verbose`          | Show per-record details                                               |

Cursor's Admin API rate-limits `/teams/filtered-usage-events` to **60 requests per
minute per team**. By default `backfill` paces its fetches to ~8 requests/min (one
every 7.5s), well under that ceiling, so no flags are needed to avoid the rate
limiter. Override the pacing with `--fetch-delay <ms>` or the
`CURSOR_MIN_REQUEST_INTERVAL_MS` environment variable (e.g. `2000` for ~30 req/min
if you have headroom). `--fetch-delay 0` disables pacing entirely (not recommended).

Each fetch requests Cursor's documented maximum of 1000 usage events per page. Lower it
with the `CURSOR_PAGE_SIZE` shell environment variable (it is not read from the config
file): whole numbers above 1000 are clamped to 1000, and anything else — a decimal, a
thousands separator, exponent notation, zero or a negative — is rejected with a warning
and the maximum is used. Lower it if requests to Cursor time out on a large team. This is
the Cursor read page size and is independent of `--batch-size`, which sizes the Revenium
send batches.

If Cursor returns an empty page while still reporting that more pages exist, that time
window is read only in part and the run fails: `sync` leaves its watermark where it was and
retries the window on the next cycle, and `backfill` exits non-zero so the range can be
re-run. Events already read are still sent.

### GitHub Copilot (`revenium-copilot`)

#### `setup`

Interactive setup wizard for the Revenium credentials the CLI needs. It does not prompt for or store a GitHub PAT — register that under Connections > Providers > GitHub Copilot in the Revenium dashboard.

Copilot usage is attributed per developer from the GitHub login returned by the usage API, not from the email below.

| Option                       | Description                                          |
| ---------------------------- | ---------------------------------------------------- |
| `--api-key <key>`            | Revenium API key                                     |
| `--email <email>`            | Admin contact email (not used for attribution)       |
| `--organization <name>`      | Organization name                                    |
| `--product <name>`           | Product name                                         |
| `--endpoint <url>`           | Revenium API endpoint                                |
| `--subscription-tier <tier>` | Copilot tier: `individual`, `business`, `enterprise` |
| `--sync-interval <min>`      | Sync interval in minutes (default: 5)                |

#### `status`

Displays configuration, sync state, and connectivity to both GitHub and Revenium APIs.

#### `test`

Sends a test OTLP metric.

| Option      | Description                        |
| ----------- | ---------------------------------- |
| `--verbose` | Show full request/response details |

#### `sync`

Syncs per-user Copilot usage metrics and billing cost data to Revenium.

| Option                    | Description                                               |
| ------------------------- | --------------------------------------------------------- |
| `--watch`                 | Run continuously with configured interval                 |
| `--from <date>`           | Start date for sync range (YYYY-MM-DD)                    |
| `--to <date>`             | End date for sync range (YYYY-MM-DD)                      |
| `--dry-run`               | Output OTLP JSON without sending data                     |
| `--allow-missing-billing` | Import days whose billing could not be read, at zero cost |

Billing cost is matched to usage rows by normalized model name, so vendor spellings such as
`Claude Sonnet 4.6` and `Auto: Gemini 3 Pro` are priced against the `claude-sonnet-4.6` and
`gemini-3-pro` usage rows. Only the amount GitHub actually charges is imported: usage covered by
the plan's included credits carries no cost. Billing lines that match no usage row are printed
with GitHub's own spelling and their amount, and are imported as organization-level records with no
developer attribution, once, at the amount first seen for that day and model: a later revision of
that amount is not re-imported. When a day's billing data cannot be read, the day is named along
with the reason, its cost-bearing records are withheld instead of being imported at zero cost, the
sync window is held at the earliest withheld day so those days are fetched again on the next run,
and the command exits non-zero. A `--from` run is the exception: it never rewinds saved sync
progress, so a withheld day older than the stored watermark has to be re-imported by running
`sync --from <day>` again once the token can read billing, as the report then instructs. The usual
cause is a token missing the permissions listed under
[Quick Start - GitHub Copilot](#quick-start---github-copilot). For a token that will never be able
to read billing, `--allow-missing-billing` imports that usage at zero cost instead, and the run
neither holds the window nor exits non-zero. The report then names how many records of that day
were allowed through without billing data, so the zero cost they reach Revenium with is not read
as a measured zero.

#### `reset`

Clears sync state for a fresh sync.

#### `backfill`

Imports historical GitHub Copilot usage data (default lookback: 28 days).

| Option                    | Description                                               |
| ------------------------- | --------------------------------------------------------- |
| `--since <date>`          | Start date (ISO 8601 or relative: `7d`, `1m`)             |
| `--to <date>`             | End date (ISO 8601, defaults to now)                      |
| `--dry-run`               | Preview without sending                                   |
| `--allow-missing-billing` | Import days whose billing could not be read, at zero cost |
| `--batch-size <n>`        | Records per batch, max 100 (default: 10)                  |
| `--delay <ms>`            | Minimum delay between batches in ms (default: 0)          |
| `--verbose`               | Show detailed output                                      |

Billing cost is matched to usage rows as described under `sync`. Billing lines that match no usage
row are imported as organization-level records once, at the amount first seen; they are printed
after the summary, together with any day whose billing data could not be read, its reason and how
many records were withheld. A run that withheld records exits non-zero; re-run the backfill over
those days once the token can read billing, or pass `--allow-missing-billing` to import their usage
at zero cost; the report then names how many records of each such day were imported at zero cost,
so that zero is not read as a measured one. A backfill keeps no sync state, so it never holds a
window: the re-run is manual.

### OpenAI Codex CLI (`revenium-codex`)

#### `setup`

Interactive setup wizard for Codex CLI metering. Writes OTLP config to `$CODEX_HOME/config.toml` (`~/.codex/config.toml` when `CODEX_HOME` is unset).

| Option                  | Description                                                 |
| ----------------------- | ----------------------------------------------------------- |
| `--api-key <key>`       | Revenium API key                                            |
| `--email <email>`       | Email for usage attribution                                 |
| `--organization <name>` | Organization name                                           |
| `--product <name>`      | Product name                                                |
| `--endpoint <url>`      | Revenium API endpoint                                       |
| `--config-path <path>`  | Path to Codex config.toml (default: `$CODEX_HOME/config.toml`, else `~/.codex/config.toml`) |
| `--force`               | Overwrite existing `[otel]` config without prompting        |
| `--skip-shell-update`   | Skip installing the `codex` wrapper in the shell profile    |
| `--no-log-tool-details` | Disable live export; usage then comes from `backfill`        |

`setup` also installs the `codex` wrapper in the shell profile, removing any wrapper block left in
the other shells' profiles. Pass `--skip-shell-update` to leave the profile untouched.

#### `status`

Displays Codex OTLP configuration, whether the `codex` wrapper is installed, and endpoint health.

| Option                 | Description               |
| ---------------------- | ------------------------- |
| `--config-path <path>` | Path to Codex config.toml (default: `$CODEX_HOME/config.toml`, else `~/.codex/config.toml`) |

#### `test`

Sends a test OTLP metric.

| Option                 | Description                        |
| ---------------------- | ---------------------------------- |
| `--verbose`            | Show full request/response details |
| `--config-path <path>` | Path to Codex config.toml (default: `$CODEX_HOME/config.toml`, else `~/.codex/config.toml`) |

#### `backfill`

Imports historical Codex usage sessions from `$CODEX_HOME/sessions/` (`~/.codex/sessions/` when `CODEX_HOME` is unset).

Codex exports usage to Revenium as calls happen, and the import does not reconcile against what live export already sent: calls inside the window that were exported live are stored a second time. Narrow `--since` to the period before live export was configured. Re-running the same window is not a second count — every call is re-sent with the `transaction_id` it already had.

| Option                      | Description                              |
| --------------------------- | ---------------------------------------- |
| `--since <date>`            | Start date (ISO or relative: `7d`, `1m`) |
| `--to <date>`               | End date (ISO format, defaults to now)   |
| `--dry-run`                 | Preview without sending                  |
| `--batch-size <n>`          | Records per batch                        |
| `--verbose`                 | Show detailed output                     |
| `--sessions-path <path>`    | Path to Codex sessions root (default: `$CODEX_HOME/sessions`, else `~/.codex/sessions`) |
| `--config-path <path>`      | Path to Codex config.toml (default: `$CODEX_HOME/config.toml`, else `~/.codex/config.toml`) |
| `--project <paths>`         | Import only these projects, comma-separated (full path or its folder name)                  |
| `--exclude-project <paths>` | Skip these projects, comma-separated (full path or its folder name)                         |

A project here is the working directory a Codex session ran in, as recorded in its rollout file, and
naming one covers the subdirectories its sessions were started from. Every run, dry or not, lists
each project it found with its event count and marks the ones it is leaving out. Without
`--project` or `--exclude-project` every session is imported, as before. A value of either option
that matches no project, or a folder name that more than one project answers to, sends nothing and
exits non-zero, and once either option is given, sessions whose working directory could not be read
are left out.

#### `run`

Launches `codex` with the Revenium attribution injected into that process only. Every argument,
flags included, is forwarded verbatim to `codex`, and the exit code is propagated. The shell wrapper
installed by `setup` calls this command, so running `codex` normally is enough.

| Option                 | Description                                                 |
| ---------------------- | ----------------------------------------------------------- |
| `--config-path <path>` | Path to Codex config.toml (default: `$CODEX_HOME/config.toml`, else `~/.codex/config.toml`) |

When `setup` was given a `--config-path`, the installed wrapper passes the same path here, so live
sessions read the `revenium.env` written beside that config rather than the default one.

```bash
revenium-codex run -- --version
```

## Subscription Tiers

### Cursor

| Tier         | Plan                   | Cost Multiplier |
| ------------ | ---------------------- | --------------- |
| `pro`        | Pro ($20/mo)           | 0.04            |
| `business`   | Business ($40/seat/mo) | 0.08            |
| `enterprise` | Enterprise (custom)    | 0.05            |
| `api`        | API / Pay-as-you-go    | 1.00            |

### GitHub Copilot

| Tier         | Plan       | Price          |
| ------------ | ---------- | -------------- |
| `individual` | Individual | $10/month      |
| `business`   | Business   | $19/user/month |
| `enterprise` | Enterprise | $39/user/month |

## Configuration

### What leaves your machine

Metering needs token counts, not content. What each integration is technically capable of sending,
and the lever that stops it:

| CLI             | Prompt text                                      | Tool arguments                                    | Tool output                          | How to turn it off                                                                             |
| --------------- | ------------------------------------------------ | ------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Claude Code     | No                                               | Yes — tool inputs ride along with the tool name   | No — `setup` writes `OTEL_LOG_TOOL_CONTENT=0` | `setup --no-log-tool-details` writes `OTEL_LOG_TOOL_DETAILS=0`; skill names then stay redacted in live telemetry and are withheld from `backfill` |
| Gemini CLI      | Yes — `gemini_cli.api_request` carries `request_text` | Yes — `gemini_cli.tool_call` carries `function_args` | Yes — `gemini_cli.api_response` carries `response_text` | Partial: `setup` writes `GEMINI_TELEMETRY_LOG_PROMPTS=false`, which drops `user_prompt.prompt` and `gen_ai.input.messages` only; the events above have no switch, so the only full opt-out is turning Gemini telemetry off |
| Codex CLI       | No — `setup` writes `log_user_prompt = false`    | Yes — `codex.tool_result` carries `arguments`     | Yes — `codex.tool_result` carries `output` | `setup --no-log-tool-details` writes `exporter = "none"`; usage then comes from `backfill`     |
| Cursor          | No                                               | No                                                | No                                   | N/A — usage is pulled from Cursor's Admin API, nothing is read from your machine               |
| GitHub Copilot  | No                                               | No                                                | No                                   | N/A — usage is pulled from GitHub's org metrics API, nothing is read from your machine         |

`--no-log-tool-details` means different things on the two CLIs it exists on. On Claude Code it
redacts skill names in live telemetry and withholds them from `backfill`, and metering keeps
running. On Codex it turns live export off entirely.

Codex can truncate tool output through `[otel] tool_result = { max_bytes = N }`, but tool
**arguments** are emitted untruncated and have no field-level switch, so disabling the exporter is
the only way to keep them on the machine. With `--no-log-tool-details` no live events are exported
at all and no API key is written into `config.toml` — the key goes to `~/.codex/revenium.env`
(mode `0600`), where `revenium-codex backfill` and `revenium-codex test` read it. Token usage is
imported afterwards by `revenium-codex backfill`, which reads local rollout files and sends counts
only. Rollout files record completed calls, so failed and interrupted requests, time-to-first-token
and reasoning effort are not reproduced by the import.

Cursor and Copilot sync from org-level admin APIs, so an individual developer cannot disable
reporting from their own machine — whoever holds the admin key controls it.

### Configuration File Keys

These keys live inside the configuration file each `setup` writes, not in your shell. `status` and
`test` warn about any other key found in a Cursor or Copilot file, so a mistyped or retired name is
reported instead of silently ignored.

Common to the Cursor and Copilot files:

| Variable                     | Required | Description                                       |
| ---------------------------- | -------- | ------------------------------------------------- |
| `REVENIUM_API_KEY`           | Yes      | Revenium metering key (`rev_mk_` recommended)     |
| `REVENIUM_ENDPOINT`          | No       | API endpoint (default: `https://api.revenium.ai`) |
| `REVENIUM_SUBSCRIBER_EMAIL`  | No       | Email for usage attribution                       |
| `REVENIUM_ORGANIZATION_NAME` | No       | Organization name for cost attribution            |
| `REVENIUM_PRODUCT_NAME`      | No       | Product name for cost attribution                 |

Codex carries the same attribution keys in `~/.codex/revenium.env`, and they are the only definition
of its organization and product: `revenium-codex run` reads them from there and injects them into
the Codex process as `OTEL_RESOURCE_ATTRIBUTES`, which is never written to disk, and
`revenium-codex backfill` reads the same two keys. Codex takes its credentials from a different
place. After a normal `revenium-codex setup`, the API key and the endpoint live in the
`[otel]` section of `~/.codex/config.toml`, and that file wins — editing `REVENIUM_API_KEY` or
`REVENIUM_ENDPOINT` in `revenium.env` then has no effect. Those two keys are read from
`revenium.env` only when live export is off (`setup --no-log-tool-details`), which is also the only
case where `setup` writes them there. To change a key or endpoint after a normal setup, re-run
`revenium-codex setup` or edit `config.toml`.

Claude Code and Gemini CLI carry the same attribution values, but pass the API key and the endpoint
to the tool through its own telemetry variables (`OTEL_EXPORTER_OTLP_HEADERS` and the tool's OTLP
endpoint setting) rather than through `REVENIUM_API_KEY` and `REVENIUM_ENDPOINT`. Their `setup`
writes both for you.

Cursor-specific, in `~/.cursor/revenium/revenium.env`:

| Variable                    | Required     | Description                                               |
| --------------------------- | ------------ | --------------------------------------------------------- |
| `REVENIUM_CURSOR_API_KEY`   | Yes (Cursor) | Cursor admin API key                                      |
| `CURSOR_SUBSCRIPTION_TIER`  | No           | Subscription tier: `pro`, `business`, `enterprise`, `api` |
| `REVENIUM_SYNC_INTERVAL_MS` | No           | Sync interval in milliseconds (default: 300000)           |

Copilot-specific, in `~/.github-copilot/revenium/revenium.env`:

| Variable                    | Required | Description                                               |
| --------------------------- | -------- | --------------------------------------------------------- |
| `COPILOT_SUBSCRIPTION_TIER` | No       | Subscription tier: `individual`, `business`, `enterprise` |
| `REVENIUM_SYNC_INTERVAL_MS` | No       | Sync interval in milliseconds (default: 300000)           |

`GITHUB_TOKEN` and `GITHUB_ORG` are accepted in the Copilot file too, but the environment wins over
it — see the next table. Copilot usage is attributed by GitHub login, so
`REVENIUM_SUBSCRIBER_EMAIL` is recorded in the file and shown by `revenium-copilot status`, but is
not sent with Copilot usage.

### Environment Variables

These are read from the process environment, not from a configuration file.

| Variable                      | Purpose                                                                 |
| ----------------------------- | ----------------------------------------------------------------------- |
| `GITHUB_TOKEN`                | GitHub personal access token for Copilot `sync` / `backfill`, read per invocation |
| `GITHUB_ORG`                  | GitHub organization slug for Copilot `sync` / `backfill`                |
| `CLAUDE_CONFIG_DIR`           | Overrides the Claude Code configuration directory; the CLI follows it for `settings.json`, `status` and the transcripts read by `backfill` |
| `CODEX_HOME`                  | Overrides the Codex CLI home directory; the CLI follows it for `config.toml`, `revenium.env` and the sessions read by `backfill` |
| `REVENIUM_CONFIG_PATH`        | Overrides the path of the Claude Code CLI data file                     |
| `REVENIUM_MGMT_ENDPOINT`      | Overrides the management API base used for session attribution          |
| `REVENIUM_SUBSCRIBER_EMAIL`   | Fallback attribution email for the `setup` / `status` connectivity check and the `test` event, when the configuration carries none |
| `REVENIUM_MAX_RETRIES`        | Retry attempts per request (default: 3)                                 |
| `REVENIUM_REQUEST_TIMEOUT_MS` | Request timeout in milliseconds (default: 30000)                        |
| `REVENIUM_BACKOFF_BASE_MS`    | Base retry backoff in milliseconds (default: 1000)                      |
| `REVENIUM_BACKOFF_MAX_MS`     | Maximum retry backoff in milliseconds (default: 60000)                  |
| `REVENIUM_TARGET_TPS`         | Outbound records per second on batched sends (default: 25)              |
| `REVENIUM_STARTUP_STAGGER_MS` | Maximum random start-up delay in milliseconds (default: 5000)           |

For `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` and `NODE_EXTRA_CA_CERTS`, see
[Corporate networks](#corporate-networks-proxy-and-tls-inspection).

### Skill Name Attribution (`OTEL_LOG_TOOL_DETAILS`)

Claude Code redacts the skill name on its `skill_activated` telemetry event unless
`OTEL_LOG_TOOL_DETAILS=1` is set in the process environment. Without it, plugin skill usage arrives
at Revenium as `custom_skill` with no name, so per-skill cost attribution is not possible.

`setup` writes `OTEL_LOG_TOOL_DETAILS=1` into the `env` block of `~/.claude/settings.json` by
default. Configurations written before this flag existed do not have it. Run
`revenium-metering status --fix` to re-apply the settings, then start a new Claude Code session.

The opt-out covers imported history too. `backfill` reads the value Claude Code itself obeys —
`~/.claude/settings.json`, overridden by your organization's `managed-settings.json`, falling back
to the Revenium configuration — and with `OTEL_LOG_TOOL_DETAILS=0` it sends usage records without
any skill name and without skill activation events. If either settings file cannot be read, the
import withholds skill names and names the file it could not read.

Privacy: see [What leaves your machine](#what-leaves-your-machine).

### Configuration File Locations

| Tool           | Config Path                               | Permissions              |
| -------------- | ----------------------------------------- | ------------------------ |
| Claude Code    | `~/.claude/settings.json` (`env` block)   | 0o600 (owner read/write) |
| Claude Code    | `~/.claude/revenium.env` (CLI data file)  | 0o600 (owner read/write) |
| Gemini CLI     | `~/.gemini/revenium.env`                  | 0o600 (owner read/write) |
| Cursor IDE     | `~/.cursor/revenium/revenium.env`         | 0o600 (owner read/write) |
| Cursor State   | `~/.cursor/revenium/state.json`           | 0o600 (owner read/write) |
| GitHub Copilot | `~/.github-copilot/revenium/revenium.env` | 0o600 (owner read/write) |
| Copilot State  | `~/.github-copilot/revenium/state.json`   | 0o600 (owner read/write) |
| Codex CLI      | `~/.codex/config.toml` (`[otel]` section) | 0o600 (owner read/write) |
| Codex CLI      | `~/.codex/revenium.env` (backfill data)   | 0o600 (owner read/write) |

The paths above are the defaults. When `CODEX_HOME` is set, every Codex path — `config.toml`,
`revenium.env` and the `sessions` folder read by `backfill` — resolves under it instead of
`~/.codex`; `--config-path` and `--sessions-path` still win over it. When `CLAUDE_CONFIG_DIR` is
set, `settings.json` and the `projects` folder read by `backfill` resolve under it instead of
`~/.claude`. The Claude Code `revenium.env` is the exception: it stays at `~/.claude/revenium.env`
regardless of `CLAUDE_CONFIG_DIR`, and is relocated only by `REVENIUM_CONFIG_PATH`.

[`.env.example`](https://github.com/revenium/revenium-cli-node/blob/HEAD/.env.example) configures the scripts under `examples/`, which load it with `dotenv`. The installed CLIs do not read it.

### Corporate networks (proxy and TLS inspection)

On a network that forces outbound traffic through a proxy, or that re-signs TLS with an internal
certificate authority, the CLI reads the standard proxy and certificate environment variables.

| Variable              | Purpose                                                                 |
| --------------------- | ----------------------------------------------------------------------- |
| `HTTPS_PROXY`         | Proxy URL for outbound requests, e.g. `http://proxy.corp.example:8080`  |
| `HTTP_PROXY`          | Same, for plain-HTTP endpoints                                          |
| `NO_PROXY`            | Comma-separated hosts that must bypass the proxy, e.g. `localhost,.corp.example` |
| `NODE_EXTRA_CA_CERTS` | Path to the PEM file holding your internal CA, e.g. `/etc/ssl/corp-ca.pem` |

```bash
export HTTPS_PROXY=http://proxy.corp.example:8080
export NO_PROXY=localhost,127.0.0.1
export NODE_EXTRA_CA_CERTS=/etc/ssl/corp-ca.pem

revenium-codex status
```

The proxy variables are read when the CLI starts; setting none of them leaves the connection
behaviour unchanged. `NODE_EXTRA_CA_CERTS` is read by Node itself at process start-up, so it must
be exported in the shell before the command runs — setting it afterwards has no effect on a
process that is already running.

A proxy value that is not a full URL (`proxy.corp.example:8080` instead of
`http://proxy.corp.example:8080`) is reported as a one-line warning and ignored; the command still
runs without a proxy. `ALL_PROXY` on its own is honoured by tools such as curl but not by this CLI
— export `HTTPS_PROXY` and `HTTP_PROXY` explicitly.

When a connection fails, `status` and `test` now name the underlying cause (for example
`ECONNREFUSED` or `DEPTH_ZERO_SELF_SIGNED_CERT`) and suggest the variable to set, instead of
reporting a bare `fetch failed`.

These variables cover requests made by this CLI. Codex itself ships its own OTLP exporter with a
separate TLS stack that does not read `NODE_EXTRA_CA_CERTS`; if Codex's own exporter cannot reach
Revenium through TLS inspection, that trust store has to be configured on the Codex side.

## Programmatic API

The package exports utility functions and types for programmatic use:

```typescript
import {
  validateApiKey,
  validateEmail,
  validateEndpointUrl,
  sendOtlpLogs,
  installEnvProxyDispatcher,
  checkEndpointHealth,
  verifyApiKey,
  createTestPayload,
  generateTestSessionId,
  maskApiKey,
  maskEmail,
  detectShell,
  getProfilePath,
} from "@revenium/cli";
```

### Validation

| Function                   | Description                                                            |
| -------------------------- | ---------------------------------------------------------------------- |
| `validateApiKey(key)`      | Validate Revenium API key format, scope and minimum length             |
| `validateEmail(email)`     | Validate email address format (RFC-compliant)                          |
| `validateEndpointUrl(url)` | Validate endpoint URL format and protocol                              |

### OTLP Client

| Function                                  | Description                                                        |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `sendOtlpLogs(payload, endpoint, apiKey)` | Send OTLP log payload with retry (3 attempts, exponential backoff) |
| `installEnvProxyDispatcher()`             | Opt in to `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`; returns `false` when none is set or the value is unusable |

### Health Check

| Function                                | Description                                           |
| --------------------------------------- | ----------------------------------------------------- |
| `checkEndpointHealth(endpoint, apiKey)` | Test Revenium endpoint connectivity (returns latency) |
| `verifyApiKey(endpoint, apiKey)`        | Returns `false` when the endpoint rejects the key; throws when the endpoint cannot be reached |
| `createTestPayload()`                   | Create a test OTLP payload with metadata              |
| `generateTestSessionId()`               | Generate a unique test session ID                     |

### Shell Utilities

| Function                | Description                                                  |
| ----------------------- | ------------------------------------------------------------ |
| `detectShell()`         | Detect current shell type (`bash`, `zsh`, `fish`, `unknown`) |
| `getProfilePath(shell)` | Get shell profile file path for the detected shell           |
| `maskApiKey(key)`       | Mask API key for safe display (first 4 + last 4 chars)       |
| `maskEmail(email)`      | Mask email for safe display (first char + domain)            |

### Type Exports

```typescript
import type {
  ReveniumCliConfig,
  ValidationResult,
  HealthCheckResult,
  ShellType,
  ShellUpdateResult,
  OTLPValue,
  OTLPLogsPayload,
  OTLPResponse,
  ToolContext,
  ToolMetadata,
  ToolEventPayload,
  ToolCallReport,
} from "@revenium/cli";
```

## Troubleshooting

### Setup wizard fails

1. Verify your API key is a metering key starting with `rev_mk_` (a read key `rev_rk_` is rejected)
2. Check internet connectivity to `https://api.revenium.ai`
3. Run `status` command to verify existing configuration
4. Try passing options directly: `revenium-metering setup --api-key rev_mk_...`

Without a terminal (CI, scripts, piped input or output), `setup` never prompts: optional fields stay blank,
and a missing required option fails immediately naming the flag you need to pass.

### Claude Code settings not updated

1. Check that `~/.claude/settings.json` is valid JSON — `setup` reports the problem and leaves the
   file untouched rather than overwriting a file it cannot parse
2. Run `revenium-metering status` to see which telemetry variables Claude Code currently reads, and
   whether your organization's managed settings override any of them
3. Run `revenium-metering status --fix` to re-apply them
4. A backup is created before any modification (`~/.claude/settings.json.revenium-backup-<timestamp>`)

### Cursor sync not working

1. Verify `REVENIUM_CURSOR_API_KEY` is a valid Cursor Admin API key
2. Run `revenium-cursor status` to check connectivity to both APIs
3. Try `revenium-cursor reset` to clear sync state and start fresh
4. Check for lock file: `~/.cursor/revenium/revenium-cursor.lock`
5. For ongoing metering, register the Cursor credential under Connections > Providers in the Revenium dashboard rather than running `sync --watch`, which is deprecated

### Copilot data not appearing

1. Verify the token in Connections > Providers > GitHub Copilot carries the permissions above: fine-grained with **Organization Copilot metrics** and **Administration** (both read-only), or classic with `admin:org` and `manage_billing:copilot`
2. Verify the "Copilot usage metrics" policy is enabled (GitHub Org > Settings > Copilot > Policies)
3. Verify the organization slug matches your GitHub organization
4. GitHub usage data has a ~24 hour delay and Revenium refreshes Copilot once daily; data from today will not be available yet

For CLI `sync` and `backfill` specifically:

1. Export `GITHUB_TOKEN` / `GITHUB_ORG`, or pass `--github-token` / `--github-org`
2. Run `revenium-copilot status` with the credential supplied to check connectivity to both APIs
3. Try `revenium-copilot reset` to clear sync state and start fresh

### Skills show as `custom_skill` with no name

Claude Code only emits the skill name when `OTEL_LOG_TOOL_DETAILS=1` is in its environment.
Sessions started from a configuration written before the flag existed report unnamed skills.

1. Run `revenium-metering status`. It reports `Skill names: redacted in live telemetry` when the
   flag is missing
2. Run `revenium-metering status --fix` to re-apply the telemetry settings
3. Start a new Claude Code session. Already-running sessions keep the old environment

### Test metric shows 0 processed events

This is expected for test metrics. The endpoint acknowledges receipt but processes test events differently from production data.

### Debug

Contact support@revenium.io with:

- CLI tool name and version (`revenium-metering --version`)
- Output of `status` command
- Operating system and shell type
- Node.js version (`node --version`)

## Testing

```bash
npm test                 # Run all tests
npm run test:core        # Run core module tests
npm run test:cursor      # Run Cursor-specific tests
npm run test:integration # Run CLI binary integration tests
npm run test:coverage    # Run tests with V8 coverage report
npm run test:watch       # Run tests in watch mode
```

### E2E Integration Tests

E2E tests validate the full CLI flow for each provider against the live Revenium API. They run daily at 9:00 AM EST via GitHub Actions and can also be triggered manually.

```bash
export REVENIUM_E2E_API_KEY=rev_mk_your_key_here
npm run build && npm run test:e2e
```

See [TESTING.md](TESTING.md) for the full testing guide: architecture, environment variables, provider configurations, CI/CD workflows, and test helpers.

```bash
npm run lint             # ESLint check
npm run lint:fix         # ESLint auto-fix
npm run format           # Prettier format
npm run format:check     # Prettier check
```

## Requirements

- Node.js 20.19+ (the `engines` floor; `npm install` refuses anything below it)

## Contributing

See [CONTRIBUTING.md](https://github.com/revenium/revenium-cli-node/blob/HEAD/CONTRIBUTING.md)

## Code of Conduct

See [CODE_OF_CONDUCT.md](https://github.com/revenium/revenium-cli-node/blob/HEAD/CODE_OF_CONDUCT.md)

## Security

See [SECURITY.md](https://github.com/revenium/revenium-cli-node/blob/HEAD/SECURITY.md)

## License

This project is licensed under the MIT License - see the [LICENSE](https://github.com/revenium/revenium-cli-node/blob/HEAD/LICENSE) file for details.

## Support

- **Website**: [www.revenium.ai](https://www.revenium.ai)
- **Documentation**: [docs.revenium.io](https://docs.revenium.io)
- **Issues**: [Report bugs or request features](https://github.com/revenium/revenium-cli-node/issues)
- **Email**: support@revenium.io

---

**Built by Revenium**
