#!/usr/bin/env bash

set -uo pipefail

INPUT=$(cat 2>/dev/null || true)

if ! command -v jq >/dev/null 2>&1; then
  case "$INPUT" in
    *'"SessionStart"'*) exit 0 ;;
  esac
  if [[ -n "$INPUT" ]]; then
    printf '%s' '{"systemMessage":"[Revenium] jq not found on PATH — the ticket gate is inactive and prompts are passing through unmetered. Install jq to restore attribution."}'
  fi
  exit 0
fi

SESSION_ID=$(jq -r '.session_id // empty' <<<"$INPUT" 2>/dev/null || true)
CWD=$(jq -r '.cwd // empty' <<<"$INPUT" 2>/dev/null || true)
EVENT=$(jq -r '.hook_event_name // "UserPromptSubmit"' <<<"$INPUT" 2>/dev/null || echo "UserPromptSubmit")
PROMPT=$(jq -r '.prompt // empty' <<<"$INPUT" 2>/dev/null || true)
PROMPT_HAS_NEWLINE=$(jq -r '(.prompt // "") | contains("\n")' <<<"$INPUT" 2>/dev/null || echo "false")
STATE_DIR="${HOME}/.revenium/ticket-state"
METERING_BIN="${REVENIUM_METERING_BIN:-revenium-metering}"
readonly DEFAULT_TICKET_PATTERN='[A-Za-z][A-Za-z0-9_]{0,63}-[0-9]{1,10}'
CONFIGURED_PATTERN="${REVENIUM_TICKET_REGEX:-$DEFAULT_TICKET_PATTERN}"
CONFIGURED_PATTERN="${CONFIGURED_PATTERN#^}"
CONFIGURED_PATTERN="${CONFIGURED_PATTERN%\$}"
EXTRACT_PATTERN="$CONFIGURED_PATTERN"

is_session_start() { [[ "$EVENT" == "SessionStart" ]]; }

block() {
  if is_session_start; then exit 0; fi
  printf '%s' "$(jq -n --arg r "$1" '{decision:"block",reason:$r}')"
  exit 0
}

notice() {
  if is_session_start; then exit 0; fi
  printf '%s' "$(jq -n --arg m "$1" '{systemMessage:$m}')"
  exit 0
}

allow() { exit 0; }

sanitize_id() {
  local value="$1"
  printf '%s' "${value//[^a-zA-Z0-9_-]/_}"
}

session_file() {
  local safe
  safe=$(sanitize_id "$SESSION_ID")
  printf '%s' "${STATE_DIR}/session-${safe}.json"
}

