# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-10-23

### Deprecated

- `revenium-cursor sync` and `revenium-copilot sync` were announced in `1.2.0` for removal in this
  release and are still here. The removal moves to `3.0.0`, and the notice both commands print now
  names that version rather than the one it is running under. Nothing about the commands changed;
  ongoing metering still comes from the provider credential saved in the dashboard, and `backfill`,
  `status` and `test` are unaffected either way.

### Changed

- `setup` for Claude Code, Codex, Copilot, Cursor and Gemini CLI now applies the same endpoint,
  email, API key and attribution-name checks on every path, flags included, and refuses the run
  before the key reaches the network or a config file is written. Invalid flags are reported
  up front instead of after the interactive questions are answered. Values are stored as they were
  checked, with surrounding whitespace removed, so the length and format limits hold for what ends
  up in the config file.

  Upgrading: a non-HTTPS `--endpoint` or Claude Code `--mgmt-endpoint` is now refused unless the
  host is `localhost` or `127.0.0.1`,
  so a self-hosted collector reached over plain `http://` — an internal DNS name,
  `host.docker.internal`, `[::1]` — stops setup; serve it over HTTPS or point setup at a loopback
  address. An `--email` that is not RFC-shaped (a single-label internal domain such as
  `svc-account@corp`, or a sentinel value) is also refused where it was previously written as given.

- Every Claude Code and Codex setup, status and backfill path now resolves from the assistant's own
  folder setting — `CLAUDE_CONFIG_DIR` for Claude Code, `CODEX_HOME` for Codex — falling back to
  `~/.claude` and `~/.codex` only when the variable is unset. Explicit `--config-path` and
  `--sessions-path` still win. Previously `revenium-codex setup` wrote its config to `~/.codex`
  even with `CODEX_HOME` set, so Codex never read it and no live usage reached Revenium, and both
  backfills scanned the default folder regardless.

  Upgrading with `CODEX_HOME` set: an earlier `setup` left `config.toml` and `revenium.env` under
  `~/.codex`, and nothing reads that location anymore. Re-run `revenium-codex setup` to write them
  under `$CODEX_HOME`. Until then `revenium-codex backfill` stops with "Configuration not found" and
  names the path it checked, and `revenium-codex run` starts Codex without organization and product
  attribution.

### Added

- `revenium-gemini run` launches Gemini CLI with the Revenium telemetry variables injected into that
  process alone. `setup` now installs a `gemini` shell wrapper that calls it, replacing the previous
  instruction to source `~/.gemini/revenium.env` from the shell profile. Arguments, streams, exit
  code and signal behaviour match running `gemini` directly, and a missing or unreadable
  configuration starts Gemini CLI unmetered with a warning rather than refusing to start it.
  Because the wrapper is a shell function, it does not cover non-interactive callers — scripts,
  Makefiles, CI jobs, editor integrations and `command gemini` reach the real binary and are not
  metered. Call `revenium-gemini run -- <args>` in those places.

- `revenium-metering backfill` now imports the cache-write TTL split Claude Code records per call
  (`cache_creation_1h_tokens` and `cache_creation_5m_tokens`, alongside the flat
  `cache_creation_tokens` total) and the call's `speed`. Speed is read by Revenium today, so a
  backfilled fast-mode call shows as fast mode. The TTL split is stored but not yet priced: charging
  1-hour cache writes at their own rate depends on a platform-side change that ships separately, so
  the TTL split on its own does not change what an import costs. The import also sends the inference
  region (`inference_geo`), the number of web searches the call made (`web_search_requests`, only
  when it made any) and, when the session file records it, the cost Claude Code computed for that
  call (`cost_usd`), so an imported call prices like its live counterpart instead of as plain tokens.
  Those signals are priced, so fast-mode calls, calls that ran web searches and calls with a recorded
  cost can import at a higher figure than the same sessions imported by an earlier version.
  Session files written by older Claude Code versions do not carry these fields and are imported
  exactly as before. A record's
  `transaction_id` is unchanged by this release, so re-running a backfill over sessions already
  imported by an earlier version sends no new spend — which also means records already imported keep
  their flat cache-write total and gain no split, and only calls imported from now on carry one.

