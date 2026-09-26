#!/bin/sh
# Eatswada latency benchmark — works in Termux (needs: curl, awk, sort, xargs).
# Usage:  sh bench.sh https://YOUR-API.onrender.com [requests_per_endpoint] [parallel_users]
API="${1:?Usage: sh bench.sh https://YOUR-API.onrender.com [N] [P]}"; API="${API%/}"
N="${2:-20}"; P="${3:-25}"
LAT="${LAT:-26.56}"; LNG="${LNG:-88.82}"; Q="${Q:-chicken}"

stats() { # stdin: one "code seconds" per line -> p50/p95/avg/max in ms
  sort -k2 -n | awk -v label="$1" '
    { t[NR]=$2*1000; s+=$2*1000; if ($1 != 200) e++ }
    END { if (!NR) { print label ": no data"; exit }
          i50=int(NR*0.50); if(i50<1)i50=1; i95=int(NR*0.95+0.5); if(i95<1)i95=1; if(i95>NR)i95=NR
          printf "%-44s n=%-3d p50=%5.0fms  p95=%5.0fms  avg=%5.0fms  max=%5.0fms  non200=%d\n", label, NR, t[i50], t[i95], s/NR, t[NR], e+0 }'
}

echo "Waking server..."; curl -s -o /dev/null -w "  /health -> HTTP %{http_code} in %{time_total}s\n" --max-time 90 "$API/health"
RID=$(curl -s "$API/api/restaurants?limit=1" | grep -o '"_id":"[0-9a-f]\{24\}"' | head -n 1 | cut -d'"' -f4)
echo "Sample restaurant id: ${RID:-none found}"

EPS="/api/categories
/api/home-banners?placement=home
/api/restaurants?page=1&limit=20
/api/restaurants/serviceability?lat=$LAT&lng=$LNG
/api/restaurants/under99
/api/restaurants/search?q=$Q&scope=home"
[ -n "$RID" ] && EPS="$EPS
/api/restaurants/$RID
/api/restaurants/$RID/menu
/api/restaurants/$RID/reviews"

echo; echo "== A) Sequential: server time per request (time-to-first-byte after TLS), $N requests each =="
echo "$EPS" | while read -r EP; do
  i=0; while [ "$i" -lt "$N" ]; do
    curl -s -o /dev/null -H 'Accept-Encoding: gzip' -w '%{http_code} %{time_appconnect} %{time_starttransfer}\n' "$API$EP"
    i=$((i+1))
  done | awk '{ printf "%s %.6f\n", $1, $3-$2 }' | stats "$EP"
done

echo; echo "== B) Burst: $P users hit the same endpoint at the same moment (total time per request) =="
echo "$EPS" | head -n 5 | while read -r EP; do
  seq 1 "$P" | xargs -P "$P" -I{} curl -s -o /dev/null -H 'Accept-Encoding: gzip' -w '%{http_code} %{time_total}\n' "$API$EP" | stats "$EP"
done

echo; echo "== C) Payload size (gzip on the wire / uncompressed) =="
echo "$EPS" | while read -r EP; do
  gz=$(curl -s -o /dev/null -H 'Accept-Encoding: gzip' -w '%{size_download}' "$API$EP")
  raw=$(curl -s -o /dev/null -w '%{size_download}' "$API$EP")
  printf "%-44s gzip=%7s B   raw=%7s B\n" "$EP" "$gz" "$raw"
done
