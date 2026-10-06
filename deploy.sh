#!/bin/bash
# ─── TeleUploader Deploy Script ──────────────────────────────────────────────
# Builds the pnpm/Node app and ships it to the VPS as a plain systemd deploy.
#
# There is no Nix on orangevps anymore (`ls /nix` → No such file or directory),
# so the old store-based deploy chain (`nix build` → push store path → activate
# profile) could never work — every run died on the push with
# `error: cannot connect`. The unit itself was
# already migrated by hand:
#
#     ExecStart=/usr/local/bin/bws-exec teleuploader /opt/teleuploader/bin/teleuploader
#       → cd /var/lib/teleuploader
#       → exec /usr/bin/node /opt/teleuploader/dist/index.js
#
# So a deploy is only: build dist, ship it, install it under
# /opt/teleuploader/dist, `systemctl restart teleuploader`, then prove that
# /health answers on the port the service's own PID is listening on — with an
# automatic rollback to the previous dist if it does not.
#
# Prerequisites:
#   - SSH access to the VPS
#   - pnpm + Node on this machine (for the build step)
#
# Usage:
#   ./deploy.sh                          # build + deploy
#   ./deploy.sh --no-build               # ship the existing dist/
#   ./deploy.sh --help                   # show this message
#   ./deploy.sh --check                  # dry-run: show vars and exit
#
# Required env in CI (Gitea Actions secrets / GitHub Actions secrets):
#   VPS_HOST              — VPS IP/hostname
#   VPS_USER              — SSH user
#   VPS_SSH_KEY           — path to SSH private key file
#
# Local defaults:
#   VPS_HOST              — 45.127.35.244
#   VPS_USER              — root
#   VPS_SSH_KEY           — ~/.ssh/id_ed25519
#
# Optional:
#   DEPLOY_DIR            — app dir on VPS (default: /opt/teleuploader)
#   UNIT                  — systemd unit to restart (default: teleuploader)
#   HEALTH_PATH           — HTTP path to probe (default: /health)
# ──────────────────────────────────────────────────────────────────────────────

set -eu

# ── Config ────────────────────────────────────────────────────────────────────
APP_NAME="teleuploader"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/${APP_NAME}}"
UNIT="${UNIT:-${APP_NAME}}"
HEALTH_PATH="${HEALTH_PATH:-/health}"

# ── Parse args ────────────────────────────────────────────────────────────────
DO_BUILD=true
DO_CHECK=false

for arg in "$@"; do
  case "$arg" in
    --help|-h)
      sed -n '2,/^$/ s/^# //p' "$0"
      exit 0
      ;;
    --no-build)    DO_BUILD=false ;;
    --check)       DO_CHECK=true ;;
  esac
done

# ── Default credentials ───────────────────────────────────────────────────────
# Local defaults for this project. CI-provided environment variables take precedence.
: "${VPS_HOST:=45.127.35.244}"
: "${VPS_USER:=root}"
: "${VPS_SSH_KEY:=${HOME}/.ssh/id_ed25519}"

# ── Check mode ────────────────────────────────────────────────────────────────
if $DO_CHECK; then
  echo "=== Config ==="
  echo "App name:     $APP_NAME"
  echo "Deploy dir:   $DEPLOY_DIR"
  echo "Unit:         $UNIT"
  echo "Health path:  $HEALTH_PATH"
  echo ""
  echo "=== Credentials ==="
  echo "VPS_HOST:     ${VPS_HOST:-<not set>}"
  echo "VPS_USER:     ${VPS_USER:-<not set>}"
  echo "VPS_SSH_KEY:  ${VPS_SSH_KEY:+<set (${#VPS_SSH_KEY} chars)>}"
  echo ""
  echo "=== Files to deploy ==="
  for f in package.json pnpm-lock.yaml schema.sql dist/index.js dist/migrate.js; do
    [ -e "$f" ] && echo "  ✓ $f" || echo "  ✗ $f (missing)"
  done
  exit 0
