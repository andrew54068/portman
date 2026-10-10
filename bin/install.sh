#!/bin/sh
# Installs this checkout as the portman everyone uses (the CLI, the Claude Code hook, the dashboard, the status page).
# macOS won't let a launchd job read ~/Documents, so the runtime is copied to ~/.local/share/portman and the status
# page runs from there. Re-run after changing the code here.
set -eu
src=$(cd "$(dirname "$0")/.." && pwd)
dest="$HOME/.local/share/portman"
label=com.dawson.portman
plist="$HOME/Library/LaunchAgents/$label.plist"
node=/opt/homebrew/bin/node

mkdir -p "$dest" "$HOME/.local/bin" "$HOME/Library/Logs/portman"
rsync -a --delete --exclude .git --exclude node_modules --exclude '*.test.ts' --exclude src/fixtures "$src/" "$dest/"
ln -sf "$dest/bin/portman" "$HOME/.local/bin/portman"

cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <!-- portman status page (port reserved as "portman"); installed by $src/bin/install.sh -->
  <key>ProgramArguments</key>
  <array><string>$node</string><string>$dest/src/cli.ts</string><string>serve</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>NODE_COMPILE_CACHE</key><string>$HOME/Library/Caches/portman</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/portman/serve.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/portman/serve.log</string>
</dict>
</plist>
PLIST
plutil -lint "$plist" >/dev/null

launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "installed portman to $dest; status page: $("$HOME/.local/bin/portman" url portman)"
