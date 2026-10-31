// Portions adapted from Shed (c) 2026 Sukhad Anand, MIT. See THIRD_PARTY_NOTICES.md
/**
 * The one AppleScript the Terminal.app backend runs.
 *
 * It is a constant: osascript reads it from stdin (`osascript - <args>`) and
 * every value, the tty and any text to type included, arrives through
 * `argv`. Nothing is ever interpolated into the script, so prompt text can
 * never be parsed as AppleScript (Shed's terminal.js pattern).
 *
 *   argv: <tty> <mode> [<text> [<expected>]]
 *   mode find      -> "ok\n<window id>\n<tab index>\n<window name>"
 *   mode contents  -> "ok\n<rows>\n<visible text of the tab>"   (`contents`, never the scrollback `history`;
 *                     <rows> is the tab's `number of rows`, empty when Terminal won't say)
 *   mode type      -> "ok"   (`do script <text> in <tab>`; Terminal always adds a line feed)
 *   mode typeif    -> "ok", or "__JANTAR_CHANGED__" with nothing typed   (v0.4.2 compare-and-type: the
 *                     tab's `contents`, read in this same run, must still contain <expected> exactly,
 *                     case and white space considered, right before `do script <text>`)
 *   mode focus     -> "ok"   (select the tab, raise its window, activate Terminal)
 *   tab not found  -> "__JANTAR_MISSING__"
 *   Terminal closed-> "__JANTAR_NOT_RUNNING__"   (it is never launched just to look)
 *
 * Finding the tab:
 * - Match `tty of tab` and require `count of processes > 0`: finished tabs
 *   keep their tty name, which macOS reuses for new tabs (Shed's findTab).
 * - Walk windows by id, not by index: windows reorder whenever one is
 *   clicked, and an index read twice could name two different windows
 *   (from the legacy ccw tool's window script).
 * - Name the tab in full every time (`contents of tab j of window id w`), never
 *   through a variable: `contents of <variable>` can mean "the variable's
 *   value" instead of the tab's text (also learned in ccw).
 *
 * typeif (v0.4.2): the dialog answers and the keypad read the screen, check
 * it, and type in two osascript runs a few hundred ms apart, open to the
 * Mac's own keyboard. Reading the tab again inside the run that types, in
 * the same `tell` that found it, leaves only the moment between Terminal's
 * `contents` and its `do script`. The caller passes the dialog's own lines
 * exactly as an earlier `contents` gave them (terminal/dialog.ts rawSlice).
 */

export const MISSING = '__JANTAR_MISSING__';
export const NOT_RUNNING = '__JANTAR_NOT_RUNNING__';
export const BAD_MODE = '__JANTAR_BAD_MODE__';
/** typeif: the tab no longer showed the expected text, so nothing was typed. */
export const CHANGED = '__JANTAR_CHANGED__';

export type ScriptMode = 'find' | 'contents' | 'type' | 'typeif' | 'focus';

/** A plain constant: no `${}` anywhere in it. */
export const TERMINAL_APP_SCRIPT = `on run argv
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
		if mode is "find" then
			set wname to ""
			try
				set wname to name of window id foundWid
			end try
			return "ok" & linefeed & (foundWid as text) & linefeed & (foundIdx as text) & linefeed & wname
		else if mode is "contents" then
			set nrows to ""
			try
				set nrows to (number of rows of tab foundIdx of window id foundWid) as text
			end try
			return "ok" & linefeed & nrows & linefeed & (contents of tab foundIdx of window id foundWid)
		else if mode is "type" then
			do script (item 3 of argv) in tab foundIdx of window id foundWid
			return "ok"
		else if mode is "typeif" then
			set seen to contents of tab foundIdx of window id foundWid
			considering case, diacriticals, hyphens, punctuation and white space
				set stillThere to (seen contains (item 4 of argv))
			end considering
			if not stillThere then return "__JANTAR_CHANGED__"
			do script (item 3 of argv) in tab foundIdx of window id foundWid
			return "ok"
		else if mode is "focus" then
			set selected of tab foundIdx of window id foundWid to true
			set index of window id foundWid to 1
			activate
			return "ok"
		end if
	end tell
	return "__JANTAR_BAD_MODE__"
end run
`;
