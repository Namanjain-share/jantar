// Portions adapted from Shed (c) 2026 Sukhad Anand, MIT. See THIRD_PARTY_NOTICES.md
/**
 * The one AppleScript the Terminal.app backend runs.
 *
 * It is a constant: osascript reads it from stdin (`osascript - <args>`) and
 * every value, the tty and any text to type included, arrives through
 * `argv`. Nothing is ever interpolated into the script, so prompt text can
 * never be parsed as AppleScript (Shed's terminal.js pattern).
 *
 *   argv: <tty> <mode> [<text> [<expected> ...]]
 *   mode find      -> "ok\n<window id>\n<tab index>\n<window name>"
 *   mode contents  -> "ok\n<rows>\n<visible text of the tab>"   (`contents`, never the scrollback `history`;
 *                     <rows> is the tab's `number of rows`, empty when Terminal won't say)
 *   mode type      -> "ok"   (`do script <text> in <tab>`; Terminal always adds a line feed)
 *   mode typeif    -> "ok", or "__JANTAR_CHANGED__" with nothing typed   (v0.4.2 compare-and-type: the
 *                     tab's `contents`, read in this same run, must still contain <expected> exactly,
 *                     case and white space considered, right before `do script <text>`; v0.5.2: with
 *                     two or more, each in order, after the one before, with only a time, 1 to
 *                     TYPEIF_GAP_CHARS digits and colons, between two)
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
 *
 * typeif in parts (v0.5.2): the time in Claude's auto-block countdown inside
 * a dialog changes every second, so a dialog showing one is passed as the
 * two parts around that time alone (terminal/dialog.ts rawExpect). One
 * expected text keeps the `contains` check above, word for word. Several go
 * to the `inOrder` handler, outside the `tell` block so `offset` and `id`
 * are the script's own: each part must be in the text left after the one
 * before (`contains`, then `offset`, then the text found compared with the
 * part again, all under the same `considering`, so an `offset` that ignored
 * case could only refuse), and the text between two parts must be 1 to
 * TYPEIF_GAP_CHARS characters, each a digit or a colon by its Unicode id
 * (`isTime`: no `considering` clause can widen that), so only a time can lie
 * there: never a line, a word or nothing at all. `typeifFinds` is the same
 * decision in TypeScript, for the fakes and the tests.
 */

export const MISSING = '__JANTAR_MISSING__';
export const NOT_RUNNING = '__JANTAR_NOT_RUNNING__';
export const BAD_MODE = '__JANTAR_BAD_MODE__';
/** typeif: the tab no longer showed the expected text, so nothing was typed. */
export const CHANGED = '__JANTAR_CHANGED__';
/**
 * typeif in parts: the most characters between two parts, the countdown's time (`M:SS` for its two minutes,
 * five for `10:00`, or the N of "about N minutes"), each a digit or a colon. The script spells it as
 * `pos > 6` (a part found past the sixth character of the text left).
 */
export const TYPEIF_GAP_CHARS = 5;

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
			if (count of argv) is 4 then
				considering case, diacriticals, hyphens, punctuation and white space
					set stillThere to (seen contains (item 4 of argv))
				end considering
			else
				set stillThere to my inOrder(seen, items 4 thru -1 of argv)
			end if
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

on inOrder(seen, parts)
	set restText to seen
	repeat with k from 1 to count of parts
		set want to item k of parts
		set pos to 0
		considering case, diacriticals, hyphens, punctuation and white space
			if restText contains want then set pos to offset of want in restText
			if pos > 0 then
				if (text pos thru (pos + (length of want) - 1) of restText) is not want then set pos to 0
			end if
		end considering
		if pos is 0 then return false
		if k > 1 then
			if pos < 2 or pos > 6 then return false
			if not my isTime(text 1 thru (pos - 1) of restText) then return false
		end if
		set nextAt to pos + (length of want)
		if nextAt > (length of restText) then
			set restText to ""
		else
			set restText to text nextAt thru -1 of restText
		end if
	end repeat
	return true
end inOrder

on isTime(gap)
	set ids to id of gap
	if class of ids is not list then set ids to {ids}
	repeat with i from 1 to count of ids
		set n to item i of ids
		if n < 48 or n > 58 then return false
	end repeat
	return true
end isTime
`;

/** What may lie between two parts (`isTime`): 1 to TYPEIF_GAP_CHARS digits and colons, nothing else. */
const TYPEIF_GAP = new RegExp(`^[0-9:]{1,${TYPEIF_GAP_CHARS}}$`, 'u');

/**
 * What the script's typeif decides for the tab's text `seen`: one expected
 * text anywhere in it (`contains`); several, each found after the one before
 * with only 1 to TYPEIF_GAP_CHARS digits and colons between two (`inOrder`).
 * For the fakes and the tests; the script decides on the Mac.
 */
export function typeifFinds(seen: string, expect: string | readonly string[]): boolean {
  const parts = typeof expect === 'string' ? [expect] : expect;
  // keys.ts never sends an empty part; were one to come, nothing would count as found.
  if (parts.length === 0 || parts.some((p) => !p)) return false;
  if (parts.length === 1) return seen.includes(parts[0] as string);
  let rest = seen;
  for (const [k, want] of parts.entries()) {
    const at = rest.indexOf(want);
    if (at < 0) return false;
    if (k > 0 && !TYPEIF_GAP.test(rest.slice(0, at))) return false;
    rest = rest.slice(at + want.length);
  }
  return true;
}