- `revenium-codex backfill` now imports Codex's prompt-cache write tokens and sends them with each
  record, so the figure reaches Revenium instead of being dropped at import. Pricing those tokens at
  the cache-write rate also depends on the platform recording the count, which ships separately.
  Rollouts recorded by Codex versions that do not report the figure keep every token figure they
  report today and carry a cache-write count of 0, which Revenium stores as no cache write.
  A record's `transaction_id` is unchanged by this release, so re-running a
  backfill over rollouts already imported by an earlier version sends no new spend.

- Backfilled Codex records now carry the call's total token count, which previously reached Revenium
  as 0, and records imported by both `revenium-codex backfill` and `revenium-metering backfill`
  now declare themselves as a backfill import rather than as live CLI telemetry. A record's
  `transaction_id` is unchanged by this release, so re-running a backfill over rollouts already
  imported by an earlier version sends no new spend — which also means Codex records already
  imported keep their total of 0, and only calls imported from now on carry the real figure.

- `revenium-codex backfill` now warns, before it reads anything, that Codex exports usage live as
  calls happen and that calls in the chosen window which were already exported live are imported a
  second time. Reconciling a live Codex call against its backfilled copy is a platform-side change
  and is not part of this release, so ending the window with `--to` at the moment live export was
  configured remains the way to avoid counting a call twice.

- GitHub Copilot usage from code completion, Copilot CLI and the Copilot app now reaches Revenium as
  its own record per developer and day, alongside the per-model chat records, and the CLI and app
  records carry the token counts GitHub reports instead of zero. Premium request credits are
  reported per developer, spread across the surfaces that developer used that day, and a developer
  GitHub reports credits but no usage for keeps their credits on a record of their own. Billing lines
  that match no usage row are imported as organization-level records under the normalized model
  name, so a model is no longer split into two series by GitHub's two spellings of it. Records a
  previous version already sent keep their `transaction_id`, so re-running `sync` or `backfill` over
  days already imported sends no new spend.

### Changed

- Every Revenium CLI now schedules OTLP submissions at most **one per second per process**, retries
  included, whatever `--batch-size` is set to. Pacing was previously derived only from
  `REVENIUM_TARGET_TPS` divided by the batch size, so the default batch of 10 produced 2.5 requests
  per second and a fleet running `backfill` at once could offer many times the per-API-key ceiling
  the platform enforces. Retries skipped the pacing entirely, so a run that started hitting 429s sent
  its next attempt 500 to 1000 ms later, hardest exactly when the service was already rejecting it.

  **Imports with a batch size under 25 now take longer.** Throughput on those runs is one batch per
  second, so the default batch of 10 carries 10 records per second instead of 25 and a long import
  takes about 2.5 times as long. `--batch-size 25` or higher restores the previous duration and sends
  no more data than before: a batch of 100 still paces one request every four seconds, unchanged.
  Nothing sends more data than it did.

  `REVENIUM_TARGET_TPS` is a records-per-second budget on batched sends and is documented as such; it
  was described as requests per second, which is what the new ceiling actually governs. On paths that
  send without a batch size — the Cursor and Copilot sync loops, `test`, `status` and the health
  check — it has always metered requests rather than records, and the one-second ceiling now governs
  them instead.

- `revenium-cursor setup` now stores the Cursor admin API key as `REVENIUM_CURSOR_API_KEY` instead of
  `CURSOR_API_KEY`. The old name is the one Cursor's own tools read, so a machine set up by an earlier
  version exported an organization-wide admin key into every Cursor process, and overwrote a
  developer's personal `CURSOR_API_KEY`. The first `revenium-cursor` command run after upgrading
  renames that single assignment in `~/.cursor/revenium/revenium.env` and `revenium.fish` and says
  so; every other line in those files, comments included, is left as written. Terminals opened
  before that still carry the old exported value until they are restarted. A file that carries both
  names has the leftover `CURSOR_API_KEY` assignment removed, and a file whose rewrite fails is
  named and retried on the next command. A hand-written configuration file that still uses
  `CURSOR_API_KEY` keeps working and is renamed the same way. The `--cursor-api-key` flag is
  unchanged.

- `revenium-cursor` now reads 1000 usage events per Cursor request instead of 100, Cursor's
  documented maximum, so a backfill or sync covering the same history makes a tenth of the requests
  and finishes roughly ten times faster at the unchanged 7.5s pacing. Set `CURSOR_PAGE_SIZE` in the
  shell environment to read smaller pages, for instance if requests to Cursor time out on a large
  team; values above 1000 are clamped, and a value that is not a positive whole number of events is
  rejected with a warning rather than silently shrinking the page. This is the Cursor read page size
  only and does not change how many records are sent to Revenium per batch.

