#!/usr/bin/env bash
# Poll the listing until the review verdict changes, then stop.
# Only the change matters; the waiting is not worth a human's attention.
export PATH="/Users/nida/.local/bin:$PATH"
LAST=""
while true; do
  NOW=$(onchainos agent get-agents --agent-ids 9130 2>/dev/null | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  try { const a=JSON.parse(s).data[0];
    console.log(a.approvalDisplayStatus + '|' + a.approvalLabel + '|' + (a.approvalRemark||'').split('\n')[0]);
  } catch(e){ console.log('err'); }
});")
  STATUS="${NOW%%|*}"
  if [ -n "$LAST" ] && [ "$NOW" != "$LAST" ]; then
    echo "DEGISTI: $NOW"; exit 0
  fi
  LAST="$NOW"
  if [ "$STATUS" != "2" ] && [ "$STATUS" != "err" ]; then
    echo "SONUC: $NOW"; exit 0
  fi
  sleep 1200
done