fi

# ── Helpers ───────────────────────────────────────────────────────────────────
log()  { echo "→ $*"; }
ok()   { echo "✓ $*"; }
die()  { echo "✗ $*"; exit 1; }

# ── Validate ──────────────────────────────────────────────────────────────────
: "${VPS_HOST:?VPS_HOST resolved to empty}"
: "${VPS_USER:?VPS_USER resolved to empty}"
: "${VPS_SSH_KEY:?VPS_SSH_KEY resolved to empty}"
[ -f "$VPS_SSH_KEY" ] || die "SSH key not found at $VPS_SSH_KEY"

SSH_DEST="${VPS_USER}@${VPS_HOST}"
SSH_OPTS="-i $VPS_SSH_KEY -o StrictHostKeyChecking=accept-new -o BatchMode=yes"

vps()  { ssh $SSH_OPTS "$SSH_DEST" "$@"; }

REPO_ROOT=$(cd "$(dirname "$0")" && pwd)
cd "$REPO_ROOT"
STAGE_REMOTE="/tmp/${APP_NAME}-deploy"
DIST_REMOTE="${DEPLOY_DIR}/dist"

# ── 1. Test SSH connection ────────────────────────────────────────────────────
log "Testing SSH connection to ${VPS_USER}@${VPS_HOST}..."
vps "echo connected" > /dev/null 2>&1 || die "SSH connection failed"
ok "SSH connection established"

# ── 2. Build ──────────────────────────────────────────────────────────────────
if $DO_BUILD; then
  command -v pnpm > /dev/null 2>&1 || die "pnpm not found (this project builds with pnpm)"

  log "Installing dependencies..."
  pnpm install --frozen-lockfile 2>&1 | tail -2

  log "Linting..."
  pnpm run lint 2>&1 | tail -5 || die "Lint failed"

  log "Building dist..."
  pnpm run build 2>&1 | tail -5 || die "Build failed"

  [ -f dist/index.js ] || die "dist/index.js not found after build"
  [ -f dist/migrate.js ] || die "dist/migrate.js not found after build"
  ok "Build complete (dist/index.js: $(wc -c < dist/index.js | numfmt --to=iec) — dist/migrate.js: $(wc -c < dist/migrate.js | numfmt --to=iec))"
else
  log "Skipping build (--no-build)"
  [ -f dist/index.js ] || die "dist/index.js missing — run without --no-build first"
fi

# ── 3. Stage on the VPS ───────────────────────────────────────────────────────
log "Staging build at ${STAGE_REMOTE}..."
vps "rm -rf '${STAGE_REMOTE}' && mkdir -p '${STAGE_REMOTE}'"

log "Shipping dist to VPS..."
scp $SSH_OPTS dist/index.js dist/migrate.js "${SSH_DEST}:${STAGE_REMOTE}/" > /dev/null || die "scp failed"
ok "Build shipped"

# ── 4. Install + restart + verify (runs on the VPS) ───────────────────────────
# Fed through stdin so the whole remote transaction — atomic install, restart,
# health probe, rollback — happens in one session with no quoting traps.
log "Installing under ${DIST_REMOTE} and restarting ${UNIT}..."
if ! vps bash -s -- "${STAGE_REMOTE}" "${DIST_REMOTE}" "${UNIT}" "${HEALTH_PATH}" <<'REMOTE'
set -Eeuo pipefail
STAGE="$1"; DIST_DIR="$2"; UNIT="$3"; HEALTH_PATH="$4"

say()  { echo "[deploy] $*"; }
boom() { echo "[deploy] ERROR: $*" >&2; exit 1; }

[ -f "$STAGE/index.js" ] || boom "staged index.js not found in $STAGE"
command -v systemctl > /dev/null 2>&1 || boom "systemctl not found"
command -v curl > /dev/null 2>&1 || boom "curl not found"