- `revenium-cursor` now fails the run when Cursor returns an empty page while still reporting more
  pages. That window is read only in part, so `sync` keeps its watermark where it was and retries the
  window next cycle instead of moving past events it never read, and `backfill` exits non-zero so the
  range can be re-run. Previously the run finished as a success and the missing events were never
  fetched again.

- `revenium-cursor backfill` and `revenium-copilot backfill` now send each batch as it is fetched
  instead of holding the whole history in memory and sending at the end, so a long import no longer
  grows without bound and a failure partway keeps everything already sent. A run that stops early
  reports what was imported and exits non-zero, including in `--dry-run`, where the summary is
  labelled as partial instead of reading as a finished preview.

- For `revenium-copilot backfill`, `--batch-size` now counts breakdown records rather than days, so
  a large organisation produces more batches per day of history and `--delay` is applied to each of
  them. A 28-day import of a busy organisation therefore takes longer and makes more HTTP requests
  than before at the same `--delay`. Lower `--delay` or raise `--batch-size` (max 100) to restore
  the previous pace. `revenium-cursor backfill` already counted records and is unchanged.

- **BREAKING** — The exported `verifyApiKey(endpoint, apiKey)` now throws when the endpoint cannot be reached,
  instead of returning `false`. A key the endpoint answers for and rejects still returns `false`,
  so an unreachable proxy or an untrusted certificate is no longer reported as an invalid key.
  No shipped command changes behaviour; code using the package as a library and branching on
  `false` has to catch the rejection to keep treating a transport failure as a failed verification.
  Because this breaks a published contract, the next release carrying it has to be a major version.

- All five CLIs now send their traffic through the proxy named by `HTTP_PROXY`, `HTTPS_PROXY` and
  `NO_PROXY`, so a machine that only reaches the internet through a corporate proxy can use them.
  Connection failures now name the code behind them and the variable to set — an untrusted chain
  points at `NODE_EXTRA_CA_CERTS`, a rejected `CONNECT` tunnel at proxy credentials — instead of
  reporting a bare `fetch failed`. With no proxy variable set the connection path is unchanged.

### Fixed

- The ticket pattern saved in the configuration file by `setup --ticket-id-regex` is now honoured
  by `ticket launch`, `ticket switch` and `ticket-gate associate`, including the `--split` specs
  parsed by the CLI. An organization whose keys do not look like `PROJECT-123` previously had every
  one of its real ticket ids rejected as invalid unless `REVENIUM_TICKET_REGEX` was exported in
  every shell, so those sessions went unattributed. A rejection message now names the pattern
  actually in force instead of always suggesting `PROJECT-123`. A pattern provisioned centrally
  through Claude Code managed settings is still read only by the plugin's gate, not by this CLI.
  `REVENIUM_TICKET_REGEX` still wins over the saved pattern, and a saved pattern the CLI cannot
  apply — one that does not compile, or one a setup from an earlier version stored in lowercase —
  falls back to the default instead of rejecting every ticket id.

- `setup --ticket-id-regex` now refuses a pattern it could never apply instead of storing it and
  printing "Setup complete!": one that does not compile as a regular expression, and one written in
  lowercase, which matches nothing because ticket ids are uppercased before they are checked. The
  first silently left the whole organization on the default `PROJECT-123` pattern; the second
  rejected every real ticket id on every machine that ran setup. A pattern that merely contains
  lowercase text — in an alternative branch, an optional group or a lookahead — is still accepted,
  since an uppercase id can match it.

- The README no longer advertises a `--cost-multiplier` option for `revenium-gemini setup`. The
  command never defined it, so following the documentation ended in
  `error: unknown option '--cost-multiplier'`. No pricing behaviour changes: nothing in the CLI ever
  sent a multiplier. The README command tables are now checked against the options each command
  actually defines, so a documented-but-unsupported flag fails the test suite.

- `revenium-metering ticket switch` now exits non-zero when it attributes no session — when no live
  session was found for the directory, and when several live sessions share it and the command
  refuses to guess. Scripts and agents that read the exit status no longer treat those runs as a
  successful switch. Messages, the directory hint it writes and the one-session path are unchanged.

