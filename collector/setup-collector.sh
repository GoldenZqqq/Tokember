#!/usr/bin/env bash
# Tokember native collector setup for macOS (launchd) and Linux (systemd --user).
# Usage:
#   bash collector/setup-collector.sh install|upgrade|uninstall|doctor|collect|dry-run
#     [--schedule adaptive|fixed] [--purge]
set -euo pipefail

ACTION="${1:-install}"
shift || true
SCHEDULE_MODE="adaptive"
PURGE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --schedule)
      SCHEDULE_MODE="${2:-}"
      shift 2
      ;;
    --schedule=*)
      SCHEDULE_MODE="${1#*=}"
      shift
      ;;
    --purge)
      PURGE=1
      shift
      ;;
    -h|--help)
      ACTION=help
      shift
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

if [[ "$SCHEDULE_MODE" != "adaptive" && "$SCHEDULE_MODE" != "fixed" ]]; then
  echo "--schedule must be adaptive or fixed" >&2
  exit 2
fi

INTERVAL_MINUTES=30
if [[ "$SCHEDULE_MODE" == "adaptive" ]]; then
  INTERVAL_MINUTES=1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COLLECTOR_DIR="$SCRIPT_DIR"
ENV_PATH="$COLLECTOR_DIR/collector.env"
LOG_PATH="$COLLECTOR_DIR/collector.log"
RUNNER_PATH="$COLLECTOR_DIR/run-collector.sh"
DIST_ENTRY="$COLLECTOR_DIR/dist/index.js"
SRC_ENTRY="$COLLECTOR_DIR/src/index.ts"
TSX_ENTRY="$PROJECT_ROOT/node_modules/tsx/dist/cli.mjs"
UNIT_NAME="tokember-collector"
LAUNCHD_LABEL="com.tokember.collector"
LAUNCHD_PLIST="${HOME}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SYSTEMD_SERVICE="${SYSTEMD_DIR}/${UNIT_NAME}.service"
SYSTEMD_TIMER="${SYSTEMD_DIR}/${UNIT_NAME}.timer"

is_macos() { [[ "$(uname -s)" == "Darwin" ]]; }
is_linux() { [[ "$(uname -s)" == "Linux" ]]; }

find_node() {
  local candidate version major
  if command -v node >/dev/null 2>&1; then
    candidate="$(command -v node)"
    version="$("$candidate" --version 2>/dev/null || true)"
    if [[ "$version" =~ ^v([0-9]+)\. ]]; then
      major="${BASH_REMATCH[1]}"
      if (( major == 22 )); then
        echo "$candidate"
        return 0
      fi
    fi
  fi
  return 1
}

ensure_env_file() {
  if [[ -f "$ENV_PATH" ]]; then
    echo "Preserving existing config: $ENV_PATH"
  else
    local server token
    server="${TOKEMBER_SERVER:-${AI_BURN_SERVER:-https://tokember.example}}"
    token="${TOKEMBER_DEVICE_TOKEN:-${TOKEMBER_API_KEY:-${AI_BURN_API_KEY:-${API_KEY:-}}}}"
    umask 077
    cat >"$ENV_PATH" <<EOF
TOKEMBER_SERVER=$server
TOKEMBER_DEVICE_TOKEN=$token
TOKEMBER_CLAUDE_CODEX_SOURCE=native
TOKEMBER_ATTRIBUTION_ENABLED=false
EOF
    chmod 600 "$ENV_PATH"
    echo "Created protected config: $ENV_PATH"
    if [[ "$server" == "https://tokember.example" ]]; then
      echo "WARNING: replace TOKEMBER_SERVER in collector.env with your server URL." >&2
    fi
    if [[ -z "$token" ]]; then
      echo "WARNING: set TOKEMBER_DEVICE_TOKEN in collector.env before production sync." >&2
    fi
  fi
  # Upsert schedule keys
  if grep -q '^TOKEMBER_SCHEDULE_MODE=' "$ENV_PATH" 2>/dev/null; then
    sed -i.bak "s|^TOKEMBER_SCHEDULE_MODE=.*|TOKEMBER_SCHEDULE_MODE=$SCHEDULE_MODE|" "$ENV_PATH" && rm -f "${ENV_PATH}.bak"
  else
    printf 'TOKEMBER_SCHEDULE_MODE=%s\n' "$SCHEDULE_MODE" >>"$ENV_PATH"
  fi
  if grep -q '^TOKEMBER_SCHEDULE_INTERVAL_MINUTES=' "$ENV_PATH" 2>/dev/null; then
    sed -i.bak "s|^TOKEMBER_SCHEDULE_INTERVAL_MINUTES=.*|TOKEMBER_SCHEDULE_INTERVAL_MINUTES=$INTERVAL_MINUTES|" "$ENV_PATH" && rm -f "${ENV_PATH}.bak"
  else
    printf 'TOKEMBER_SCHEDULE_INTERVAL_MINUTES=%s\n' "$INTERVAL_MINUTES" >>"$ENV_PATH"
  fi
}

