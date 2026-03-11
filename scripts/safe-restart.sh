#!/bin/bash
#
# safe-restart.sh — Safely restart the tracker service
#
# This script is the recommended way to restart the tracker when other agents
# might be running. It:
#
#   1. Optionally builds the TypeScript first (--build flag)
#   2. Checks for active agent sessions via the tracker API
#   3. If sessions are active: pauses the orchestrator, waits for them to finish
#   4. Restarts the service via launchctl
#
# Usage:
#   ./scripts/safe-restart.sh                    # Check and restart
#   ./scripts/safe-restart.sh --build            # Build first, then restart
#   ./scripts/safe-restart.sh --force            # Force restart (skip session check)
#   ./scripts/safe-restart.sh --build --force    # Build and force restart
#   ./scripts/safe-restart.sh --status           # Just check if safe to restart
#
# Environment:
#   TRACKER_URL  — Base URL of the tracker API (default: http://localhost:1000)
#

set -euo pipefail

TRACKER_URL="${TRACKER_URL:-http://localhost:1000}"
API_URL="${TRACKER_URL}/api/v1"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Load auth token from store/auth_token for API calls
AUTH_TOKEN=""
AUTH_TOKEN_FILE="${PROJECT_DIR}/store/auth_token"
if [[ -f "$AUTH_TOKEN_FILE" ]]; then
  AUTH_TOKEN=$(cat "$AUTH_TOKEN_FILE" | tr -d '\n')
fi
AUTH_HEADER=""
if [[ -n "$AUTH_TOKEN" ]]; then
  AUTH_HEADER="Authorization: Bearer ${AUTH_TOKEN}"
fi

BUILD=false
FORCE=false
STATUS_ONLY=false
REASON="Restart via safe-restart.sh"
REQUESTED_BY="${USER:-script}"
MAX_WAIT=300  # 5 minutes max wait in the script itself (API also has a 30-min timeout)
POLL_INTERVAL=5

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --build|-b)
      BUILD=true
      shift
      ;;
    --force|-f)
      FORCE=true
      shift
      ;;
    --status|-s)
      STATUS_ONLY=true
      shift
      ;;
    --reason)
      REASON="$2"
      shift 2
      ;;
    --help|-h)
      echo "Usage: $0 [--build] [--force] [--status] [--reason <text>]"
      echo ""
      echo "Options:"
      echo "  --build, -b     Build TypeScript before restarting"
      echo "  --force, -f     Force restart even if sessions are active"
      echo "  --status, -s    Just check restart safety (don't restart)"
      echo "  --reason <text> Reason for the restart"
      echo "  --help, -h      Show this help"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log() { echo -e "${BLUE}[safe-restart]${NC} $1"; }
warn() { echo -e "${YELLOW}[safe-restart]${NC} $1"; }
error() { echo -e "${RED}[safe-restart]${NC} $1"; }
ok() { echo -e "${GREEN}[safe-restart]${NC} $1"; }

# Authenticated curl wrapper — adds auth token if available
acurl() {
  if [[ -n "$AUTH_HEADER" ]]; then
    curl -H "$AUTH_HEADER" "$@"
  else
    curl "$@"
  fi
}

# Check if tracker is reachable
check_tracker() {
  if ! acurl -sf "${API_URL}/orchestrator/safe-to-restart" > /dev/null 2>&1; then
    error "Tracker API not reachable at ${TRACKER_URL}"
    error "Is the tracker running? Try: launchctl list | grep com.tracker"
    return 1
  fi
}

# Check active sessions
check_sessions() {
  local result
  result=$(acurl -sf "${API_URL}/orchestrator/safe-to-restart" 2>/dev/null)
  if [[ -z "$result" ]]; then
    error "Failed to check session status"
    return 1
  fi

  local safe
  safe=$(echo "$result" | python3 -c "import sys, json; print(json.load(sys.stdin).get('safe', False))" 2>/dev/null)
  local count
  count=$(echo "$result" | python3 -c "import sys, json; print(json.load(sys.stdin).get('activeSessions', 0))" 2>/dev/null)

  if [[ "$safe" == "True" ]]; then
    ok "Safe to restart (0 active sessions)"
    return 0
  else
    warn "NOT safe to restart: ${count} active session(s)"
    return 1
  fi
}

# Status-only mode
if [[ "$STATUS_ONLY" == true ]]; then
  check_tracker || exit 1
  
  log "Checking restart safety..."
  result=$(acurl -sf "${API_URL}/orchestrator/restart" 2>/dev/null)
  echo "$result" | python3 -m json.tool 2>/dev/null || echo "$result"
  
  if check_sessions; then
    ok "Tracker can be safely restarted"
  else
    warn "Active sessions would be interrupted by a restart"
  fi
  exit 0
fi

