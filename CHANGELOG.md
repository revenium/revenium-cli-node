# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.0.5]: https://github.com/revenium/revenium-cli-node/releases/tag/v1.0.5
[1.0.4]: https://github.com/revenium/revenium-cli-node/releases/tag/v1.0.4
[1.0.3]: https://github.com/revenium/revenium-cli-node/releases/tag/v1.0.3
[1.0.2]: https://github.com/revenium/revenium-cli-node/releases/tag/v1.0.2
[1.0.1]: https://github.com/revenium/revenium-cli-node/releases/tag/v1.0.1
[1.0.0]: https://github.com/revenium/revenium-cli-node/releases/tag/v1.0.0