repo_file() {
  local key
  if command -v shasum >/dev/null 2>&1; then
    key=$(printf '%s' "$CWD" | shasum -a 256 2>/dev/null) || return 1
    key="${key%% *}"
  elif command -v sha256sum >/dev/null 2>&1; then
    key=$(printf '%s' "$CWD" | sha256sum 2>/dev/null) || return 1
    key="${key%% *}"
  elif command -v openssl >/dev/null 2>&1; then
    key=$(printf '%s' "$CWD" | openssl dgst -sha256 2>/dev/null) || return 1
    key="${key##* }"
  else
    return 1
  fi
  key=$(printf '%s' "$key" | tr '[:upper:]' '[:lower:]')
  [[ "$key" =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s' "${STATE_DIR}/repo-${key}.json"
}

association_pending_file() {
  local safe_session safe_ticket
  safe_session=$(sanitize_id "$SESSION_ID")
  safe_ticket=$(sanitize_id "$1")
  printf '%s' "${STATE_DIR}/association-pending-${safe_session}-${safe_ticket}.txt"
}

ticket_is_valid() {
  local candidate="$1"
  [[ "$candidate" == "none" ]] && return 0
  [[ "$candidate" =~ ^(${CONFIGURED_PATTERN})$ ]]
}

adopt_session_ticket() {
  local ticket="$1" title="${2:-}" reason="${3:-}"
  [[ -n "$SESSION_ID" ]] || return 0
  mkdir -p "$STATE_DIR" 2>/dev/null || return 0

  local sfile pfile posted="" should_post=0
  sfile=$(session_file)
  pfile=$(association_pending_file "$ticket")
  if [[ -f "$sfile" ]]; then
    posted=$(jq -r '.postedTicketId // empty' "$sfile" 2>/dev/null || true)
  fi

  local now
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  jq -n --arg t "$ticket" --arg tt "$title" --arg r "$reason" --arg at "$now" \
        --arg sid "$SESSION_ID" --arg p "$ticket" --arg cwd "$CWD" \
    '{ticketId:$t,ticketTitle:$tt,reason:$r,associatedAt:$at,sessionId:$sid,postedTicketId:$p,cwd:$cwd}' \
    > "$sfile" 2>/dev/null || true

  local now_epoch last_attempt=0
  now_epoch=$(date +%s)
  if [[ "$posted" != "$ticket" ]]; then
    should_post=1
  elif [[ -f "$pfile" ]]; then
    last_attempt=$(cat "$pfile" 2>/dev/null || echo 0)
    if ! [[ "$last_attempt" =~ ^[0-9]+$ ]] || (( now_epoch - last_attempt >= 5 )); then
      should_post=1
    fi
  fi

  if (( should_post == 1 )); then
    printf '%s' "$now_epoch" > "$pfile" 2>/dev/null || true
    if command -v "$METERING_BIN" >/dev/null 2>&1; then
      local args=(ticket-gate associate --session-id "$SESSION_ID" --ticket "$ticket")
      [[ -n "$title" ]] && args+=(--title "$title")
      [[ -n "$reason" ]] && args+=(--reason "$reason")
      [[ -n "$CWD" ]] && args+=(--cwd "$CWD")
      nohup "$METERING_BIN" "${args[@]}" >/dev/null 2>&1 &
    fi
  fi
  return 0
}

if [[ "$EVENT" == "UserPromptSubmit" && -n "$SESSION_ID" ]]; then
  TRIMMED=$(printf '%s' "$PROMPT" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  shopt -s nocasematch
  if [[ "$PROMPT_HAS_NEWLINE" != "true" && "$TRIMMED" != *$'\n'* ]] && [[ "$TRIMMED" =~ ^switch-ticket[[:space:]]+([^[:space:]]+)([[:space:]]+--reason[[:space:]]+(.+))?$ ]]; then
    RAW_MATCH="${BASH_REMATCH[1]}"
    DIRECTIVE_REASON="${BASH_REMATCH[3]:-}"
    RAW_MATCH_LOWER=$(printf '%s' "$RAW_MATCH" | tr '[:upper:]' '[:lower:]')
    if [[ "$RAW_MATCH_LOWER" == "none" ]]; then
      if [[ -z "$DIRECTIVE_REASON" ]]; then
        shopt -u nocasematch
        block "[Revenium] Explicit opt-out requires a reason. Type: switch-ticket none --reason <reason>"
      fi
      DIRECTIVE_TICKET="none"
    else
      DIRECTIVE_TICKET=$(printf '%s' "$RAW_MATCH" | tr '[:lower:]' '[:upper:]')
    fi
    shopt -u nocasematch
    if ! ticket_is_valid "$DIRECTIVE_TICKET"; then
      block "[Revenium] $DIRECTIVE_TICKET does not match this organization's ticket ID policy."
    fi
    adopt_session_ticket "$DIRECTIVE_TICKET" "" "$DIRECTIVE_REASON"
    block "[Revenium] Switched ticket attribution to $DIRECTIVE_TICKET for this session. This directive was not sent to the model — type your next prompt normally."
  fi
  shopt -u nocasematch
fi

SESSION_TICKET=""; SESSION_TITLE=""; SESSION_REASON=""

if [[ -n "$SESSION_ID" ]]; then
  SFILE=$(session_file)
  if [[ -f "$SFILE" ]]; then
    SESSION_TICKET=$(jq -r '.ticketId // empty' "$SFILE" 2>/dev/null || true)
    SESSION_TITLE=$(jq -r '.ticketTitle // empty' "$SFILE" 2>/dev/null || true)
    SESSION_REASON=$(jq -r '.reason // empty' "$SFILE" 2>/dev/null || true)
  fi
fi

if [[ -n "$SESSION_TICKET" ]]; then
  adopt_session_ticket "$SESSION_TICKET" "$SESSION_TITLE" "$SESSION_REASON"
  allow
fi

if [[ -n "${REVENIUM_TICKET:-}" ]]; then
  adopt_session_ticket "$REVENIUM_TICKET" "${REVENIUM_TICKET_TITLE:-}"
  allow
fi

REPO_TICKET=""; REPO_TITLE=""; REPO_REASON=""

if [[ -n "$CWD" ]]; then
  RFILE=""
  if RFILE=$(repo_file) && [[ -f "$RFILE" ]]; then
    REPO_TICKET=$(jq -r '.ticketId // empty' "$RFILE" 2>/dev/null || true)
    REPO_TITLE=$(jq -r '.ticketTitle // empty' "$RFILE" 2>/dev/null || true)
    REPO_REASON=$(jq -r '.reason // empty' "$RFILE" 2>/dev/null || true)
  fi
fi

if [[ -n "$REPO_TICKET" ]]; then
  adopt_session_ticket "$REPO_TICKET" "$REPO_TITLE" "$REPO_REASON"
  allow
fi

if [[ -n "${REVVIE_AUTONOMOUS:-}" ]] || [[ -n "${REVENIUM_AUTONOMOUS:-}" ]]; then
  allow
fi

SUGGEST=""
if [[ -n "$CWD" ]] && command -v git >/dev/null 2>&1; then
  BRANCH=$(git -C "$CWD" branch --show-current 2>/dev/null || true)
  if [[ -z "$BRANCH" ]]; then
    BRANCH=$(git -C "$CWD" symbolic-ref --short HEAD 2>/dev/null || true)
  fi
  if [[ -n "$BRANCH" ]]; then
    SUGGEST=$(grep -oiE "$EXTRACT_PATTERN" <<<"$BRANCH" \
      | head -1 | tr '[:lower:]' '[:upper:]' || true)
    if [[ -n "$SUGGEST" ]] && ! ticket_is_valid "$SUGGEST"; then
      SUGGEST=""
    fi
  fi
fi

AUTO_ASSOCIATE="${REVENIUM_TICKET_AUTO_ASSOCIATE:-true}"
if [[ -n "$SUGGEST" && -n "$SESSION_ID" \
      && "$AUTO_ASSOCIATE" != "false" && "$AUTO_ASSOCIATE" != "0" ]]; then
  adopt_session_ticket "$SUGGEST" ""
  notice "[Revenium] Metering against $SUGGEST (inferred from branch) — type switch-ticket <ID> to change"
fi

if [[ "$EVENT" == "UserPromptSubmit" && -n "$SESSION_ID" && -n "$PROMPT" ]]; then
  PROMPT_TICKET=$(grep -oiE "$EXTRACT_PATTERN" <<<"$PROMPT" \
    | head -1 | tr '[:lower:]' '[:upper:]' || true)
  if [[ -n "$PROMPT_TICKET" ]] && ticket_is_valid "$PROMPT_TICKET"; then
    if [[ -n "${REVENIUM_TICKET_REGEX:-}" ]]; then
      adopt_session_ticket "$PROMPT_TICKET" ""
      notice "[Revenium] Metering against $PROMPT_TICKET (detected in your message) — type switch-ticket <ID> to change"
    else
      notice "[Revenium] Detected $PROMPT_TICKET in your message — type 'switch-ticket $PROMPT_TICKET' to attribute this session to it."
    fi
  fi
fi

if is_session_start; then
  exit 0
fi

POLICY="${REVENIUM_TICKET_BLOCK_POLICY:-remind-only}"

if [[ "$POLICY" == "remind-only" ]]; then
  MSG="[Revenium] No ticket attribution active. Run: revenium-metering ticket launch <TICKET-ID>"
  if [[ -n "$SUGGEST" ]]; then
    MSG="$MSG (your branch suggests $SUGGEST)"
  fi
  notice "$MSG"
fi

if [[ "$POLICY" =~ ^[0-9]+$ ]]; then
  FREE_N="$POLICY"
  if [[ -n "$SESSION_ID" ]]; then
    SAFE_ID=$(sanitize_id "$SESSION_ID")
    COUNT_FILE="${STATE_DIR}/session-${SAFE_ID}-count.txt"
    CURRENT=0
    if [[ -f "$COUNT_FILE" ]]; then
      CURRENT=$(cat "$COUNT_FILE" 2>/dev/null || echo 0)
    fi
    if (( CURRENT < FREE_N )); then
      NEW_COUNT=$(( CURRENT + 1 ))
      mkdir -p "$STATE_DIR" 2>/dev/null || true
      echo "$NEW_COUNT" > "$COUNT_FILE" 2>/dev/null || true
      REMAINING=$(( FREE_N - NEW_COUNT ))
      MSG="[Revenium] No ticket attribution active ($REMAINING free prompt(s) remaining). Run: revenium-metering ticket launch <TICKET-ID>"
      if [[ -n "$SUGGEST" ]]; then
        MSG="$MSG (branch suggests $SUGGEST)"
      fi
      notice "$MSG"
    fi
  fi
fi

MSG="Revenium ticket attribution is not active for this session. Your work cannot be metered against a ticket until you attribute it.

To launch a new attributed session:
  revenium-metering ticket launch <TICKET-ID>

To switch tickets mid-session (type it as your next prompt, in THIS terminal):
  switch-ticket <TICKET-ID>

To opt out explicitly (creates an unattributed bucket):
  switch-ticket none --reason exploratory-spike"

if [[ -n "$SUGGEST" ]]; then
  MSG="${MSG}

Your branch suggests: revenium-metering ticket launch $SUGGEST"
fi

block "$MSG"
