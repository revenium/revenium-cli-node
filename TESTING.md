# Testing

This document covers the full testing infrastructure for `@revenium/cli`, including unit tests, integration tests, and end-to-end (e2e) tests against the live Revenium API.

## Test Architecture

```
tests/
├── unit/
│   ├── _core/                    Core module unit tests
│   │   ├── config-loader         Configuration loading and validation
│   │   ├── escaping              Shell value escaping
│   │   ├── health-check          API health check and test payload generation
│   │   ├── masking               Sensitive data masking
│   │   ├── otlp-client           OTLP HTTP client
│   │   ├── otlp-schema           OTLP payload schema validation
│   │   ├── rate-limiter          Request rate limiting
│   │   ├── shell-detector        Shell type detection
│   │   ├── validator             Input validation
│   │   └── verify-key            API key verification
│   ├── claude-code/              Claude Code provider tests
│   │   ├── backfill              Historical data backfill
│   │   ├── loader                Configuration loader
│   │   └── writer                Configuration file writer
│   └── cursor/                   Cursor provider tests
│       ├── deduplicator          Event deduplication
│       ├── otlp-mapper           Usage event to OTLP transformation
│       └── state-manager         Sync state persistence
├── integration/
│   ├── e2e.test.ts               E2E suite (live API, 3 providers)
│   ├── cli-binaries.test.ts      Binary availability and --help checks
│   ├── otlp-client.test.ts       OTLP client against mock capture server
│   └── provider-e2e.test.ts      Provider-specific integration (requires provider keys)
└── helpers/
    ├── fixtures.ts               Cursor test data factories
    ├── otlp-fixtures.ts          OTLP payload fixtures and constants
    ├── otlp-capture-server.ts    Mock OTLP HTTP server
    └── otlp-validator.ts         OTLP payload structure validator
```

## Running Tests

### All Tests

```bash
npm test                          # Run all unit + integration tests (vitest)
npm run test:coverage             # Run with V8 coverage report
npm run test:watch                # Run in watch mode
```

### By Layer

```bash
npm run test:core                 # Unit tests for _core module
npm run test:cursor               # Unit tests for Cursor provider
npm run test:integration          # All integration tests (cli-binaries, otlp-client)
```

### E2E Tests (Live API)

```bash
export REVENIUM_E2E_API_KEY=hak_your_key_here

npm run build
npm run test:e2e                  # All providers
```

Single provider:

```bash
REVENIUM_E2E_PROVIDER=claude-code npm run test:e2e
REVENIUM_E2E_PROVIDER=gemini-cli  npm run test:e2e
REVENIUM_E2E_PROVIDER=cursor      npm run test:e2e
```

Provider integration (requires real provider API keys):

```bash
CLAUDE_CODE_PROVIDER_KEY=... npm run test:provider-e2e
GEMINI_CLI_PROVIDER_KEY=...  npm run test:provider-e2e
CURSOR_PROVIDER_KEY=...      npm run test:provider-e2e
```

### Linting and Formatting

```bash
npm run lint                      # ESLint check
npm run lint:fix                  # ESLint auto-fix
npm run format                    # Prettier format
npm run format:check              # Prettier check
```

## E2E Test Details

### How It Works

Each e2e test follows the same lifecycle:

1. **Setup** (`beforeAll`): creates an isolated temporary `HOME` directory with provider-specific configuration files
2. **Execute**: runs the compiled CLI binary (`dist/{provider}/cli/index.js`) with the `test` command using `execFileSync` (60s timeout)
3. **Assert**: validates the CLI output against the success criteria
4. **Cleanup** (`afterAll`): removes the temporary directory

The test process runs in an isolated environment with:
- `HOME` pointing to the temporary directory
- `NODE_ENV=production`
- `NODE_OPTIONS=""` (cleared)

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `REVENIUM_E2E_API_KEY` | Yes | - | Revenium API key (`hak_` prefix) |
| `REVENIUM_E2E_ENDPOINT` | No | `https://api.revenium.ai` | Base API endpoint |
| `REVENIUM_E2E_PROVIDER` | No | `all` | Provider filter: `all`, `claude-code`, `gemini-cli`, `cursor` |

### Provider Configuration

Each provider writes different environment files to simulate a real user setup:

**Claude Code** (`~/.claude/revenium.env`):
- `CLAUDE_CODE_ENABLE_TELEMETRY=1`
- `OTEL_EXPORTER_OTLP_ENDPOINT` (full OTLP logs endpoint)
- `OTEL_EXPORTER_OTLP_HEADERS` (x-api-key)
- `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`
- `OTEL_LOGS_EXPORTER=otlp`

**Gemini CLI** (`~/.gemini/revenium.env`):
- `GEMINI_TELEMETRY_ENABLED=true`
- `GEMINI_TELEMETRY_TARGET=local`
- `GEMINI_TELEMETRY_OTLP_ENDPOINT` (base OTLP endpoint)
- `GEMINI_TELEMETRY_OTLP_PROTOCOL=http`
- `GEMINI_TELEMETRY_LOG_PROMPTS=true`
- `OTEL_RESOURCE_ATTRIBUTES` (api_key + cost_multiplier)

**Cursor** (`~/.cursor/revenium/revenium.env`):
- `CURSOR_API_KEY` (placeholder)
- `REVENIUM_API_KEY`
- `REVENIUM_ENDPOINT`

### Success Criteria

The CLI `test` command output must contain all of the following:

| Pattern | Description |
|---------|-------------|
| `Integration is working correctly!` | Confirms end-to-end connectivity |
| `Processed: <number>` (>= 0) | Events processed by the API |
| `ID:` | Returned resource identifier |
| `Resource Type:` | Resource classification |
| `Created:` | Resource creation timestamp |

## CI/CD Workflows

### CI (`ci.yml`)

Runs on every push/PR to `main`:
- Matrix: Node.js 20, 22
- Steps: lint, format check, build, unit + integration tests

### E2E (`e2e.yml`)

| Trigger | Schedule | Provider | Node.js |
|---------|----------|----------|---------|
| Daily cron | 9:00 AM EST (14:00 UTC) | all | 20 |
| Manual dispatch | On demand | Selectable | 20 or 22 |
| Workflow call | From other workflows | Configurable | Configurable |

Required repository secrets:
- `REVENIUM_E2E_API_KEY` (required)
- `REVENIUM_E2E_ENDPOINT` (optional, defaults to production)

### Version Check Workflows

Three daily workflows monitor upstream provider npm releases and automatically trigger e2e tests:

| Workflow | Package | Cron (UTC) |
|----------|---------|------------|
| `claude-code-version-check.yml` | `@anthropic-ai/claude-code` | 09:00 |
| `gemini-cli-version-check.yml` | Gemini CLI | 09:00 |
| `cursor-version-check.yml` | Cursor | 09:00 |

When a new version is detected:
1. Creates a GitHub issue with a testing checklist
2. Triggers the e2e workflow for that specific provider
3. Reports the e2e result as a comment on the tracking issue

## Test Helpers

### OTLP Capture Server (`otlp-capture-server.ts`)

Mock HTTP server used by `otlp-client.test.ts` to validate the OTLP client behavior without hitting real endpoints.

- Binds to `127.0.0.1` on a random port (OS-assigned)
- Responds to `POST /meter/v2/otlp/v1/logs` with a mock success response
- Captures all incoming requests (method, URL, headers, parsed body)
- Provides `waitForRequests(count, timeoutMs)` for async test assertions

### OTLP Validator (`otlp-validator.ts`)

Validates OTLP payload structure compliance:
- `validateOtlpPayloadStructure`: checks `resourceLogs > scopeLogs > logRecords` hierarchy
- `validateLogRecordAttributes`: verifies required attribute keys are present with valid values
- `validateResourceAttributes`: confirms `service.name` matches expected provider

### Fixtures

- `fixtures.ts`: factories for `CursorConfig`, `CursorUsageEvent`, `SyncState`
- `otlp-fixtures.ts`: constants for required log attribute keys, provider service names, body patterns, and `createProviderTestPayload()` factory

## Configuration

### vitest.config.ts

- **Globals**: enabled (describe, it, expect available without imports)
- **Environment**: Node.js
- **Pattern**: `tests/**/*.test.ts`
- **Coverage**: V8 provider, includes `src/**/*.ts`, excludes barrel files (`src/**/index.ts`)