- Cursor and GitHub Copilot `sync` no longer re-send records they already delivered once an
  organization produces more than 10,000 records inside a sync window. The list of delivered records
  was capped at a fixed count, so a larger window pushed the oldest entries out and every cycle
  re-sent them. The delivered records are now remembered per UTC day and pruned by the start of the
  window the next cycle re-reads, so a cycle with nothing new upstream sends nothing, at any
  organization size. The first cycle after this upgrade re-sends the current window once, because the
  previously stored list carries no day information and is dropped; every cycle after it sends
  nothing. The stored state is bounded by the days the sync window covers rather than by total
  history, and is written once per cycle.

- GitHub Copilot usage of a day whose billing lookup failed is no longer imported at zero cost as if
  it were free. `sync` and `backfill` now withhold the cost-bearing records of that day, name the day
  with the reason the billing call failed — including, for a 401 or 403 that is not a rate limit, the
  exact token permissions required — and exit non-zero instead of reporting success. `sync`
  additionally holds its window at the earliest withheld day, so those days are imported by the first
  run whose token can read billing. Pass `--allow-missing-billing` to either command to import that
  usage at zero cost instead, when the token will never be able to read billing; the report then
  names how many records of that day were imported at zero cost, so that zero is never read as a
  measured one. Records without
  cost, such as completions and CLI usage, are still imported. A day whose billing genuinely totals
  zero, and an organization whose plan does not expose AI credit billing at all, are imported exactly
  as before.

- An endpoint that carries a path — `https://gateway.example.com/revenium`, as a metering gateway
  or reverse proxy in front of Revenium requires — now keeps that path everywhere, per tool:
  - Codex CLI: setup stored only the scheme and host, so the exporter wrote to
    `https://gateway.example.com/meter/v2/otlp/v1/logs` and no usage ever arrived. Re-run `setup`
    with the full address to repair an installation configured this way.
  - Claude Code and Gemini CLI: live usage already arrived, but `test`, `status`, `backfill` and
    session ticket attribution dropped the path when reading the saved configuration, and `test`
    could report success against whatever answered at the host root. Upgrading fixes this with no
    setup re-run. Ticket attribution now posts to `<your-path>/profitstream`; set
    `REVENIUM_MGMT_ENDPOINT` if your gateway serves the management API elsewhere.
  - Cursor and GitHub Copilot: unaffected, both already posted under the configured path.

  An endpoint with no path behaves exactly as before. An address already ending in the Revenium
  metering path, with or without a trailing `/v1/logs`, is normalized rather than doubled, and a
  path prefix that merely looks like one of those suffixes is left intact.

- Cursor and GitHub Copilot usage fetched while Revenium is unreachable is no longer lost. A sync
  cycle now remembers an event only after Revenium accepted the batch carrying it, and leaves the
  sync window where it was whenever any batch of the cycle failed, so the next cycle fetches and
  resends exactly the usage that did not get through. Previously a single failed send — a timeout, a
  503, or an expired API key answering 403 — marked those events as already handled and advanced the
  window past them, so they never reached Revenium and the spend was missing from the dashboard
  until a `reset`. Events accepted before a mid-cycle failure are kept and are not sent twice, and a
  resent event carries the same transaction id as the attempt that failed, so a replay is
  identifiable. The window the next cycle retries is the one the failed cycle actually fetched, so a
  failed first run retries its own first-run window rather than widening into a full backfill, and a
  failed `sync --from <date>` keeps that historical range open instead of dropping it. A held window
  never reaches further back than the provider keeps usage available — 28 days for GitHub Copilot,
  30 days for Cursor — so a long outage cannot grow a cycle without bound. A `sync` run that Revenium refused now exits non-zero instead of reporting success, so a
  cron job can tell a failed cycle from an idle one. `--dry-run` still writes no state at all.

