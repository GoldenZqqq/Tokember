#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run as root: sudo bash collector/setup-hermes-collector.sh" >&2
  exit 1
fi

SOURCE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
INSTALL_DIR=/opt/tokember
ENV_FILE=/etc/tokember-hermes.env
SECRET_ENV_FILE=/etc/tokember-hermes.secret.env
SERVICE_FILE=/etc/systemd/system/tokember-hermes.service
TIMER_FILE=/etc/systemd/system/tokember-hermes.timer

install -d -m 0755 "$INSTALL_DIR"
install -m 0755 "$SOURCE_DIR/hermes_collector.py" "$INSTALL_DIR/hermes_collector.py"
install -m 0644 "$SOURCE_DIR/hermes_attribution.py" "$INSTALL_DIR/hermes_attribution.py"
install -m 0644 "$SOURCE_DIR/hermes_outbox.py" "$INSTALL_DIR/hermes_outbox.py"

LEGACY_STATE=/var/lib/ai-burn-hermes/state.json
TOKEMBER_STATE=/var/lib/tokember-hermes/state.json
install -d -m 0755 -o hermes -g hermes "$(dirname "$TOKEMBER_STATE")"
if [[ -f "$LEGACY_STATE" && ! -f "$TOKEMBER_STATE" ]]; then
  install -m 0644 -o hermes -g hermes "$LEGACY_STATE" "$TOKEMBER_STATE"
  echo "Migrated Hermes collector state to $TOKEMBER_STATE"
fi

cat >"$ENV_FILE" <<'EOF'
# Replace placeholders before enabling production sync.
TOKEMBER_SERVER=https://tokember.example
TOKEMBER_DEVICE_ID=replace-with-machine-id
TOKEMBER_DEVICE_NAME=replace-with-machine-name
HERMES_INSTANCE_ID=replace-with-hostname-or-instance
HERMES_DB=/home/hermes/.hermes/state.db
TOKEMBER_STATE=/var/lib/tokember-hermes/state.json
TOKEMBER_OBSERVABILITY_STATE=/var/lib/tokember-hermes/observability.json
TOKEMBER_SCHEDULE_INTERVAL_MINUTES=60
TOKEMBER_HERMES_BOOTSTRAP_HOURS=48
TOKEMBER_ATTRIBUTION_ENABLED=false
TOKEMBER_ATTRIBUTION_SECRET_FILE=/var/lib/tokember-hermes/attribution-secret
EOF
chmod 0644 "$ENV_FILE"
echo "Wrote $ENV_FILE with placeholder server/device values; edit before enabling sync."

if [[ ! -f "$SECRET_ENV_FILE" ]]; then
  install -m 0600 -o root -g root /dev/null "$SECRET_ENV_FILE"
  echo "Created $SECRET_ENV_FILE; set TOKEMBER_DEVICE_TOKEN before enabling production sync"
else
  chmod 0600 "$SECRET_ENV_FILE"
fi

cat >"$SERVICE_FILE" <<'EOF'
[Unit]
Description=Sync Hermes usage to Tokember
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=hermes
Group=hermes
EnvironmentFile=-/etc/ai-burn-hermes.env
EnvironmentFile=/etc/tokember-hermes.env
EnvironmentFile=-/etc/tokember-hermes.secret.env
ExecStart=/usr/bin/python3 /opt/tokember/hermes_collector.py
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadOnlyPaths=/home/hermes/.hermes/state.db
StateDirectory=tokember-hermes
ReadWritePaths=/var/lib/tokember-hermes -/var/lib/ai-burn-hermes
EOF

cat >"$TIMER_FILE" <<'EOF'
[Unit]
Description=Run Tokember Hermes collector hourly

[Timer]
OnBootSec=2min
OnUnitActiveSec=1h
Persistent=true
RandomizedDelaySec=2min

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl disable --now ai-burn-hermes.timer 2>/dev/null || true
systemctl enable --now tokember-hermes.timer
systemctl start tokember-hermes.service
systemctl show tokember-hermes.service -p Result -p ExecMainStatus -p ActiveState
systemctl --no-pager list-timers tokember-hermes.timer
