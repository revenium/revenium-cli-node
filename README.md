# Revenium CLI for Node.js

[![npm version](https://img.shields.io/npm/v/@revenium/cli.svg)](https://www.npmjs.com/package/@revenium/cli)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org/)
[![Documentation](https://img.shields.io/badge/docs-revenium.io-blue)](https://docs.revenium.io)
[![Website](https://img.shields.io/badge/website-revenium.ai-blue)](https://www.revenium.ai)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Unified CLI tools for Claude Code, Gemini CLI, and Cursor IDE metering**

A professional-grade set of CLI tools that configure automatic AI usage tracking for Claude Code, Gemini CLI, and Cursor IDE. Features interactive setup wizards, OTLP telemetry, shell profile management with backup/restore, Cursor Admin API sync with SHA-256 deduplication, and historical backfill with batch processing.

## Features

- **Three CLIs Unified** - Claude Code, Gemini CLI, and Cursor IDE metering in one package
- **Interactive Setup Wizard** - Guided configuration with shell profile auto-update and backup
- **OTLP Telemetry** - Standard OpenTelemetry log format with retry logic and exponential backoff
- **Cursor Sync Engine** - Continuous sync with SHA-256 deduplication, state persistence, and process locking
- **Historical Backfill** - Import past usage data with batch processing, dry-run mode, and date filtering
- **Shell Management** - Auto-detection (bash/zsh/fish), profile modification with timestamped backups
- **Security** - PII masking, restricted file permissions (0o600), safe shell escaping
- **Programmatic API** - Validation, OTLP client, health checks, masking, and shell detection

## Architecture

```
@revenium/cli
|
|-- _core/                  Shared infrastructure across all CLIs
|   |-- api/
|   |   |-- otlp-client     OTLP HTTP client (retry, backoff, 30s timeout)
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
|   |-- config/              ~/.claude/revenium.env loader/writer
|   +-- constants            Subscription tiers and cost multipliers
|
|-- gemini-cli/             Gemini CLI (revenium-gemini)
|   |-- cli/                 Commander entry point
|   |-- commands/            setup, status, test
|   |-- config/              ~/.gemini/revenium.env loader/writer (bash + fish)
|   +-- constants            Gemini-specific env vars
|
+-- cursor/                 Cursor IDE CLI (revenium-cursor)
    |-- cli/                 Commander entry point
    |-- commands/            setup, status, test, sync, reset, backfill
    |-- config/              ~/.cursor/revenium/revenium.env loader/writer
    |-- core/
    |   |-- cursor-client    Cursor Admin API client (pagination, 30-day chunking)
    |   +-- sync/
    |       |-- scheduler    Sync cycle orchestration and watch mode
    |       |-- state-manager Persistent sync state (JSON)
    |       +-- deduplicator SHA-256 hash-based event deduplication
    +-- transform/
        +-- otlp-mapper      Cursor events -> OTLP log records
```

### Data Flow

```
User runs CLI command
       |
       v
Interactive Setup (Inquirer prompts)
       |
       v
Validate inputs (API key hak_ prefix, email RFC, URL protocol)
       |
       v
Test endpoint connectivity (OTLP health check with latency)
       |
       v
Write config to tool-specific location:
  - Claude Code:  ~/.claude/revenium.env
  - Gemini CLI:   ~/.gemini/revenium.env
  - Cursor IDE:   ~/.cursor/revenium/revenium.env
       |
       v
Update shell profile (bash/zsh/fish) with env vars
  - Creates timestamped backup before modification
  - Uses marker comments for idempotent updates
  - Keeps last 5 backups, cleans older ones
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
Deduplicate via SHA-256 hash (up to 10,000 recent hashes)
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

## CLI Tools

| Binary | Tool | Commands |
|--------|------|----------|
| `revenium-metering` | Claude Code | `setup` `status` `test` `backfill` |
| `revenium-gemini` | Gemini CLI | `setup` `status` `test` |
| `revenium-cursor` | Cursor IDE | `setup` `status` `test` `sync` `reset` `backfill` |

## Installation

```bash
npm install -g @revenium/cli
```

## Getting Started

### Configuration

Create a `.env` file in your project root. See [`.env.example`](https://github.com/revenium/revenium-cli-node/blob/HEAD/.env.example) for all available options.

Minimum required:

```env
REVENIUM_API_KEY=hak_your_revenium_api_key_here
REVENIUM_ENDPOINT=https://api.revenium.ai
```

### Quick Start - Claude Code

```bash
revenium-metering setup
```

The setup wizard will prompt for your API key, email, subscription tier, and endpoint. It automatically:
1. Validates your API key format (`hak_` prefix)
2. Tests connectivity to the Revenium endpoint
3. Writes configuration to `~/.claude/revenium.env`
4. Updates your shell profile with the required environment variables

After setup, verify with:

```bash
revenium-metering status    # Check configuration and connectivity
revenium-metering test      # Send a test metric to verify integration
```

### Quick Start - Gemini CLI

```bash
revenium-gemini setup
```

Generates both bash and fish shell configurations. Writes to `~/.gemini/revenium.env`.

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
revenium-cursor sync                # One-time sync of usage events
revenium-cursor sync --watch        # Continuous sync (default: every 5 min)
revenium-cursor test                # Send test metric
```

## Command Reference

### Claude Code (`revenium-metering`)

#### `setup`

Interactive setup wizard for Claude Code metering.

| Option | Description |
|--------|-------------|
| `--api-key <key>` | Revenium API key (skips prompt) |
| `--email <email>` | Email for usage attribution |
| `--tier <tier>` | Subscription tier: `pro`, `max_5x`, `max_20x`, `team_premium`, `enterprise`, `api` |
| `--endpoint <url>` | Revenium API endpoint (default: `https://api.revenium.ai`) |
| `--organization <name>` | Organization name |
| `--product <name>` | Product name |
| `--skip-shell-update` | Skip shell profile modification |

#### `status`

Displays current configuration (masked credentials), environment variable load status, and endpoint health with latency.

#### `test`

Sends a test OTLP metric and displays the response.

| Option | Description |
|--------|-------------|
| `--verbose` | Show full request/response details |

#### `backfill`

Imports historical usage data from Claude Code JSONL files (`~/.claude/projects/`).

| Option | Description |
|--------|-------------|
| `--since <date>` | Import since date (ISO format or relative: `7d`, `1m`, `3m`) |
| `--dry-run` | Preview records without sending |
| `--batch-size <n>` | Records per batch (default: 50) |
| `--delay <ms>` | Delay between batches in ms (default: 1000) |
| `--verbose` | Show per-record details |

### Gemini CLI (`revenium-gemini`)

#### `setup`

Interactive setup wizard for Gemini CLI metering. Generates both bash and fish shell configurations.

| Option | Description |
|--------|-------------|
| `--api-key <key>` | Revenium API key |
| `--email <email>` | Email for usage attribution |
| `--organization <name>` | Organization name |
| `--product <name>` | Product name |
| `--cost-multiplier <n>` | Cost multiplier for pricing adjustments (default: 1.0) |
| `--endpoint <url>` | Revenium API endpoint |
| `--skip-shell-update` | Skip shell profile modification |

#### `status`

Displays configuration, shell environment status, and endpoint health.

#### `test`

Sends a test OTLP metric.

| Option | Description |
|--------|-------------|
| `--verbose` | Show full request/response details |

### Cursor IDE (`revenium-cursor`)

#### `setup`

Interactive setup wizard requiring both Cursor Admin API and Revenium API keys.

| Option | Description |
|--------|-------------|
| `--cursor-api-key <key>` | Cursor admin API key |
| `--api-key <key>` | Revenium API key |
| `--email <email>` | Email for usage attribution |
| `--organization <name>` | Organization name |
| `--product <name>` | Product name |
| `--endpoint <url>` | Revenium API endpoint |
| `--subscription-tier <tier>` | Cursor tier: `pro`, `business`, `enterprise`, `api` |
| `--sync-interval <min>` | Sync interval in minutes (default: 5) |

#### `status`

Displays configuration, sync state (last sync time, event count), and connectivity to both Cursor and Revenium APIs.

#### `test`

Sends a test OTLP metric.

| Option | Description |
|--------|-------------|
| `--verbose` | Show full request/response details |

#### `sync`

Syncs Cursor usage events to Revenium.

| Option | Description |
|--------|-------------|
| `--watch` | Run continuously with periodic sync |
| `--from <date>` | Sync from date (ISO format) |
| `--to <date>` | Sync to date (ISO format) |

#### `reset`

Clears sync state for a fresh sync. Displays current state before resetting.

#### `backfill`

Imports historical Cursor usage data.

| Option | Description |
|--------|-------------|
| `--since <date>` | Import since date |
| `--to <date>` | Import until date |
| `--dry-run` | Preview without sending |
| `--batch-size <n>` | Records per batch |
| `--verbose` | Show per-record details |

## Subscription Tiers

### Claude Code

| Tier | Plan | Cost Multiplier |
|------|------|-----------------|
| `pro` | Pro (~$20/mo) | 0.16 |
| `max_5x` | Max 5x (~$100/mo) | 0.16 |
| `max_20x` | Max 20x (~$200/mo) | 0.08 |
| `team_premium` | Team Premium (~$125/seat) | 0.20 |
| `enterprise` | Enterprise (custom) | 0.05 |
| `api` | API (no subscription) | 1.00 |

### Cursor

| Tier | Plan | Cost Multiplier |
|------|------|-----------------|
| `pro` | Pro ($20/mo) | 0.04 |
| `business` | Business ($40/seat/mo) | 0.08 |
| `enterprise` | Enterprise (custom) | 0.05 |
| `api` | API / Pay-as-you-go | 1.00 |

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `REVENIUM_API_KEY` | Yes | Revenium API key (starts with `hak_`) |
| `REVENIUM_ENDPOINT` | No | API endpoint (default: `https://api.revenium.ai`) |
| `REVENIUM_EMAIL` | No | Email for usage attribution |
| `REVENIUM_ORGANIZATION_NAME` | No | Organization name for cost attribution |
| `REVENIUM_PRODUCT_NAME` | No | Product name for cost attribution |
| `REVENIUM_COST_MULTIPLIER` | No | Cost multiplier override (default: 1.0) |

### Cursor-Specific Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `CURSOR_API_KEY` | Yes (Cursor) | Cursor admin API key |
| `CURSOR_SUBSCRIPTION_TIER` | No | Subscription tier: `pro`, `business`, `enterprise`, `api` |
| `REVENIUM_SYNC_INTERVAL_MS` | No | Sync interval in milliseconds (default: 300000) |

### Configuration File Locations

| Tool | Config Path | Permissions |
|------|-------------|-------------|
| Claude Code | `~/.claude/revenium.env` | 0o600 (owner read/write) |
| Gemini CLI | `~/.gemini/revenium.env` | 0o600 (owner read/write) |
| Cursor IDE | `~/.cursor/revenium/revenium.env` | 0o600 (owner read/write) |
| Cursor State | `~/.cursor/revenium/state.json` | 0o600 (owner read/write) |

See [`.env.example`](https://github.com/revenium/revenium-cli-node/blob/HEAD/.env.example) for the complete list with all optional configuration.

## Programmatic API

The package exports utility functions and types for programmatic use:

```typescript
import {
  validateApiKey,
  validateEmail,
  validateEndpointUrl,
  sendOtlpLogs,
  checkEndpointHealth,
  createTestPayload,
  generateTestSessionId,
  maskApiKey,
  maskEmail,
  detectShell,
  getProfilePath,
} from '@revenium/cli';
```

### Validation

| Function | Description |
|----------|-------------|
| `validateApiKey(key)` | Validate Revenium API key format (`hak_` prefix, min length) |
| `validateEmail(email)` | Validate email address format (RFC-compliant) |
| `validateEndpointUrl(url)` | Validate endpoint URL format and protocol |

### OTLP Client

| Function | Description |
|----------|-------------|
| `sendOtlpLogs(payload, endpoint, apiKey)` | Send OTLP log payload with retry (3 attempts, exponential backoff) |

### Health Check

| Function | Description |
|----------|-------------|
| `checkEndpointHealth(endpoint, apiKey)` | Test Revenium endpoint connectivity (returns latency) |
| `createTestPayload()` | Create a test OTLP payload with metadata |
| `generateTestSessionId()` | Generate a unique test session ID |

### Shell Utilities

| Function | Description |
|----------|-------------|
| `detectShell()` | Detect current shell type (`bash`, `zsh`, `fish`, `unknown`) |
| `getProfilePath(shell)` | Get shell profile file path for the detected shell |
| `maskApiKey(key)` | Mask API key for safe display (first 4 + last 4 chars) |
| `maskEmail(email)` | Mask email for safe display (first char + domain) |

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
} from '@revenium/cli';
```

## Troubleshooting

### Setup wizard fails

1. Verify your API key starts with `hak_`
2. Check internet connectivity to `https://api.revenium.ai`
3. Run `status` command to verify existing configuration
4. Try passing options directly: `revenium-metering setup --api-key hak_...`

### Shell profile not updated

1. Check that your shell profile file is writable
2. Verify detected shell: run `revenium-metering status` to see detected shell type
3. Use `--skip-shell-update` and configure manually by adding `source ~/.claude/revenium.env` to your profile
4. A backup of your profile is created before any modification (`~/.zshrc.revenium-backup-<timestamp>`)

### Cursor sync not working

1. Verify `CURSOR_API_KEY` is a valid Cursor Admin API key
2. Run `revenium-cursor status` to check connectivity to both APIs
3. Try `revenium-cursor reset` to clear sync state and start fresh
4. Check for lock file: `~/.cursor/revenium/revenium-cursor.lock`
5. Use `revenium-cursor sync --watch` for continuous sync with automatic retry

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
npm test                 # Run all 106 tests
npm run test:core        # Run core module tests
npm run test:cursor      # Run Cursor-specific tests
npm run test:integration # Run CLI binary integration tests
npm run test:coverage    # Run tests with V8 coverage report
npm run test:watch       # Run tests in watch mode
```

```bash
npm run lint             # ESLint check
npm run lint:fix         # ESLint auto-fix
npm run format           # Prettier format
npm run format:check     # Prettier check
```

## Requirements

- Node.js 18+

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
