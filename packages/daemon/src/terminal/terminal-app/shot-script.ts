// Portions adapted from Shed (c) 2026 Sukhad Anand, MIT. See THIRD_PARTY_NOTICES.md
/**
 * The AppleScript behind terminal screenshots (work package C owns this
 * file). Like TERMINAL_APP_SCRIPT it is a constant: osascript reads it from
 * stdin (`osascript - <args>`) and every value arrives through `argv`, so
 * nothing is ever interpolated into it. It finds the tab with script.ts's
 * lookup (Shed's findTab: tty plus a live process count; windows walked by
 * id, from the legacy ccw tool) and never activates Terminal, raises a
 * window or de-miniaturizes one.
 *
 *   argv: <tty> <mode> [<previous tty>]
 *   mode shotinfo -> "ok\n<window id>\n<tab selected>\n<window index>\n<window frontmost>\n<miniaturized>\n<visible>\n<Terminal frontmost>"
 *                    (booleans as "true" / "false"; no side effects)
 *   mode select   -> "ok\n<tty of the tab that was showing>" after selecting
 *                    ours in its window; "__JANTAR_IN_USE__" (and nothing
 *                    selected) while Terminal is the active app and this is
 *                    its front window, where the switch would take the
 *                    user's keystrokes. Checked in the same run as the switch.
 *                    "ok" alone (nothing selected) when the showing tab's tty
 *                    can't be read, since that tab could not be put back.
 *   mode restore  -> "ok\nrestored" after re-selecting the tab on <previous
 *                    tty> in the same window; "ok\nmoved" when our tab is no
 *                    longer the one showing (the user switched tabs meanwhile:
 *                    their choice stands); "ok\ngone" when that tab closed.
 *   tab not found  -> "__JANTAR_MISSING__"
 *   Terminal closed-> "__JANTAR_NOT_RUNNING__"
 */

export const SHOT_IN_USE = '__JANTAR_IN_USE__';

export type ShotScriptMode = 'shotinfo' | 'select' | 'restore';

/** A plain constant: no `${}` anywhere in it. */
export const SHOT_SCRIPT = `on run argv
	set wantTty to item 1 of argv
	set mode to item 2 of argv
	if application "Terminal" is not running then return "__JANTAR_NOT_RUNNING__"
	tell application "Terminal"
		set foundWid to missing value
		set foundIdx to 0
		set wids to id of every window
		repeat with k from 1 to count of wids
			set wid to item k of wids
			set n to 0
			try
				set n to count of tabs of window id wid
			end try
			repeat with j from 1 to n
				set hit to false
				try
					if (tty of tab j of window id wid) is wantTty then
						if (count of processes of tab j of window id wid) > 0 then set hit to true
					end if
				end try
				if hit then
					set foundWid to wid
					set foundIdx to j
					exit repeat
				end if
			end repeat
			if foundWid is not missing value then exit repeat
		end repeat
		if foundWid is missing value then return "__JANTAR_MISSING__"
		set appFront to frontmost
		set winFront to false
		try
			set winFront to frontmost of window id foundWid
		end try
		if mode is "shotinfo" then
			set mini to false
			set vis to true
			try
				set mini to miniaturized of window id foundWid
			end try
			try
				set vis to visible of window id foundWid
			end try
			set sel to selected of tab foundIdx of window id foundWid
			set widx to index of window id foundWid
			return "ok" & linefeed & (foundWid as text) & linefeed & (sel as text) & linefeed & (widx as text) & linefeed & (winFront as text) & linefeed & (mini as text) & linefeed & (vis as text) & linefeed & (appFront as text)
		else if mode is "select" then
			if appFront and winFront then return "__JANTAR_IN_USE__"
			set prevTty to ""
			try
				set prevTty to tty of selected tab of window id foundWid
			end try
			if prevTty is "" then return "ok"
			set selected of tab foundIdx of window id foundWid to true
			return "ok" & linefeed & prevTty
		else if mode is "restore" then
			set prevTty to item 3 of argv
			if not (selected of tab foundIdx of window id foundWid) then return "ok" & linefeed & "moved"
			set n to count of tabs of window id foundWid
			repeat with j from 1 to n
				set same to false
				try
					if (tty of tab j of window id foundWid) is prevTty then set same to true
				end try
				if same then
					set selected of tab j of window id foundWid to true
					return "ok" & linefeed & "restored"
				end if
			end repeat
			return "ok" & linefeed & "gone"
		end if
	end tell
	return "__JANTAR_BAD_MODE__"
end run
`;
