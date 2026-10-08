#!/usr/bin/env bash
# Pre-cutover smoke test — added in P0 of the kana migration.
#
# Why this exists: `deploy.sh` probes only GET /health, and `handleHealth` is a bare
# `SELECT 1`. That passes even if every bucket query, every S3 route, and the whole
# storage path are broken. This script exercises the surfaces that actually carry
# traffic, so a big-bang cutover is gated on more than a liveness ping.
#
# Run it against the CURRENT production build BEFORE starting the migration. If it is
# already red here, fix that first — a smoke test that was broken on day one teaches
# you nothing about your changes.
#
# Deliberately NOT wired into CI: it needs real S3 credentials, which must not appear
# in a workflow log. Run it manually from your workstation.
#
# Usage:
#   scripts/smoke.sh                      # https://upload.asepharyana.my.id
#   TARGET=http://127.0.0.1:4000 scripts/smoke.sh
#
# Required only for the S3 check (step 4):
#   S3_ACCESS_KEY, S3_SECRET_KEY, S3_DEFAULT_REGION (default us-east-1)

set -uo pipefail

TARGET="${TARGET:-https://upload.asepharyana.my.id}"
S3_REGION="${S3_DEFAULT_REGION:-us-east-1}"
HEALTH_PATH="${HEALTH_PATH:-/health}"

failures=0
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; failures=$((failures + 1)); }
skip() { printf '  \033[33mSKIP\033[0m  %s\n' "$1"; }

echo "Smoke test target: ${TARGET}"
echo

# ── 1. Health ────────────────────────────────────────────────────────────────
# Liveness only. Necessary, nowhere near sufficient — that is why steps 2-3 exist.
echo "[1/4] ${HEALTH_PATH}"
body=$(curl -fsS -m 10 "${TARGET}${HEALTH_PATH}" 2>/dev/null)
if [ -n "$body" ]; then
  pass "${HEALTH_PATH} responded: ${body}"
else
  fail "${HEALTH_PATH} unreachable or non-2xx"
fi

# ── 2. Public data plane (must stay public by design) ────────────────────────
# /api/upload and /f/:public_id are deliberately unauthenticated. They are also the
# highest-traffic and least-covered paths, so assert reachability explicitly.
echo
echo "[2/4] public data plane"
code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "${TARGET}/f/smoke-nonexistent-id" 2>/dev/null)
case "$code" in
  404) pass "GET /f/<bogus> -> 404 (route live, lookup correctly misses)" ;;
  000) fail "GET /f/<bogus> unreachable" ;;
  *)   fail "GET /f/<bogus> -> ${code} (expected 404)" ;;
esac

code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST "${TARGET}/api/upload" 2>/dev/null)
case "$code" in
  400|401|413|415) pass "POST /api/upload rejects an empty body -> ${code} (route live)" ;;
  000) fail "POST /api/upload unreachable" ;;
  *)   fail "POST /api/upload -> ${code} (expected a 4xx rejection)" ;;
esac

# ── 3. Dashboard JSON API ────────────────────────────────────────────────────
# GET is public by design; writes must be refused without a token. This asserts the
# read/write asymmetry that P3 has to preserve under better-auth.
echo
echo "[3/4] dashboard API (/api/v1)"
body=$(curl -fsS -m 10 "${TARGET}/api/v1/buckets" 2>/dev/null)
if [ -n "$body" ]; then
  pass "GET /api/v1/buckets responded: $(printf '%.80s' "$body")"
else
  fail "GET /api/v1/buckets unreachable or non-2xx"
fi

code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X DELETE "${TARGET}/api/v1/buckets/smoke-nonexistent" 2>/dev/null)
case "$code" in
  401|403) pass "DELETE /api/v1/buckets/<bogus> -> ${code} (writes are protected)" ;;
  000) fail "DELETE /api/v1/buckets/<bogus> unreachable" ;;
  *)   fail "DELETE /api/v1/buckets/<bogus> -> ${code} (expected 401/403 — writes must be protected)" ;;
esac

# ── 4. S3 (signed) ───────────────────────────────────────────────────────────
# The highest-value check: S3 is ~2,900 lines of hand-rolled SigV4 and is the one
# surface the kana migration must not disturb. Skipped without credentials rather
# than run unsigned, since an unsigned GET / legitimately returns the dashboard HTML
# instead of S3 XML.
echo
echo "[4/4] S3 SigV4"
if [ -z "${S3_ACCESS_KEY:-}" ] || [ -z "${S3_SECRET_KEY:-}" ]; then
  skip "S3_ACCESS_KEY/S3_SECRET_KEY not set — cannot sign. Set both to exercise the S3 path."
elif ! command -v aws >/dev/null 2>&1; then
  skip "aws CLI not installed — cannot sign a ListBuckets request"
else
  if aws --endpoint-url "$TARGET" --region "$S3_REGION" s3api list-buckets >/tmp/smoke-s3.out 2>/tmp/smoke-s3.err; then
    pass "signed ListBuckets succeeded"
  else
    fail "signed ListBuckets failed: $(head -2 /tmp/smoke-s3.err | tr '\n' ' ')"
  fi
  rm -f /tmp/smoke-s3.out /tmp/smoke-s3.err
fi

# ── Result ───────────────────────────────────────────────────────────────────
echo
if [ "$failures" -eq 0 ]; then
  printf '\033[32mSmoke test PASSED\033[0m against %s\n' "$TARGET"
  exit 0
fi
printf '\033[31mSmoke test FAILED (%d check(s))\033[0m against %s\n' "$failures" "$TARGET"
exit 1