# Build step
if [[ "$BUILD" == true ]]; then
  log "Building TypeScript..."
  cd "$PROJECT_DIR"
  if npm run build; then
    ok "Build successful"
  else
    error "Build failed — aborting restart"
    exit 1
  fi
fi

# Check tracker is reachable
if ! check_tracker; then
  if [[ "$FORCE" == true ]]; then
    warn "Tracker not reachable — proceeding with force restart anyway"
    log "Restarting via launchctl..."
    launchctl kickstart -k "gui/$(id -u)/com.tracker.server"
    ok "Restart command sent"
    exit 0
  else
    error "Cannot check session safety — use --force to restart anyway"
    exit 1
  fi
fi

# Use the API to request the restart
if [[ "$FORCE" == true ]]; then
  log "Force restart requested..."
  result=$(acurl -sf -X POST "${API_URL}/orchestrator/restart" \
    -H "Content-Type: application/json" \
    -d "{\"force\": true, \"reason\": \"${REASON}\", \"requested_by\": \"${REQUESTED_BY}\"}" 2>/dev/null)
  
  status=$(echo "$result" | python3 -c "import sys, json; print(json.load(sys.stdin).get('status', 'unknown'))" 2>/dev/null)
  message=$(echo "$result" | python3 -c "import sys, json; print(json.load(sys.stdin).get('message', ''))" 2>/dev/null)
  
  if [[ "$status" == "restarting" ]]; then
    ok "$message"
    log "Tracker will restart momentarily..."
  else
    error "Unexpected status: $status — $message"
    exit 1
  fi
else
  # Safe restart: check first, then request
  if check_sessions; then
    # No active sessions — request immediate restart
    log "Requesting restart..."
    result=$(acurl -sf -X POST "${API_URL}/orchestrator/restart" \
      -H "Content-Type: application/json" \
      -d "{\"wait\": true, \"reason\": \"${REASON}\", \"requested_by\": \"${REQUESTED_BY}\"}" 2>/dev/null)
    
    status=$(echo "$result" | python3 -c "import sys, json; print(json.load(sys.stdin).get('status', 'unknown'))" 2>/dev/null)
    message=$(echo "$result" | python3 -c "import sys, json; print(json.load(sys.stdin).get('message', ''))" 2>/dev/null)
    
    ok "$message"
    if [[ "$status" == "restarting" ]]; then
      log "Tracker will restart momentarily..."
    fi
  else
    # Active sessions — request wait-mode restart
    warn "Active sessions detected — requesting safe restart with wait..."
    result=$(acurl -sf -X POST "${API_URL}/orchestrator/restart" \
      -H "Content-Type: application/json" \
      -d "{\"wait\": true, \"reason\": \"${REASON}\", \"requested_by\": \"${REQUESTED_BY}\"}" 2>/dev/null)
    
    status=$(echo "$result" | python3 -c "import sys, json; print(json.load(sys.stdin).get('status', 'unknown'))" 2>/dev/null)
    message=$(echo "$result" | python3 -c "import sys, json; print(json.load(sys.stdin).get('message', ''))" 2>/dev/null)
    
    if [[ "$status" == "waiting" ]]; then
      log "$message"
      log "Polling for completion (max ${MAX_WAIT}s)..."
      
      elapsed=0
      while [[ $elapsed -lt $MAX_WAIT ]]; do
        sleep $POLL_INTERVAL
        elapsed=$((elapsed + POLL_INTERVAL))
        
        # Check restart status
        restart_result=$(acurl -sf "${API_URL}/orchestrator/restart" 2>/dev/null || echo '{}')
        restart_status=$(echo "$restart_result" | python3 -c "import sys, json; d=json.load(sys.stdin); print(d.get('status') or 'unknown')" 2>/dev/null)
        active=$(echo "$restart_result" | python3 -c "import sys, json; print(json.load(sys.stdin).get('activeSessions', '?'))" 2>/dev/null)
        
        if [[ "$restart_status" == "restarting" ]]; then
          ok "All sessions complete — restart in progress!"
          exit 0
        elif [[ "$restart_status" == "None" ]] || [[ "$restart_status" == "null" ]] || [[ "$restart_status" == "unknown" ]]; then
          # Tracker may have already restarted (API is down/reset)
          ok "Tracker appears to have restarted"
          exit 0
        else
          log "Still waiting... (${elapsed}s elapsed, ${active} active session(s), status: ${restart_status})"
        fi
      done
      
      warn "Timed out waiting for sessions to complete after ${MAX_WAIT}s"
      warn "The tracker API is still tracking the restart request (30-min timeout)"
      warn "Use --force to restart immediately, or wait for sessions to finish"
      exit 1
    elif [[ "$status" == "restarting" ]]; then
      ok "$message"
      log "Tracker will restart momentarily..."
    else
      error "Unexpected status: $status — $message"
      exit 1
    fi
  fi
fi
