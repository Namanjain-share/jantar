// Portions adapted from Shed (c) 2026 Sukhad Anand, MIT. See THIRD_PARTY_NOTICES.md
/**
 * The constant AppleScript that opens a launch's new Terminal window (work
 * package L; script.ts's pattern). osascript reads it from stdin and the
 * command arrives in argv only; nothing is ever interpolated into it.
 *
 *   argv: <command>
 *   ->    "ok\n<tty>\n<window id>", or "ok\n<tty>\n" when no window has
 *         that tty (the command runs anyway; the launcher watches the tty)
 *
 * - The front window's id is read first, so it can be put back in front
 *   afterwards: someone typing at the Mac keeps their window.
 * - `do script cmd` with no `in`: a new window with one tab and a fresh
 *   login shell. Never `in` an existing tab, which could be a live session
 *   (`do script ... in front window` types into that window's tab).
 * - The new window is found by its tab's tty, walking windows by id, never
 *   by index (windows reorder whenever one is clicked).
 * - No `activate`: Terminal does not come to the front.
 */

/** A plain constant: no `${}` anywhere in it. */
export const TERMINAL_OPEN_SCRIPT = `on run argv
	set cmd to item 1 of argv
	tell application "Terminal"
		set prevWid to missing value
		try
			if (count of windows) > 0 then set prevWid to id of front window
		end try
		set t to do script cmd
		set tt to tty of t
		set wid to missing value
		set wids to id of every window
		repeat with k from 1 to count of wids
			set w to item k of wids
			set n to 0
			try
				set n to count of tabs of window id w
			end try
			repeat with j from 1 to n
				try
					if (tty of tab j of window id w) is tt then set wid to w
				end try
			end repeat
			if wid is not missing value then exit repeat
		end repeat
		if prevWid is not missing value and prevWid is not wid then
			try
				set index of window id prevWid to 1
			end try
		end if
		if wid is missing value then return "ok" & linefeed & tt & linefeed
		return "ok" & linefeed & tt & linefeed & (wid as text)
	end tell
end run
`;
