#!/bin/sh
# jantar-measure <step> <command...>: run a build step and keep what it cost
# in /opt/jantar-build/<step>.json, for the install notes on servers:
#   seconds          wall time
#   maxRssKb         the biggest single process's peak (GNU time)
#   peakAnonBytes    the whole step's peak anonymous memory (cgroup v2
#                    memory.stat, sampled every half second; null without it)
#   cgroupPeakBytes  the cgroup's memory.peak, page cache included (null without it)
#   cpus             what the builder had
set -eu
step=$1
shift
out=/opt/jantar-build
peak=$out/$step.peak
echo 0 > "$peak"
stat=/sys/fs/cgroup/memory.stat
(
  while :; do
    if [ -r "$stat" ]; then
      a=$(awk '$1 == "anon" { print $2 }' "$stat")
      p=$(cat "$peak")
      if [ -n "$a" ] && [ "$a" -gt "$p" ]; then echo "$a" > "$peak"; fi
    fi
    sleep 0.5
  done
) &
sampler=$!
start=$(date +%s%N)
code=0
/usr/bin/time -f '%M' -o "$out/$step.rss" "$@" || code=$?
end=$(date +%s%N)
kill "$sampler" 2>/dev/null || true
[ "$code" -eq 0 ] || exit "$code"
anon=$(cat "$peak")
[ "$anon" -gt 0 ] || anon=null
cgpeak=null
if [ -r /sys/fs/cgroup/memory.peak ]; then cgpeak=$(cat /sys/fs/cgroup/memory.peak); fi
secs=$(awk -v s="$start" -v e="$end" 'BEGIN { printf "%.1f", (e - s) / 1e9 }')
printf '{"step":"%s","seconds":%s,"maxRssKb":%s,"peakAnonBytes":%s,"cgroupPeakBytes":%s,"cpus":%s}\n' \
  "$step" "$secs" "$(tail -n 1 "$out/$step.rss")" "$anon" "$cgpeak" "$(nproc)" > "$out/$step.json"
rm -f "$peak" "$out/$step.rss"
cat "$out/$step.json"
