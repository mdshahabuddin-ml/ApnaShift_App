#!/usr/bin/env bash
# ApnaShift smoke test — deploy/update ke baad chalao. Kuch BHI write nahi karta
# (sirf GET health/ready + public estimate), isliye prod DB safe hai.
# Usage: BASE_URL=https://api.example.com ./deploy/smoke.sh   (local test: BASE_URL=http://127.0.0.1:3000)
set -euo pipefail # pehli fail par ruko taaki tooti deploy chhup na jaye

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}" # default seedha Node (nginx bypass karke app check)

pass=0; fail=0 # counters
check() { # check "naam" expected_status actual_status body
  if [ "$2" = "$3" ]; then echo "PASS: $1 ($3)"; pass=$((pass + 1)); else echo "FAIL: $1 (expected $2, got $3) -- $4"; fail=$((fail + 1)); fi
}

code="$(curl -s -o /tmp/smoke_h.json -w '%{http_code}' "$BASE_URL/api/health")" # DB ke bina wala health check
check "GET /api/health" 200 "$code" "$(cat /tmp/smoke_h.json)"

code="$(curl -s -o /tmp/smoke_r.json -w '%{http_code}' "$BASE_URL/api/ready")" # DB SELECT 1 check
check "GET /api/ready" 200 "$code" "$(cat /tmp/smoke_r.json)"

code="$(curl -s -o /tmp/smoke_e.json -w '%{http_code}' -X POST "$BASE_URL/api/bookings/estimate-price" -H 'Content-Type: application/json' -d '{"pickup":{"lat":22.7196,"lng":75.8577},"drop":{"lat":22.75,"lng":75.9},"vehicle_type":"mini_truck"}')" # public pricing path (rates + distance)
check "POST /api/bookings/estimate-price" 200 "$code" "$(cat /tmp/smoke_e.json)"

code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/api/invalid-route-xyz")" # 404 handler shape
check "GET unknown -> 404" 404 "$code" ""

echo "---"
echo "smoke: $pass passed, $fail failed" # summary
[ "$fail" -eq 0 ] # fail > 0 ho to exit code 1 (CI/script pakad lega)
