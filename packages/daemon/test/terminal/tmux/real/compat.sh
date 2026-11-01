#!/bin/sh
# The tmux backend's write primitive and gate on the oldest tmux it supports
# (lane L2, spec 4.1: tmux 3.2a on ubuntu:22.04). No Node: plain sh, the
# exact argv shapes terminal/tmux/ builds and the gates tmuxGate builds
# (tmux.test.ts checks this file holds them, with @TTY@ for the pane's tty).
# run.sh runs it in a throwaway container: `run.sh compat`. Never on a
# machine with a tmux server of its own.
set -eu

dir=$(mktemp -d)
sock="$dir/tmux.sock"
t() { tmux -S "$sock" "$@"; }
fails=0
ok() { echo "ok - $*"; }
no() { echo "not ok - $*"; fails=$((fails + 1)); }
hex() { od -An -tx1 "$1" 2>/dev/null | tr -d ' \n'; }
logged() { sleep 0.4; hex "$dir/log"; }

tmux -V

# What every gate holds (tmuxGate), and the gates of the checks below.
G0='#{&&:#{==:#{pane_tty},@TTY@},#{&&:#{==:#{pane_in_mode},0},#{&&:#{==:#{pane_synchronized},0},#{&&:#{==:#{pane_input_off},0},#{==:#{pane_dead},0}}}}}'
G2='#{&&:#{==:#{pane_tty},@TTY@},#{&&:#{==:#{pane_in_mode},0},#{&&:#{==:#{pane_synchronized},0},#{&&:#{==:#{pane_input_off},0},#{&&:#{==:#{pane_dead},0},#{&&:#{C:Do you want to proceed?},#{&&:#{C:❯ 1. Yes},#{C:  ?(touch /tmp/jantar-pwned) ?a?b? ?x? ?y? ?z}}}}}}}}'
GX='#{&&:#{==:#{pane_tty},@TTY@},#{&&:#{==:#{pane_in_mode},0},#{&&:#{==:#{pane_synchronized},0},#{&&:#{==:#{pane_input_off},0},#{&&:#{==:#{pane_dead},0},#{&&:#{C:Do you want to proceed?},#{C:Not on this screen}}}}}}}'
LIST='#{pane_id}	#{pane_tty}	#{pane_pid}	#{pane_height}	#{pane_dead}'
BUF=jantar-01JF1EETN0DEBV11D1000000A1
CHANGED='display-message -p JANTAR-CHANGED'

# A pane that shows a dialog, then logs every byte it gets, raw.
cat > "$dir/banner" <<'EOF'
Do you want to proceed?
  #(touch /tmp/jantar-pwned) {a,b} [x] *y? \z
❯ 1. Yes
  2. No
EOF
: > "$dir/log"
t -f /dev/null new-session -d -s compat -x 200 -y 50 "cat $dir/banner; stty raw -echo; exec cat > $dir/log"
sleep 1
p=$(t list-panes -a -F '#{pane_id}')
tty=$(t display-message -p -t "$p" '#{pane_tty}')
gate() { printf '%s' "$1" | sed "s|@TTY@|$tty|"; }
echo "pane $p on $tty"

# The pane variables the gate reads exist.
flags=$(t display-message -p -t "$p" '#{pane_in_mode}|#{pane_synchronized}|#{pane_input_off}|#{pane_dead}')
[ "$flags" = "0|0|0|0" ] && ok "pane_in_mode, pane_synchronized, pane_input_off, pane_dead: $flags" || no "pane flags: $flags"

# list-panes as findPane and the tick read it.
row=$(t list-panes -a -F "$LIST")
case "$row" in "$p	$tty	"*"	50	0") ok "list-panes -a -F: $row" ;; *) no "list-panes: $row" ;; esac

# readScreen: the tty and height, then capture-pane -p -N, in one call.
screen=$(t display-message -p -t "$p" '#{pane_tty}	#{pane_height}' ';' capture-pane -p -N -t "$p")
first=$(printf '%s\n' "$screen" | head -n 1)
[ "$first" = "$tty	50" ] && ok "display-message ; capture-pane: $first" || no "readScreen head: $first"
printf '%s\n' "$screen" | grep -q '#(touch /tmp/jantar-pwned) {a,b} \[x\] \*y? \\z' && ok "capture-pane -p -N shows the dialog" || no "capture-pane"