# Prefer sudo: on this box the deploy user can write /opt/<app> (so a plain
# write test would pick the no-privilege branch) but restarting a unit, reading
# its journal, or seeing another user's process in `ss` needs root. The CI user
# has NOPASSWD sudo; if it ever loses that, fall back to running as-is so the
# error surfaces from systemd itself instead of silently doing nothing.
as_root() {
  if command -v sudo > /dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo -n "$@"
  else
    "$@"
  fi
}

PREV="${DIST_DIR}.previous"
if [ -d "$DIST_DIR" ]; then
  rm -rf "$PREV"
  as_root cp -a "$DIST_DIR" "$PREV"
  say "backed up current dist to $PREV"
fi

RESTORE=0
restore() {
  [ -d "$PREV" ] || return 0
  say "restoring previous dist"
  local f base
  for f in "$PREV"/*.js; do
    [ -e "$f" ] || continue
    base="$(basename "$f")"
    as_root cp -a "$f" "$DIST_DIR/$base.new" && as_root mv -f "$DIST_DIR/$base.new" "$DIST_DIR/$base"
  done
  as_root systemctl restart "$UNIT" || true
}

report() {
  echo "=== systemctl status $UNIT ==="
  as_root systemctl status "$UNIT" --no-pager 2>&1 | head -20 || true
  echo "=== journalctl -u $UNIT (last 60) ==="
  as_root journalctl -u "$UNIT" -n 60 --no-pager 2>&1 | tail -60 || true
}

on_error() {
  local rc="$1" line="$2"
  echo "[deploy] ERROR: step failed at line $line (exit $rc)" >&2
  if [ "$RESTORE" = "1" ]; then restore; fi
  report
  exit "$rc"
}
trap 'on_error $? $LINENO' ERR

# Per-file rename on the same filesystem: the running process keeps its old
# inode until the restart, so nothing half-written is ever executed.
RESTORE=1
for f in "$STAGE"/*.js; do
  base="$(basename "$f")"
  as_root cp -a "$f" "$DIST_DIR/$base.new"
  as_root mv -f "$DIST_DIR/$base.new" "$DIST_DIR/$base"
  say "installed $base"
done
RESTORE=0

say "restarting $UNIT"
as_root systemctl restart "$UNIT"

active=0
for _ in $(seq 1 30); do
  if as_root systemctl is-active --quiet "$UNIT"; then active=1; break; fi
  sleep 1
done
[ "$active" = "1" ] || boom "$UNIT never became active"

# The port is injected at run time by bws-exec, so read it off the running PID
# instead of hardcoding it (it has already moved once: 4189 → 4000). `ss -p`
# only shows processes the caller may inspect, hence as_root.
pid="$(as_root systemctl show -p MainPID --value "$UNIT")"
port="$(as_root ss -ltnpH 2>/dev/null | grep -F "pid=$pid," | head -1 | grep -oE ':[0-9]+' | head -1 | tr -d ':' || true)"

if [ -n "$port" ]; then
  url="http://127.0.0.1:${port}${HEALTH_PATH}"
  say "health-check $url"
  body="$(curl -fsS -m 5 --retry 15 --retry-delay 2 --retry-connrefused --retry-all-errors "$url")"
  say "health: $body"
else
  # systemd already says active, but name the miss loudly instead of passing silently.
  say "WARNING: no listening socket found for pid $pid — $HEALTH_PATH not probed"
fi

say "deploy of $UNIT complete (active: $(as_root systemctl is-active "$UNIT"))"
rm -rf "$STAGE"
REMOTE
then
  die "remote deploy failed (see log above)"
fi

# ── Cleanup temp SSH key ──────────────────────────────────────────────────────
if [[ "${VPS_SSH_KEY:-}" == /tmp/* ]]; then
  rm -f "$VPS_SSH_KEY"
fi

echo ""
echo "✓ Deploy complete — ${APP_NAME} is running on ${VPS_HOST} (unit: ${UNIT})"
