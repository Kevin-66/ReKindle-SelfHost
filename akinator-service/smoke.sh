#!/usr/bin/env bash
#
# Smoke-test a deployed Akinator relay.
#
#   ./smoke.sh https://your-service-url [origin]
#
# Exercises health, CORS preflight, start, answer and back against the real
# Akinator upstream. Exits non-zero on the first failure.

set -euo pipefail

BASE="${1:?usage: ./smoke.sh https://your-service-url [origin]}"
ORIGIN="${2:-https://rekindle.ink}"
BASE="${BASE%/}"

json_field() {
    node -e '
        let s = "";
        process.stdin.on("data", d => { s += d; }).on("end", () => {
            try { const o = JSON.parse(s); process.stdout.write(String(o[process.argv[1]] ?? "")); }
            catch (e) { process.stdout.write(""); }
        });
    ' "$1"
}

post() {
    curl -sS -m 30 -X POST "$BASE/" \
        -H 'Content-Type: application/json' \
        -H "Origin: $ORIGIN" \
        --data "$1"
}

echo "== health"
curl -sS -m 10 "$BASE/healthz"; echo

echo "== CORS preflight"
curl -sS -m 10 -o /dev/null -D - -X OPTIONS "$BASE/" \
    -H "Origin: $ORIGIN" \
    -H 'Access-Control-Request-Method: POST' \
    -H 'Access-Control-Request-Headers: content-type' \
    | grep -i 'access-control-allow' || {
        echo "missing CORS headers" >&2
        exit 1
    }

echo "== start"
START="$(post '{"action":"start","region":"en"}')"
echo "$START"
SESSION="$(printf '%s' "$START" | json_field session)"
if [ -z "$SESSION" ]; then
    echo "start failed (no session)" >&2
    exit 1
fi

echo "== answer"
ANSWER="$(post "{\"action\":\"answer\",\"region\":\"en\",\"session\":\"$SESSION\",\"step\":1,\"progression\":0,\"answer\":0,\"stepLast\":\"\"}")"
echo "$ANSWER"
STEP="$(printf '%s' "$ANSWER" | json_field step)"
if [ -z "$STEP" ]; then
    echo "answer failed" >&2
    exit 1
fi

echo "== back"
BACK="$(post "{\"action\":\"back\",\"region\":\"en\",\"session\":\"$SESSION\",\"step\":$STEP,\"progression\":0}")"
echo "$BACK"
if printf '%s' "$BACK" | grep -q '"error"'; then
    echo "back failed" >&2
    exit 1
fi

echo
echo "OK: relay is working against Akinator"