# The write primitive: text on stdin, then one gated step; a trailing ; survives.
printf 'echo hi;' | t load-buffer -b "$BUF" -
out=$(t if-shell -F -t "$p" "$(gate "$G0")" "paste-buffer -d -r -b $BUF -t $p ; send-keys -t $p Enter" "delete-buffer -b $BUF ; $CHANGED")
got=$(logged)
[ -z "$out" ] && [ "$got" = "6563686f2068693b0d" ] && ok "load-buffer - and a gated paste: echo hi; then Return" || no "write: out=$out bytes=$got"
: > "$dir/log"

# Key bytes as hex tokens, then one Enter, in the same step.
out=$(t if-shell -F -t "$p" "$(gate "$G0")" "send-keys -t $p -H 1b 5b 42 1b 5b 42 ; send-keys -t $p Enter" "$CHANGED")
got=$(logged)
[ -z "$out" ] && [ "$got" = "1b5b421b5b420d" ] && ok "send-keys -H: Down Down Enter" || no "keys: out=$out bytes=$got"
: > "$dir/log"

# Several lines with -p -r: the line feed kept (cat asked for no bracketed paste).
printf 'a\nb' | t load-buffer -b "$BUF" -
out=$(t if-shell -F -t "$p" "$(gate "$G0")" "paste-buffer -p -d -r -b $BUF -t $p" "delete-buffer -b $BUF ; $CHANGED")
got=$(logged)
[ -z "$out" ] && [ "$got" = "610a62" ] && ok "paste-buffer -p -d -r keeps the line feed" || no "multi-line: out=$out bytes=$got"
: > "$dir/log"

# The compare-and-type gate: GLOB_SPECIALS as ?, so #(touch ...) on screen runs nothing, and the lines match.
rm -f /tmp/jantar-pwned
out=$(t if-shell -F -t "$p" "$(gate "$G2")" "send-keys -t $p Enter" "$CHANGED")
got=$(logged)
sleep 0.5
[ -z "$out" ] && [ "$got" = "0d" ] && ok "#{C:} lines with ? for # , { } * ? [ ] \\ match the dialog" || no "line gate: out=$out bytes=$got"
[ ! -e /tmp/jantar-pwned ] && ok "a screen line #(touch ...) ran nothing" || no "#() ran"
: > "$dir/log"

# A line not on screen: refused, nothing typed, the buffer deleted.
printf 'stray' | t load-buffer -b "$BUF" -
out=$(t if-shell -F -t "$p" "$(gate "$GX")" "paste-buffer -d -r -b $BUF -t $p ; send-keys -t $p Enter" "delete-buffer -b $BUF ; $CHANGED")
got=$(logged)
bufs=$(t list-buffers -F '#{buffer_name}')
[ "$out" = "JANTAR-CHANGED" ] && [ -z "$got" ] && [ -z "$bufs" ] && ok "a changed screen: JANTAR-CHANGED, nothing typed, no buffer left" || no "changed: out=$out bytes=$got bufs=$bufs"

# Another tty in the gate (a pane id from another server or a restart): refused.
wrong=$(printf '%s' "$G0" | sed "s|@TTY@|/dev/pts/999|")
out=$(t if-shell -F -t "$p" "$wrong" "send-keys -t $p Enter" "$CHANGED")
got=$(logged)
[ "$out" = "JANTAR-CHANGED" ] && [ -z "$got" ] && ok "another tty in the gate: refused" || no "tty gate: out=$out bytes=$got"

# Copy mode: refused; out of it, typed.
t copy-mode -t "$p"
out=$(t if-shell -F -t "$p" "$(gate "$G0")" "send-keys -t $p Enter" "$CHANGED")
got=$(logged)
[ "$out" = "JANTAR-CHANGED" ] && [ -z "$got" ] && ok "copy mode: refused" || no "copy mode: out=$out bytes=$got"
t send-keys -t "$p" -X cancel
sleep 0.2

# openWindow's new session: 200x50, its pane id and tty reported.
new=$(t new-session -d -s jantar-compat0001 -x 200 -y 50 -P -F '#{pane_id}	#{pane_tty}')
np=$(printf '%s' "$new" | cut -f1)
size=$(t display-message -p -t "$np" '#{pane_width}x#{pane_height}')
case "$new" in %*"	/dev/pts/"*) [ "$size" = "200x50" ] && ok "new-session -d -x 200 -y 50 -P -F: $new $size" || no "size $size" ;; *) no "new-session: $new" ;; esac

t kill-server
rm -rf "$dir"
if [ "$fails" -eq 0 ]; then echo "compat: all checks passed on $(tmux -V)"; else echo "compat: $fails check(s) failed on $(tmux -V)"; exit 1; fi
