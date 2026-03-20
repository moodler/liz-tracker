#!/bin/bash
# Ensure we use real node, not bun shims that may be in PATH from other projects
# This is needed because some tools (like opencode-claude-max-proxy) inject bun symlinks
# into /tmp that shadow the real node binary

# Remove any /tmp/bun-* paths from PATH
CLEAN_PATH=$(echo "$PATH" | tr ':' '\n' | grep -v '^/private/tmp/bun-' | grep -v '^/tmp/bun-' | tr '\n' ':' | sed 's/:$//')

# Also ensure /opt/homebrew/bin is in PATH (where real node lives on Apple Silicon)
if [[ -d /opt/homebrew/bin ]] && [[ ! "$CLEAN_PATH" == */opt/homebrew/bin* ]]; then
    CLEAN_PATH="/opt/homebrew/bin:$CLEAN_PATH"
fi

# Execute the command with clean PATH
PATH="$CLEAN_PATH" exec "$@"
