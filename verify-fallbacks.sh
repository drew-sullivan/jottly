#!/usr/bin/env bash
# verify-fallbacks.sh - pre-deploy contract check for the Jottly deep-link fallback pages.
#
# The rule this enforces: intent is preserved at every layer. Daily always carries Daily. Invite always
# carries the game ID. The website never guesses. Run this before every deploy; run with --live to also
# check the deployed site.
#
#   ./verify-fallbacks.sh          # check the local files in this repo
#   ./verify-fallbacks.sh --live   # also curl https://icedmatchalabs.com and check the served pages
#
# Exits non-zero on the first broken invariant, so it can gate a deploy.

set -uo pipefail
cd "$(dirname "$0")"

HOST="https://icedmatchalabs.com"
APP_ID="6780044797"
BUNDLE="8JKMQ4CU85.com.dsull.Jotto"

fails=0
pass() { printf '  \033[32mok\033[0m   %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m %s\n' "$1"; fails=$((fails + 1)); }

# has FILE PATTERN DESC - grep the file, pass/fail by DESC.
has() {
  if grep -qF -- "$2" "$1"; then pass "$3"; else fail "$3 (missing '$2' in $1)"; fi
}

echo "== AASA (served from both the canonical and the legacy root path) =="
canon=".well-known/apple-app-site-association"
root="apple-app-site-association"
[ -f "$canon" ] && pass "$canon exists" || fail "$canon missing"
[ -f "$root" ]  && pass "$root exists"  || fail "$root missing"
if [ -f "$canon" ] && [ -f "$root" ]; then
  cmp -s "$canon" "$root" && pass "both AASA files are byte-identical (no drift)" \
    || fail "AASA files differ - re-copy: cp $canon $root"
fi
for f in "$canon" "$root"; do
  [ -f "$f" ] || continue
  python3 -m json.tool "$f" >/dev/null 2>&1 && pass "$f is valid JSON" || fail "$f is not valid JSON"
  has "$f" "$BUNDLE" "$f names appID $BUNDLE"
  has "$f" '"/join/*"' "$f allows /join/*"
  has "$f" '"/daily"' "$f allows /daily"
done

echo "== _headers (Apple requires the AASA served as application/json) =="
has _headers "/.well-known/apple-app-site-association" "_headers covers the canonical AASA path"
has _headers "/apple-app-site-association" "_headers covers the root AASA path"
has _headers "Content-Type: application/json" "_headers sets application/json"

echo "== _redirects (join links land on the invite page, id preserved by rewrite) =="
has _redirects "/join/*  /invite  200" "/join/* rewrites to /invite (200, in place)"
has _redirects "/join    /invite  200" "/join rewrites to /invite (200, in place)"

echo "== daily.html (carries Daily intent) =="
has daily.html 'href="https://icedmatchalabs.com/daily"' "canonical is /daily"
has daily.html 'og:image" content="https://icedmatchalabs.com/assets/app_icon.png"' "og:image is the app icon (rich Messages card)"
has daily.html "app-argument=https://icedmatchalabs.com/daily" "Smart App Banner deep-links the Daily"
has daily.html 'href="jotto://daily"' "Open button uses the jotto://daily scheme fallback"

echo "== invite.html (the template; the function bakes the per-game bits) =="
has invite.html 'og:image" content="https://icedmatchalabs.com/assets/app_icon.png"' "og:image is the app icon (rich Messages card)"
has invite.html 'name="apple-itunes-app" content="app-id=6780044797"' "has a static Smart App Banner tag for the function to rewrite"
has invite.html 'id="openapp"' "has the Open-the-game button"
if grep -qF "jotto://daily" invite.html; then fail "invite.html must NEVER reference jotto://daily"; else pass "invite.html never falls back to jotto://daily"; fi

echo "== functions/join/_middleware.js (bakes route-specific initial HTML, server-side) =="
fn="functions/join/_middleware.js"
[ -f "$fn" ] && pass "$fn exists" || fail "$fn missing"
if [ -f "$fn" ]; then
  has "$fn" 'app-argument=${joinURL}' "bakes the per-game app-argument into the banner"
  has "$fn" 'jotto://join/${gameID}' "bakes the jotto://join/<id> open link"
  has "$fn" 'meta[name="apple-itunes-app"]' "rewrites the Smart App Banner tag"
  if grep -qF "jotto://daily" "$fn"; then fail "$fn must NEVER reference jotto://daily"; else pass "$fn never falls back to Daily"; fi
fi

if [ "${1:-}" != "--live" ]; then
  echo
  [ "$fails" -eq 0 ] && echo "All local fallback contracts hold. (Re-run with --live to check the deployed site.)" \
    || echo "$fails check(s) failed."
  exit $((fails > 0))
fi

echo "== live: $HOST =="
# AASA at both paths: 200 + application/json + identical to the local canonical file.
for path in "/.well-known/apple-app-site-association" "/apple-app-site-association"; do
  ct=$(curl -sS -o /tmp/aasa.live -w '%{http_code} %{content_type}' "$HOST$path")
  code=${ct%% *}; type=${ct#* }
  [ "$code" = "200" ] && pass "$path -> 200" || fail "$path -> $code (want 200)"
  case "$type" in application/json*) pass "$path served as application/json" ;;
    *) fail "$path served as '$type' (want application/json)" ;; esac
  cmp -s "$canon" /tmp/aasa.live && pass "$path body matches local AASA" || fail "$path body differs from local AASA"
done

# /daily: 200, carries the daily app-argument + jotto://daily open link.
curl -sS "$HOST/daily" -o /tmp/daily.live -w '  daily -> HTTP %{http_code}\n'
has /tmp/daily.live "app-argument=https://icedmatchalabs.com/daily" "live /daily deep-links the Daily"
has /tmp/daily.live 'href="jotto://daily"' "live /daily has the jotto://daily open link"

# /join/<id>: 200, with the per-game deep link baked into the RAW HTML server-side (curl runs no JS, so a
# match here proves the app-argument is in the initial bytes, not injected client-side).
sample="verify-fallbacks-$$"
curl -sS "$HOST/join/$sample" -o /tmp/join.live -w '  join -> HTTP %{http_code}\n'
has /tmp/join.live "app-argument=$HOST/join/$sample" "live /join bakes the per-game app-argument server-side (raw HTML)"
has /tmp/join.live "href=\"jotto://join/$sample\"" "live /join bakes the jotto://join/<id> open link server-side"
if grep -qF "jotto://daily" /tmp/join.live; then fail "live /join must NEVER reference jotto://daily"; else pass "live /join never falls back to Daily"; fi

echo
[ "$fails" -eq 0 ] && echo "All fallback contracts hold, local and live." || echo "$fails check(s) failed."
exit $((fails > 0))