- GitHub Copilot cost is now imported for models whose billing name is spelled differently from
  their usage name, such as `Claude Sonnet 4.6` against `claude-sonnet-4.6` or `Auto: Gemini 3 Pro`
  against `gemini-3-pro`. Previously only models whose two spellings matched exactly carried a
  cost, so imported Copilot spend read far below the GitHub bill. Billing lines that still match no
  usage row are printed by `sync` and `backfill` with GitHub's own spelling and their amount instead
  of being dropped silently, including when the day has no metrics report at all and when the run
  fails partway. Only the amount GitHub actually charges is imported, so usage covered by the
  plan's included credits no longer inflates reported spend, and days whose billing data could not
  be read are named instead of passing as free. To correct days already imported, run
  `revenium-copilot reset` before the next `sync` — the local sync state otherwise skips them.
  Record identity is unchanged by this fix, so a re-import carries the same transaction ids as the
  original import.

- Gemini CLI usage now reaches Revenium. `revenium-gemini setup` wrote the API key as an
  `OTEL_RESOURCE_ATTRIBUTES` entry, which Gemini never turns into a request header, so every export
  was rejected with 403 and no usage was recorded — while setup still printed "API key validated"
  because it validated an unrelated request of its own. The key is now written as
  `OTEL_EXPORTER_OTLP_HEADERS=x-api-key=<key>`, and setup only claims validation after the exact URL
  in the written configuration returns 200 having processed at least one event; otherwise it fails
  and writes nothing. A configuration written before this change still meters correctly through the
  wrapper — its key is read back from the resource attribute and sent as the header — and `status`
  and `test` report it as outdated and ask for `setup` to be re-run.

- The Gemini API key is no longer exported into the interactive shell. `~/.gemini/revenium.env` is
  now a plain `KEY=value` file with no `export` lines, read only by `revenium-gemini run`, so a
  shell profile left sourcing it by an earlier install can no longer place the key in
  `OTEL_EXPORTER_OTLP_HEADERS` for every other OpenTelemetry-instrumented program in the session.
  `setup` also removes its block from the profiles of the shells it is not configuring. The
  separate `~/.gemini/revenium.fish` file is no longer written, since nothing sources it.

- `revenium-codex backfill` now sends one record per Codex model call instead of one per conversation
  turn. A turn that ran several model calls previously collapsed into a single record whose token
  figures were the per-category maximum across those calls, so backfilled agentic sessions reported a
  small fraction of their real spend. Each record's input, output, cached and reasoning figures now
  come from a single call's usage. Each record's `transaction_id` is now derived from the identity of
  the call itself rather than from the snapshot that happened to be retained, so re-running,
  resuming an interrupted run, or backfilling overlapping date windows sends no duplicates.
  Sessions recorded in the older `response.completed` schema keep the `transaction_id` they had in
  1.3.0 and are therefore safe to re-send. Every record that comes from the current Codex schema
  gets a new `transaction_id`, not only the turns that ran several model calls: a window already
  backfilled by 1.3.0 or earlier will carry both the old under-counted records and the new per-call
  ones unless the whole window is removed before re-running.

## [1.3.0] - 2026-09-21

### Changed

- `revenium-metering setup` now removes a ticket gate hook left behind by an earlier release,
  from `~/.claude/settings.json` and `~/.cursor/hooks.json`, and deletes
  `~/.revenium/hooks/ticket-gate.sh`. It matches that exact path, so a gate registered anywhere
  else — the plugin's own, or one pushed by MDM — is left alone. The script is deleted only once
  no settings file still names it; if one cannot be read or rewritten, setup keeps the script,
  names that file, and asks you to fix it and re-run. Claude Code's machine-wide managed settings
  are read for that decision too and never rewritten: a fleet whose managed settings still
  register the old hook keeps the script, and setup names the file to hand to whoever manages it.
- `revenium-cursor sync` reports itself as deprecated in `--help`, as `revenium-copilot sync`
  already did. Both were deprecated in 1.2.0, but only the Copilot command said so before running.
  Behaviour is unchanged: `sync` still works until `2.0.0`, and the runtime notice is the same.
- The README states where this CLI fits before it describes the setup wizard. An
  organization-wide Claude Code rollout is delivered through centrally-managed settings and needs
  no per-developer install; the CLI covers historical backfill and individual onboarding. The
  GitHub Copilot credential permissions now match what the published
  documentation states, and the Node badge names the `engines` floor of 20.19 rather than a
  looser `20+` that `npm install` would reject.

## [1.2.0] - 2026-09-10

### Added

