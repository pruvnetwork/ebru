#!/usr/bin/env bash
#
# The 90-second demo, as a single recordable take.
#
#   bash bin/demo.sh
#
# Every call hits the live endpoint, so what the camera sees is the deployed
# service and not a local mock. Paced for screen recording: each beat pauses
# long enough to read, short enough to stay inside 90 seconds.

set -euo pipefail

BASE="${EBRU_BASE:-https://ebru-lake.vercel.app}"
OUT="${EBRU_DEMO_OUT:-out/demo}"
mkdir -p "$OUT"

bold() { printf "\033[1m%s\033[0m\n" "$1"; }
dim()  { printf "\033[2m%s\033[0m\n" "$1"; }
ok()   { printf "\033[32m%s\033[0m\n" "$1"; }
beat() { sleep "${1:-2}"; }

clear
bold "ebru — Turkish paper marbling, computed"
dim  "$BASE"
echo
beat 2

# ─────────────────────────────────────────────────────────────
bold "1 · Any string becomes an artwork"
echo
dim '  GET /marble?seed=OKX.AI'
curl -s "$BASE/marble?seed=OKX.AI&size=700" -o "$OUT/1-okxai.png"
ok "  → $(du -h "$OUT/1-okxai.png" | cut -f1) PNG"
open "$OUT/1-okxai.png" 2>/dev/null || true
beat 4

# ─────────────────────────────────────────────────────────────
echo
bold "2 · The same seed always returns the same artwork"
dim  "   No model. No sampler. No temperature."
echo

A=$(curl -s "$BASE/marble?seed=OKX.AI&size=700" | shasum -a 256 | cut -c1-32)
dim "  first  call  →  $A"
beat 1
B=$(curl -s "$BASE/marble?seed=OKX.AI&size=700" | shasum -a 256 | cut -c1-32)
dim "  second call  →  $B"
echo
if [ "$A" = "$B" ]; then ok "  identical, byte for byte"; else printf "  MISMATCH\n"; fi
beat 4

# ─────────────────────────────────────────────────────────────
echo
bold "3 · Seven traditional patterns"
echo
for p in battal gelgit sal bulbul tarakli hatip kumlu; do
  curl -s "$BASE/marble?seed=demo-$p&pattern=$p&size=520" -o "$OUT/p-$p.png"
  printf "  %-9s ✓\n" "$p"
done
open "$OUT"/p-*.png 2>/dev/null || true
beat 5

# ─────────────────────────────────────────────────────────────
echo
bold "4 · A wallet, read as a bath"
dim  "   Every transaction is a drop of paint. Oldest laid first."
echo
dim '  POST /portrait'

# A trader who goes quiet for weeks then fires off dozens of trades in a day.
# That shape is what the reader turns into spiral nests, so it is the one worth
# putting on camera. Deterministic, so the recording is repeatable.
node -e '
const DAY = 86400;
let t = 1735689600, i = 0;
const ev = [];
const tok = ["OKB", "USDT", "xETH", "xBTC"];
for (let burst = 0; burst < 6; burst++) {
  t += (24 + burst * 3) * DAY;
  for (let k = 0; k < 7 + burst; k++) {
    ev.push({
      hash: "0x" + (i++).toString(16).padStart(4, "0"),
      ts: t + k * 900,
      value: 80 + ((i * 977) % 9000),
      token: tok[i % 4],
      counterparty: "0xdex" + (i % 5),
    });
  }
}
process.stdout.write(JSON.stringify({
  address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  block: 66169118,
  events: ev,
}));
' > "$OUT/reading.json"

curl -s -X POST "$BASE/portrait?size=700" \
  -H 'content-type: application/json' \
  --data-binary "@$OUT/reading.json" \
  > "$OUT/portrait.json"

node -e '
const j = require("fs").readFileSync(process.argv[1], "utf8");
const d = JSON.parse(j);
console.log("");
console.log("  pattern : " + d.meta.patternLabel + "  —  " + d.meta.reason);
console.log("  pinned  : X Layer block " + d.meta.block);
console.log("");
console.log("  " + d.legend.length + " transactions → " + d.legend.length + " drops of paint");
console.log("");
const first = d.legend[0];
const big = d.legend.reduce((a, b) => (b.value > a.value ? b : a));
console.log("  first transaction  still holds " + (first.share * 100).toFixed(2) + "% of the sheet");
console.log("  largest (" + Math.round(big.value) + " " + big.token + ")  sits at " + big.x + "," + big.y);
require("fs").writeFileSync(process.argv[2],
  Buffer.from(d.image.split(",")[1], "base64"));
' "$OUT/portrait.json" "$OUT/portrait.png"
open "$OUT/portrait.png" 2>/dev/null || true
beat 6

# ─────────────────────────────────────────────────────────────
echo
# Two claims used to sit on this line that the camera would have carried into
# the submission: that the listing is live, and that calls are free. Neither is
# true — the listing is under review and a tool call costs 0.001 USDT. What is
# true is the thing the whole demo just showed.
bold "Deterministic marbling, computed — 0.001 USDT a call on X Layer"
dim  "$BASE"
echo