write_runner() {
  local node_bin="$1"
  local mode_line use_dist=0
  if [[ -f "$DIST_ENTRY" ]]; then
    use_dist=1
  elif [[ ! -f "$TSX_ENTRY" ]]; then
    echo "tsx not found at $TSX_ENTRY — run 'npm install' or 'npm run build -w collector'" >&2
    exit 1
  fi

  cat >"$RUNNER_PATH" <<EOF
#!/usr/bin/env bash
set -euo pipefail
NODE_BIN=$(printf '%q' "$node_bin")
ENV_FILE=$(printf '%q' "$ENV_PATH")
LOG=$(printf '%q' "$LOG_PATH")
if [[ -f "\$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "\$ENV_FILE"
  set +a
fi
echo "[\$(date -Iseconds 2>/dev/null || date)] --- start ---" >>"\$LOG"
set +e
EOF
  if [[ "$use_dist" -eq 1 ]]; then
    cat >>"$RUNNER_PATH" <<EOF
"\$NODE_BIN" $(printf '%q' "$DIST_ENTRY") "\$@" >>"\$LOG" 2>&1
EOF
  else
    cat >>"$RUNNER_PATH" <<EOF
"\$NODE_BIN" $(printf '%q' "$TSX_ENTRY") $(printf '%q' "$SRC_ENTRY") "\$@" >>"\$LOG" 2>&1
EOF
  fi
  cat >>"$RUNNER_PATH" <<'EOF'
code=$?
echo "[$(date -Iseconds 2>/dev/null || date)] --- exit $code ---" >>"$LOG"
exit $code
EOF
  chmod 700 "$RUNNER_PATH"
  echo "Generated: $RUNNER_PATH"
}

install_macos() {
  mkdir -p "$(dirname "$LAUNCHD_PLIST")"
  cat >"$LAUNCHD_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${RUNNER_PATH}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${COLLECTOR_DIR}</string>
  <key>StartInterval</key>
  <integer>$((INTERVAL_MINUTES * 60))</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_PATH}</string>
</dict>
</plist>
EOF
  # Unload if present, then load (idempotent upgrade).
  launchctl bootout "gui/$(id -u)/${LAUNCHD_LABEL}" 2>/dev/null || true
  launchctl unload "$LAUNCHD_PLIST" 2>/dev/null || true
  if launchctl bootstrap "gui/$(id -u)" "$LAUNCHD_PLIST" 2>/dev/null; then
    :
  else
    launchctl load -w "$LAUNCHD_PLIST"
  fi
  echo "Installed launchd agent: $LAUNCHD_LABEL (every ${INTERVAL_MINUTES}m)"
}

uninstall_macos() {
  launchctl bootout "gui/$(id -u)/${LAUNCHD_LABEL}" 2>/dev/null || true
  launchctl unload "$LAUNCHD_PLIST" 2>/dev/null || true
  rm -f "$LAUNCHD_PLIST"
  echo "Removed launchd agent: $LAUNCHD_LABEL"
}

install_linux() {
  mkdir -p "$SYSTEMD_DIR"
  cat >"$SYSTEMD_SERVICE" <<EOF
[Unit]
Description=Tokember native collector
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=${COLLECTOR_DIR}
ExecStart=${RUNNER_PATH}
Nice=10

[Install]
WantedBy=default.target
EOF
  cat >"$SYSTEMD_TIMER" <<EOF
[Unit]
Description=Run Tokember native collector on a schedule

[Timer]
OnBootSec=2min
OnUnitActiveSec=${INTERVAL_MINUTES}min
Persistent=true
Unit=${UNIT_NAME}.service

[Install]
WantedBy=timers.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now "${UNIT_NAME}.timer"
  # Best-effort linger so timers survive logout (may need root once).
  if command -v loginctl >/dev/null 2>&1; then
    loginctl enable-linger "$(id -un)" 2>/dev/null || \
      echo "NOTE: run 'loginctl enable-linger \$USER' (may need sudo) so the timer runs after logout."
  fi
  echo "Installed systemd user timer: ${UNIT_NAME}.timer (every ${INTERVAL_MINUTES}m)"
}

uninstall_linux() {
  systemctl --user disable --now "${UNIT_NAME}.timer" 2>/dev/null || true
  systemctl --user disable --now "${UNIT_NAME}.service" 2>/dev/null || true
  rm -f "$SYSTEMD_SERVICE" "$SYSTEMD_TIMER"
  systemctl --user daemon-reload 2>/dev/null || true
  echo "Removed systemd user unit: $UNIT_NAME"
}

report_sources() {
  local home="${HOME}"
  declare -a names paths
  names=("Claude Code" "Codex" "Gemini" "Grok Build" "Cursor" "OpenClaw" "Pi Agent")
  paths=(
    "$home/.claude/projects"
    "$home/.codex/sessions"
    "$home/.gemini/tmp"
    "$home/.grok/sessions"
    "$home/.cursor"
    "$home/.openclaw"
    "$home/.pi/agent/sessions"
  )
  local i
  for i in "${!names[@]}"; do
    if [[ -e "${paths[$i]}" ]]; then
      echo "  ${names[$i]}: found"
    else
      echo "  ${names[$i]}: not installed"
    fi
  done
}

doctor() {
  echo "=== Tokember collector doctor ==="
  echo "OS: $(uname -s) $(uname -m)"
  echo "Project: $PROJECT_ROOT"
  if node_bin="$(find_node)"; then
    echo "Node: $node_bin ($("$node_bin" --version))"
  else
    echo "Node: MISSING (need Node 22.x)"
  fi
  if [[ -f "$DIST_ENTRY" ]]; then
    echo "Runtime: dist ($DIST_ENTRY)"
  elif [[ -f "$TSX_ENTRY" ]]; then
    echo "Runtime: tsx + src"
  else
    echo "Runtime: MISSING (build collector or npm install)"
  fi
  if [[ -f "$ENV_PATH" ]]; then
    echo "Config: $ENV_PATH"
    if grep -q '^TOKEMBER_SERVER=.\+' "$ENV_PATH" && ! grep -q 'tokember.example' "$ENV_PATH"; then
      echo "  TOKEMBER_SERVER: set"
    else
      echo "  TOKEMBER_SERVER: missing or still example"
    fi
    if grep -qE '^TOKEMBER_DEVICE_TOKEN=.+' "$ENV_PATH" || grep -qE '^TOKEMBER_API_KEY=.+' "$ENV_PATH"; then
      echo "  credential: set"
    else
      echo "  credential: MISSING"
    fi
  else
    echo "Config: MISSING ($ENV_PATH)"
  fi
  echo "Sources:"
  report_sources
  if is_macos; then
    if [[ -f "$LAUNCHD_PLIST" ]]; then
      echo "Scheduler: launchd $LAUNCHD_LABEL (plist present)"
      launchctl print "gui/$(id -u)/${LAUNCHD_LABEL}" 2>/dev/null | head -n 5 || true
    else
      echo "Scheduler: not installed"
    fi
  elif is_linux; then
    if systemctl --user is-enabled "${UNIT_NAME}.timer" >/dev/null 2>&1; then
      echo "Scheduler: systemd user timer enabled"
      systemctl --user status "${UNIT_NAME}.timer" --no-pager 2>/dev/null | head -n 8 || true
    else
      echo "Scheduler: not installed / not enabled"
    fi
  else
    echo "Scheduler: unsupported OS for this script"
  fi
  echo "State dir preference: ~/.tokember (legacy ~/.ai-burn reused if present alone)"
}

do_install() {
  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    echo "DRY-RUN install schedule=$SCHEDULE_MODE interval=${INTERVAL_MINUTES}m"
    echo "  would write $ENV_PATH $RUNNER_PATH"
    if is_macos; then echo "  would install $LAUNCHD_PLIST"; fi
    if is_linux; then echo "  would install $SYSTEMD_TIMER"; fi
    return 0
  fi
  local node_bin
  node_bin="$(find_node)" || {
    echo "Node.js 22.x not found. Install Node 22 first." >&2
    exit 1
  }
  echo "node: $node_bin ($("$node_bin" --version))"
  ensure_env_file
  write_runner "$node_bin"
  echo "Sources:"
  report_sources
  if is_macos; then
    install_macos
  elif is_linux; then
    install_linux
  else
    echo "Unsupported OS: $(uname -s). Use Windows setup-collector.ps1 or run the collector manually." >&2
    exit 1
  fi
  echo "Done. Schedule mode=$SCHEDULE_MODE every ${INTERVAL_MINUTES} minute(s)."
  echo "Device name (auto from hostname): $(hostname)"
}

do_uninstall() {
  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    echo "DRY-RUN uninstall purge=$PURGE"
    return 0
  fi
  if is_macos; then uninstall_macos; fi
  if is_linux; then uninstall_linux; fi
  rm -f "$RUNNER_PATH"
  echo "Removed runner: $RUNNER_PATH"
  if [[ "$PURGE" -eq 1 ]]; then
    rm -f "$ENV_PATH" "$LOG_PATH"
    echo "Purged config and log (collector state under ~/.tokember was kept)."
  else
    echo "Kept $ENV_PATH and state directories (pass --purge to remove env/log)."
  fi
}

do_collect() {
  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    echo "DRY-RUN collect --force"
    return 0
  fi
  if [[ ! -x "$RUNNER_PATH" && ! -f "$RUNNER_PATH" ]]; then
    do_install
  fi
  bash "$RUNNER_PATH" --force
}

case "$ACTION" in
  help)
    sed -n '1,8p' "$0"
    ;;
  install|upgrade)
    do_install
    ;;
  uninstall)
    do_uninstall
    ;;
  doctor)
    doctor
    ;;
  collect)
    do_collect
    ;;
  dry-run)
    DRY_RUN=1
    do_install
    ;;
  *)
    echo "Unknown action: $ACTION" >&2
    exit 2
    ;;
esac
