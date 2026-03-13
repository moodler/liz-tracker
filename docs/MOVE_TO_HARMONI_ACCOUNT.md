# Moving Tracker to a `harmoni` macOS User Account

Migration guide for moving the Liz Tracker from the `martin` user account to a dedicated `harmoni` user account.

## Overview

The codebase is already portable — `src/config.ts` uses `os.homedir()` dynamically and all user-specific config lives in `.env` (gitignored) and the launchd plist. No source code changes are required.

**Estimated effort:** 30–60 minutes for a clean migration.

---

## Prerequisites

- Admin access to the Mac
- Node.js available to the `harmoni` user (Homebrew's `/opt/homebrew/bin/node` is shared system-wide, or install separately)

---

## Step-by-Step Migration

### 1. Create the macOS user account

```bash
sudo sysadminctl -addUser harmoni -fullName "Harmoni" -shell /bin/zsh
```

Or use **System Settings → Users & Groups**.

### 2. Copy the project

```bash
sudo cp -R /Users/martin/tracker /Users/harmoni/tracker
sudo chown -R harmoni:staff /Users/harmoni/tracker
```

This includes:
- Source code and `dist/` build output
- `store/tracker.db` (+ `-shm`, `-wal`) — the SQLite database
- `store/attachments/` — uploaded files (~21 subdirectories)
- `store/auth_token` — API bearer token (mode `0600`; or delete it and let it auto-regenerate on first run)
- `logs/` directory

### 3. Install npm dependencies

```bash
# As harmoni user:
cd /Users/harmoni/tracker
npm install
npm run build
```

### 4. Update `.env`

Edit `/Users/harmoni/tracker/.env`:

| Variable | Old (martin) | New (harmoni) |
|---|---|---|
| `OWNER_NAME` | `Martin` | `Harmoni` (or the actual owner name) |
| `HUMAN_ACTORS` | `dashboard,me,martin` | `dashboard,me,harmoni` |
| `ASSISTANT_PROJECT_ROOT` | `~/liz` | `~/liz` (resolves to `/Users/harmoni/liz` automatically) |
| `OPENCODE_SERVER_URL` | `http://192.168.50.19:3000` | Same, or update if OpenCode moves too |
| `OPENCODE_PUBLIC_URL` | `http://10.0.0.1:3000` | Same, or update |
| `WEBHOOK_URL` | `http://127.0.0.1:9851/webhook` | Same, or update |
| `WEBHOOK_SECRET` | (existing hash) | Regenerate or keep |
| `TRACKER_API_TOKEN` | (auto-generated) | Delete from `.env` to auto-regenerate, or set explicitly |

### 5. Create launchd plist

Create `/Users/harmoni/Library/LaunchAgents/com.tracker.server.plist` with all paths pointing to `/Users/harmoni/`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.tracker.server</string>

    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/node</string>
        <string>/Users/harmoni/tracker/dist/index.js</string>
    </array>

    <key>WorkingDirectory</key>
    <string>/Users/harmoni/tracker</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>/Users/harmoni</string>
        <key>ORCHESTRATOR_ENABLED</key>
        <string>true</string>
    </dict>

    <key>StandardOutPath</key>
    <string>/Users/harmoni/tracker/logs/tracker.log</string>

    <key>StandardErrorPath</key>
    <string>/Users/harmoni/tracker/logs/tracker.error.log</string>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
```

> **Note:** Verify the exact plist structure against martin's original at
> `/Users/martin/Library/LaunchAgents/com.tracker.server.plist` — there may be
> additional keys (e.g. `ThrottleInterval`, `Nice`, resource limits).

Bootstrap the service:

```bash
# As harmoni user:
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.tracker.server.plist
```

### 6. Copy OpenCode agent config

The orchestrator reads the worker agent definition from:

```
~/.config/opencode/agents/tracker-worker.md
```

Copy it to harmoni's home:

```bash
sudo mkdir -p /Users/harmoni/.config/opencode/agents
sudo cp /Users/martin/.config/opencode/agents/tracker-worker.md \
        /Users/harmoni/.config/opencode/agents/tracker-worker.md
sudo chown -R harmoni:staff /Users/harmoni/.config/opencode
```

### 7. Copy assistant API token (if shared)

The tracker also checks `~/.config/assistant/.env` for `TRACKER_API_TOKEN`. If this file exists under martin, copy it:

```bash
sudo mkdir -p /Users/harmoni/.config/assistant
sudo cp /Users/martin/.config/assistant/.env \
        /Users/harmoni/.config/assistant/.env
sudo chown -R harmoni:staff /Users/harmoni/.config/assistant
```

Or skip this — the tracker auto-generates a token at `store/auth_token` on first run.

### 8. Set up project repos

`ASSISTANT_PROJECT_ROOT` uses `os.homedir()` for tilde expansion, so `~/liz` resolves to `/Users/harmoni/liz`. Either:

- Clone/copy the project repos to `/Users/harmoni/liz`
- Or set `ASSISTANT_PROJECT_ROOT` to an absolute path pointing wherever the repos live

### 9. Handle privileged port (port 1000)

macOS restricts ports below 1024. Options:

- **Use a port ≥ 1024** (e.g. 1000 is fine on recent macOS versions with relaxed restrictions, but test it)
- **Use `pfctl` port forwarding** from 1000 → a higher port
- **Run the launchd job with elevated privileges** (not recommended for a user agent)

Test by starting the service and checking if it binds successfully.

### 10. Decommission on martin

```bash
# As martin user:
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.tracker.server.plist

# Optionally remove or archive:
# mv ~/tracker ~/tracker.archived
```

---

## What's Already Portable (No Changes Needed)

| Component | Why it works |
|---|---|
| `src/config.ts` | Uses `os.homedir()` dynamically — no hardcoded username |
| Database paths | Relative to `STORE_DIR` (defaults to `./store`) |
| `scripts/safe-restart.sh` | Uses `$(id -u)` dynamically, not a hardcoded UID |
| Tilde expansion | `~/` in `.env` values resolves to the running user's home |
| API server | Binds to `0.0.0.0:1000` — works regardless of user |

## User-Specific Locations to Update

| Location | Hardcoded references |
|---|---|
| `.env` | `OWNER_NAME`, `HUMAN_ACTORS`, `ASSISTANT_PROJECT_ROOT`, network URLs |
| LaunchAgents plist | 6 references to `/Users/martin/` (program path, working dir, HOME, logs) |
| `~/.config/opencode/agents/tracker-worker.md` | Agent definition read by orchestrator |
| `~/.config/assistant/.env` | Optional shared API token |
| `.claude/settings.local.json` | Claude Code permission rules with hardcoded paths (only matters if using Claude Code under harmoni) |

## Potential Complications

### OpenCode service
If OpenCode (port 3000) also runs under martin, you need to decide:
- **Keep it on martin** — the tracker can still reach it over HTTP, just keep the same `OPENCODE_SERVER_URL`
- **Move it to harmoni** — separate migration, separate launchd plist

### Webhook service
Whatever listens on `127.0.0.1:9851` needs to be running or accessible from the harmoni user.

### Database actor history
Existing transitions in the database reference `actor="martin"` or `actor="dashboard"`. These are historical records and don't need updating, but new human actions will use whatever `HUMAN_ACTORS` is set to.

### Claude Code settings
If using Claude Code under the harmoni account, `.claude/settings.local.json` contains hardcoded paths like:
```
Bash(sqlite3 /Users/martin/tracker/store/tracker.db ...)
Read(//Users/martin/tracker/**)
```
These permission rules would need updating to `/Users/harmoni/tracker/`.
