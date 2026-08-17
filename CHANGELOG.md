# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.12] - 2026-08-17

### Removed

- Ticket attribution hooks (`revenium-metering ticket`, ticket gate hook, session state, Linear resolver) pending internal testing

## [1.1.11] - 2026-08-13

### Added

- Ticket attribution hooks for Claude Code (reverted in 1.1.12)

## [1.1.10] - 2026-07-30

### Fixed

- Backfill deduplication: merge per-category max tokens instead of selecting by aggregate, prefer richer records, align model fallback

### Added

- Emit skill and tool details in Claude Code backfill OTLP logs

## [1.1.9] - 2026-07-23

### Fixed

- Global rate limiter: move `enforceRateLimit` into `sendOtlpRequest` so all providers (Claude Code, Cursor, Copilot, Codex) get automatic pacing without manual wiring
- Cursor `backfill` now paces its Cursor Admin API fetches (default ~8 req/min, under Cursor's documented 60 req/min limit for `/teams/filtered-usage-events`) so historical pulls no longer trip Cursor's rate limiter (429). Tunable via `--fetch-delay <ms>` or `CURSOR_MIN_REQUEST_INTERVAL_MS` (BACK-2319)
- Cursor fetch client now uses jittered exponential backoff and honors the `Retry-After` header defensively on retryable responses, matching the Revenium send path

## [1.1.8] - 2026-07-15

### Fixed

- Fix codex backfill email placement for subscriber email contract
- OTLP client: cap Retry-After at backoffMaxMs, 4xx fail-fast, drop warning
- OTLP client: add Retry-After obedience and remove stale attempts field

### Added

- Subscriber email contract integration tests
- Backfill email prompt for Claude Code

## [1.1.7] - 2026-07-01

### Fixed

- Deduplicate streaming JSONL snapshots in Claude Code backfill (group by requestId + messageId, keep latest)
- Deduplicate growing token_count snapshots in Codex CLI backfill (group by turn_id, keep latest)
- Add request_id and message.id OTLP attributes for traceability

### Changed

- Backfill summary now shows records found, records to backfill, and duplicates skipped
- Managed settings attribution via field registry for setup config writers

## [1.1.6] - 2026-06-22

### Changed

- Bump backfill default TPS from 1 to 25

## [1.1.5] - 2026-06-17

### Changed

- Reduce backfill default TPS from 5 to 1
- Single source of truth for DEFAULT_TARGET_TPS constant

## [1.1.4] - 2026-06-05

### Added

- GitHub AI Credits billing API integration for real cost data (cost_usd per model per day)
- Per-user usage tracking from GitHub Copilot Metrics API (users-1-day reports)

### Changed

- Migrate Copilot CLI from deprecated /copilot/usage endpoint to /copilot/metrics/reports/users-1-day (API version 2026-03-10)
- Two-step fetch: signed download URLs then NDJSON report download with retry
- Send real model name (e.g. gpt-5.3-codex) in gen_ai.request.model instead of hardcoded "copilot"
- Deduplication key expanded to (day + user + language + model + editor)

### Fixed

- Transaction ID collision across users with same language/model
- NDJSON parser resilience (malformed lines skipped instead of failing batch)
- UTC date handling for billing API day parameter

## [1.1.2] - 2026-06-04

### Added

- Client-side resilience with circuit breaker and retry logic for OTLP telemetry

### Fixed

- Drop deprecated organizationId/productId from wire-emit
- Codex OTLP endpoint setup

## [1.1.1] - 2026-05-21

### Fixed

- Gemini CLI test payload scope and body mismatch with backend mapper (`gemini-cli` to `gemini_cli`, `api_request` to `api_response`)

## [1.1.0] - 2026-05-21

### Added

- GitHub Copilot CLI (`revenium-copilot`) with `setup`, `status`, `test`, `sync`, `backfill`, and `reset` commands
- GitHub Copilot usage sync engine with GitHub API integration, deduplication, and scheduled continuous mode
- GitHub Copilot OTLP mapper for seat assignment and usage metrics telemetry
- Copilot state manager for sync cursor persistence
- Codex CLI backfill attribution support for accurate historical telemetry
- Cross-SDK field parity registry (`_core/schema/field-registry.ts`) to standardize token types across providers
- Context7 documentation refresh automation workflows

### Fixed

- Codex CLI critical issues blocking end-to-end telemetry (shared timestamp, `duration_ms` parity)
- Test payload body/scope mismatch (hyphen vs underscore)
- Copilot scheduler dedup sending full days and sync lock cleanup

### Changed

- Copilot CLI validates `--subscription-tier` flag and uses natural key dedup
- OTLP client and retry handler extended with copilot-specific batch support

## [1.0.9] - 2026-05-08

### Removed

- Unused Cursor-specific fields from OTLP payload (`cursorTokenFee`, `requestsCosts`, `isTokenBasedCall`, `maxMode`, `isChargeable`, `isHeadless` from types; `cursor.token_fee`, `cursor.requests_costs`, `cursor.is_token_based` from OTLP mapper)

## [1.0.8] - 2026-05-01

### Added

- `--delay <ms>` option for Cursor backfill to mitigate rate limiting (0-60000ms range, warning for >10s)
- Shared retry handler (`_core/api/retry-handler.ts`) with exponential backoff for batch sending
- Retry logic with exponential backoff (1s/2s/4s) for Cursor backfill batch sends
- Per-batch failure tracking with detailed error reporting for Cursor backfill

### Changed

- Extract `sendBatchWithRetry` and `isRetryableError` from Claude Code backfill to shared `_core/api/` module
- Export `MAX_RETRIES` constant from retry handler for consistent usage across CLIs
- Verbose mode now logs all retry attempts including the final failure

### Fixed

- Cursor backfill no longer silently swallows batch send errors

## [1.0.7] - 2026-04-27

### Added

- Support for new `rev_` API key prefix (covers `rev_mk_`, `rev_sk_`, and future key types)
- Updated setup prompts across all 3 CLIs with `rev_` hint

### Changed

- API key validator now accepts both `hak_` (legacy) and `rev_` (new) prefixes
- Header extraction regex updated to match `rev_` prefixed keys
- E2E test framework with force-failure flag for alert validation

## [1.0.6] - 2026-04-02

### Changed

- Update commander from v13 to v14
- Update vitest from v3 to v4, @vitest/coverage-v8 from v3 to v4
- Update dotenv from v16 to v17
- Update eslint from v10.0 to v10.1, typescript-eslint from v8.56 to v8.58
- Bump minimum Node.js engine from >=20.0.0 to >=20.19.0

### Fixed

- Resolve 4 security vulnerabilities (brace-expansion, flatted, lodash, picomatch)
- Align @types/node range with minimum supported engine version

## [1.0.5] - 2026-03-31

### Changed

- Update copyright year to 2025-2026

## [1.0.4] - 2026-03-25

### Removed

- Cost multiplier logic from Cursor CLI (constants, config loader/writer, backfill, types)
- Cost multiplier logic from Gemini CLI (constants, config loader/writer, setup, status, CLI options)

## [1.0.3] - 2026-03-24

### Fixed

- Cursor backfill crashes for missing tokenUsage, invalid timestamps, and pagination
- Timestamp parsing for string numeric values in OTLP mapper
- Invalid timestamp filtering with numeric sort comparator instead of silent fallback
- Timestamp filtering moved to callers for accurate counts

## [1.0.2] - 2026-03-16

### Added

- Identity fields (user email, account UUID, organization) in OTLP resource attributes
- Subscription tier as OTLP resource attribute for backend cost adjustment
- API key verification endpoint support (`verify-key`)

### Fixed

- Escape shell metacharacters in OTEL_RESOURCE_ATTRIBUTES values
- Guard `decodeURIComponent` in health-check OTEL attribute parsing

## [1.0.1] - 2026-03-11

### Added

- Rate limiting on backfill data submissions with configurable `targetTps` and `userDelayMs`

### Fixed

- Validate `batchSize` and `targetTps` inputs in rate limiter and backfill commands
- Enforce rate limit before send and validate integer batch-size
- Validate `userDelayMs` in `enforceRateLimit`
- Sanitize invalid `userDelayMs` to 0 and align cursor CLI batch-size validation

## [1.0.0] - 2025-02-24

### Added

- Unified CLI combining Claude Code, Gemini CLI, and Cursor IDE metering tools
- Three binary entry points: `revenium-metering` (Claude Code), `revenium-gemini` (Gemini CLI), `revenium-cursor` (Cursor IDE)
- Claude Code CLI with `setup`, `status`, `test`, and `backfill` commands
- Gemini CLI with `setup`, `status`, and `test` commands
- Cursor CLI with `setup`, `status`, `test`, `sync`, `reset`, and `backfill` commands
- Interactive setup wizard with shell profile auto-update for Claude Code and Gemini
- Cursor sync engine with deduplication, state management, and continuous watch mode
- Shared core infrastructure (`_core`) with OTLP client, config validation, shell detection, escaping, and PII masking
- Programmatic API exports for validation, OTLP sending, health checks, masking, and shell detection
- OTLP telemetry format for usage data transmission
- 106 unit and integration tests

[1.1.10]: https://github.com/revenium/revenium-cli-node/releases/tag/v1.1.10
[1.1.9]: https://github.com/revenium/revenium-cli-node/releases/tag/v1.1.9
[1.1.8]: https://github.com/revenium/revenium-cli-node/releases/tag/v1.1.8
[1.1.7]: https://github.com/revenium/revenium-cli-node/releases/tag/v1.1.7
[1.1.6]: https://github.com/revenium/revenium-cli-node/releases/tag/v1.1.6
[1.1.5]: https://github.com/revenium/revenium-cli-node/releases/tag/v1.1.5
[1.1.4]: https://github.com/revenium/revenium-cli-node/releases/tag/v1.1.4
[1.1.2]: https://github.com/revenium/revenium-cli-node/releases/tag/v1.1.2
[1.1.1]: https://github.com/revenium/revenium-cli-node/releases/tag/v1.1.1
[1.1.0]: https://github.com/revenium/revenium-cli-node/releases/tag/v1.1.0
[1.0.9]: https://github.com/revenium/revenium-cli-node/releases/tag/v1.0.9
[1.0.8]: https://github.com/revenium/revenium-cli-node/releases/tag/v1.0.8
[1.0.7]: https://github.com/revenium/revenium-cli-node/releases/tag/v1.0.7
[1.0.6]: https://github.com/revenium/revenium-cli-node/releases/tag/v1.0.6
[1.0.5]: https://github.com/revenium/revenium-cli-node/releases/tag/v1.0.5
[1.0.4]: https://github.com/revenium/revenium-cli-node/releases/tag/v1.0.4
[1.0.3]: https://github.com/revenium/revenium-cli-node/releases/tag/v1.0.3
[1.0.2]: https://github.com/revenium/revenium-cli-node/releases/tag/v1.0.2
[1.0.1]: https://github.com/revenium/revenium-cli-node/releases/tag/v1.0.1
[1.0.0]: https://github.com/revenium/revenium-cli-node/releases/tag/v1.0.0