- `revenium-metering setup` writes `OTEL_LOG_TOOL_DETAILS=1` to `~/.claude/revenium.env` and
  `~/.claude/revenium.fish`. Claude Code redacts the skill name on its `skill_activated` telemetry
  event without it, so plugin skill usage reached Revenium as an unnamed `custom_skill`. The flag
  also exports tool inputs (for example `Bash` command text and MCP tool names); it does not export
  prompts or model output. Pass `--no-log-tool-details` to opt out.
- `revenium-metering status --fix` appends `OTEL_LOG_TOOL_DETAILS=1` to a config written before the
  flag existed. Idempotent, and it leaves an explicit `OTEL_LOG_TOOL_DETAILS=0` opt-out alone.
- `revenium-metering status` reports skill name attribution, e.g.
  `Skill names: redacted (OTEL_LOG_TOOL_DETAILS unset)`, distinguishing a config that lacks the flag
  from a shell that has not sourced it.

### Deprecated

- `revenium-copilot sync` and `revenium-cursor sync` (including `--watch`). Both will be removed in
  `2.0.0`. Register the credential under Connections > Providers in the Revenium dashboard instead;
  Revenium then syncs it server-side with no local process left running. `backfill`, `status`,
  `test` and `reset` are unaffected.

### Changed

- `revenium-copilot setup` no longer prompts for or stores a GitHub personal access token. The
  Copilot credential is managed in the Revenium dashboard. CLI commands that read the GitHub API
  (`backfill`, `sync`) now take it per invocation via `--github-token` / `--github-org` or the
  `GITHUB_TOKEN` / `GITHUB_ORG` environment variables, and fail with an actionable message when it
  is absent.
- `revenium-copilot status` reports the GitHub connectivity check only when a GitHub credential is
  supplied, and explains where the credential lives otherwise.

### Removed

- `--github-token` and `--github-org` options on `revenium-copilot setup`, and the setup-time GitHub
  connectivity gate.

## [1.1.13] - 2026-08-27

Maintenance release. No functional changes to the CLI.

## [1.1.12] - 2026-08-17

### Removed

- Ticket attribution hooks (`revenium-metering ticket`, ticket gate hook, session state, Linear resolver) pending internal testing

### Fixed

- `revenium-metering setup` now removes the ticket gate hook installed by 1.1.11 from `~/.claude/settings.json` and deletes its script, so upgraded users are not blocked by a hook whose commands no longer exist

## [1.1.11] - 2026-08-13

### Added

- Claude Code ticket launcher and local ticket gate with branch inference,
  explicit in-session switching, required opt-out reasons, organization ticket
  patterns, configurable blocking policy, and managed-settings deployment.
- Session-attribution client for the synchronous management API, including an
  optional `REVENIUM_TEAM_ID` compatibility override.

### Fixed

- Keep concurrent Claude Code sessions isolated when they share a working
  directory, and retry unconfirmed attribution writes without allowing stale
  network workers to overwrite active session state.
- Make attribution retries idempotent after a response is lost.

## [1.1.10] - 2026-07-30

### Fixed

- Backfill deduplication: merge per-category max tokens instead of selecting by aggregate, prefer richer records, align model fallback

### Added

- Emit skill and tool details in Claude Code backfill OTLP logs

## [1.1.9] - 2026-07-23

### Fixed

- Global rate limiter: move `enforceRateLimit` into `sendOtlpRequest` so all providers (Claude Code, Cursor, Copilot, Codex) get automatic pacing without manual wiring
- Cursor `backfill` now paces its Cursor Admin API fetches (default ~8 req/min, under Cursor's documented 60 req/min limit for `/teams/filtered-usage-events`) so historical pulls no longer trip Cursor's rate limiter (429). Tunable via `--fetch-delay <ms>` or `CURSOR_MIN_REQUEST_INTERVAL_MS`
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

[2.0.0]: https://github.com/revenium/revenium-cli-node/releases/tag/v2.0.0
[1.3.0]: https://github.com/revenium/revenium-cli-node/releases/tag/v1.3.0
[1.2.0]: https://github.com/revenium/revenium-cli-node/releases/tag/v1.2.0
[1.1.13]: https://github.com/revenium/revenium-cli-node/releases/tag/v1.1.13
[1.1.12]: https://github.com/revenium/revenium-cli-node/releases/tag/v1.1.12
[1.1.11]: https://github.com/revenium/revenium-cli-node/releases/tag/v1.1.11
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
