#!/bin/bash
# safe-upgrade-opencode.sh — Safely upgrade opencode without interrupting active sessions.
# Designed to run unattended at 4am via cron/launchd.

set -euo pipefail

LOG="/tmp/opencode-upgrade.log"
TRACKER_URL="http://localhost:1000"
OPENCODE_URL="http://localhost:3000"
SERVICE_LABEL="com.opencode.server"
TRACK_PROJECT_ID="fc7d6a7e00c1a1a650be2d4d"
MAX_WAIT=600  # 10 minutes
POLL_INTERVAL=15

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') [$1] $2" >> "$LOG"
}

get_token() {
  cat ~/tracker/store/auth_token
}

tracker_api() {
  local method="$1" path="$2"
  shift 2
  curl -sf -X "$method" \
    -H "Authorization: Bearer $(get_token)" \
    -H "Content-Type: application/json" \
    "${TRACKER_URL}/api/v1${path}" "$@"
}

# Count active orchestrator sessions
active_session_count() {
  tracker_api GET /orchestrator/status 2>/dev/null \
    | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('activeSessions',[])))" 2>/dev/null \
    || echo "-1"
}

# Post a failure issue to the TRACK project
report_failure() {
  local title="$1" body="$2"
  log ERROR "Reporting failure to tracker: $title"
  tracker_api POST /items -d "$(python3 -c "
import json, sys
print(json.dumps({
    'project_id': '$TRACK_PROJECT_ID',
    'title': sys.argv[1],
    'description': sys.argv[2],
    'state': 'brainstorming',
    'priority': 'high',
    'assignee': 'Martin',
    'labels': ['ops', 'opencode', 'auto-upgrade'],
    'requires_code': False
}))
" "$title" "$body")" >> "$LOG" 2>&1 || log ERROR "Failed to create tracker issue"
}

# ── Main ─────────────────────────────────────────────────────────────────────

log INFO "=== Starting opencode safe upgrade ==="

# Step 0: Check if an upgrade is even available
brew_output=$(brew outdated opencode 2>&1) || true
if [ -z "$brew_output" ]; then
  log INFO "opencode is already up to date — nothing to do"
  exit 0
fi
log INFO "Upgrade available: $brew_output"

# Step 1: Pause the orchestrator so no new sessions start
log INFO "Pausing orchestrator"
tracker_api POST /orchestrator/pause >/dev/null 2>&1 || log WARN "Could not pause orchestrator (may already be paused)"

# Step 2: Wait for active sessions to finish
elapsed=0
while [ $elapsed -lt $MAX_WAIT ]; do
  count=$(active_session_count)
  if [ "$count" = "0" ]; then
    log INFO "No active sessions"
    break
  fi
  if [ "$count" = "-1" ]; then
    log WARN "Could not query orchestrator status, assuming idle"
    break
  fi
  log INFO "Waiting for $count active session(s) to finish (${elapsed}s/${MAX_WAIT}s)"
  sleep $POLL_INTERVAL
  elapsed=$((elapsed + POLL_INTERVAL))
done

if [ $elapsed -ge $MAX_WAIT ]; then
  log WARN "Timed out waiting for sessions after ${MAX_WAIT}s — proceeding anyway"
fi

# Step 3: Record current version
old_version=$(opencode --version 2>&1 || echo "unknown")
log INFO "Current version: $old_version"

# Step 4: Stop the opencode server
log INFO "Stopping opencode server"
launchctl bootout "gui/$(id -u)/$SERVICE_LABEL" 2>&1 || true
sleep 2

# Step 5: Upgrade via brew
log INFO "Running brew upgrade opencode"
if ! brew upgrade opencode >> "$LOG" 2>&1; then
  log ERROR "brew upgrade failed"
  # Try to restart the old version anyway
  launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.opencode.server.plist 2>&1 || true
  tracker_api POST /orchestrator/resume >/dev/null 2>&1 || true
  report_failure \
    "opencode auto-upgrade failed: brew upgrade error" \
    "## opencode Safe Upgrade Failure\n\n**When:** $(date '+%Y-%m-%d %H:%M:%S')\n**Stage:** brew upgrade\n**Previous version:** $old_version\n\n### brew output\n\`\`\`\n$(tail -30 "$LOG")\n\`\`\`\n\nThe old version has been restarted. Manual intervention needed."
  exit 1
fi

new_version=$(opencode --version 2>&1 || echo "unknown")
log INFO "Upgraded to: $new_version"

# Step 6: Restart the opencode server
log INFO "Starting opencode server"
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.opencode.server.plist 2>&1 || true
sleep 3

# Step 7: Verify it's working
healthy=false
for attempt in 1 2 3 4 5; do
  http_code=$(curl -s -o /dev/null -w "%{http_code}" "$OPENCODE_URL" 2>/dev/null || echo "000")
  if [ "$http_code" = "200" ]; then
    healthy=true
    log INFO "Health check passed (attempt $attempt)"
    break
  fi
  log WARN "Health check attempt $attempt: HTTP $http_code"
  sleep 3
done

# Step 8: Resume the orchestrator
log INFO "Resuming orchestrator"
tracker_api POST /orchestrator/resume >/dev/null 2>&1 || log WARN "Could not resume orchestrator"

if [ "$healthy" = true ]; then
  log INFO "=== Upgrade complete: $old_version -> $new_version ==="
  exit 0
fi

# Step 9: Not healthy — report failure
log ERROR "opencode server failed health check after upgrade"
report_failure \
  "opencode auto-upgrade: server not responding after upgrade" \
  "## opencode Safe Upgrade Failure\n\n**When:** $(date '+%Y-%m-%d %H:%M:%S')\n**Stage:** post-upgrade health check\n**Previous version:** $old_version\n**New version:** $new_version\n\nThe opencode server is not responding on $OPENCODE_URL after upgrading and restarting the launchd service.\n\n### Recent log\n\`\`\`\n$(tail -30 "$LOG")\n\`\`\`\n\n### opencode error log\n\`\`\`\n$(tail -20 /tmp/opencode.err 2>/dev/null || echo 'no error log')\n\`\`\`\n\nManual investigation required. Service may need to be restarted or rolled back."
exit 1
