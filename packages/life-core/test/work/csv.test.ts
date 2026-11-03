// Portions adapted from Noblot (c) 2026 Naman Jain. See THIRD_PARTY_NOTICES.md (jantar-secrets-allow: the licensor, as in LICENSE)
import { describe, it, expect } from "vitest";
import { parseCsv, toCsv, toCsvRows } from "../../src/work/csv.js";

describe("toCsv", () => {
  it("quotes only cells that need it", () => {
    expect(toCsv(["a", "b"], [["plain", "has,comma"]])).toBe('a,b\r\nplain,"has,comma"');
  });

  it("escapes embedded quotes by doubling and keeps newlines inside quotes", () => {
    expect(toCsv(["a"], [['say "hi"']])).toBe('a\r\n"say ""hi"""');
    expect(toCsv(["a"], [["line1\nline2"]])).toBe('a\r\n"line1\nline2"');
  });

  it("renders null/undefined as empty and prefixes a leading-space cell", () => {
    expect(toCsv(["a", "b"], [[null, undefined]])).toBe("a,b\r\n,");
    expect(toCsv(["a"], [[" lead"]])).toBe('a\r\n" lead"');
  });
});

describe("parseCsv", () => {
  it("round-trips what toCsv produced", () => {
    const rows = [
      ["plain", "has,comma", 'say "hi"', "line1\nline2", ""],
      ["x", "y", "z", "w", "v"],
    ];
    expect(parseCsv(toCsv(["a", "b", "c", "d", "e"], rows))).toEqual([
      ["a", "b", "c", "d", "e"],
      ...rows,
    ]);
  });

  it("accepts LF, CRLF and a UTF-8 BOM", () => {
    expect(parseCsv("\uFEFFa,b\nc,d\r\ne,f")).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
    ]);
  });

  it("drops a trailing newline without emitting a phantom row", () => {
    expect(parseCsv("a,b\r\nc,d\r\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("keeps a genuinely blank line out of the output", () => {
    expect(parseCsv("a\n\nb")).toEqual([["a"], ["b"]]);
  });

  it("returns [] for empty input", () => {
    expect(parseCsv("")).toEqual([]);
    expect(parseCsv("   ")).toEqual([]);
  });
});

describe("toCsvRows", () => {
  it("maps header→row objects and skips rows with too few cells", () => {
    const res = toCsvRows(parseCsv("Name,Email\nRiya,riya@x.example\nSolo"));
    expect(res.headers).toEqual(["Name", "Email"]);
    expect(res.rows).toEqual([
      { Name: "Riya", Email: "riya@x.example" },
      { Name: "Solo", Email: "" },
    ]);
  });

  it("returns an empty result for a headerless file", () => {
    expect(toCsvRows([])).toEqual({ headers: [], rows: [] });
  });
});

// ── Formula injection ─────────────────────────────────────────────────────────────────────────
//
// Excel, Sheets and LibreOffice all EXECUTE a cell beginning `=`, `+`, `@`, a tab or a CR. Every
// string in a client is his or someone else's, so a client's name or note is enough to put a live
// formula in the file its owner downloads.
// Quoting does not help — the parser strips quotes before evaluating.
describe("toCsv — formula injection", () => {
  it("neutralises a cell a spreadsheet would execute", () => {
    const out = toCsv(["name"], [['=HYPERLINK("http://evil","Click")']]);
    expect(out, "an exported cell still begins with = and will run on open").not.toMatch(/(^|,|")=/m);
    expect(out).toContain("'=HYPERLINK");
  });

  it("covers every lead character a spreadsheet treats as a formula", () => {
    for (const lead of ["=", "+", "@", "\t", "\r"]) {
      const out = toCsv(["c"], [[`${lead}cmd`]]);
      expect(out, `a cell starting ${JSON.stringify(lead)} was not guarded`).toContain(`'${lead}cmd`);
    }
    // A bare `-` followed by a non-digit is a formula too.
    expect(toCsv(["c"], [["-SUM(A1)"]])).toContain("'-SUM(A1)");
  });

  it("guards a `-` cell that starts with a digit but is not a plain number (a sum, the DDE payload)", () => {
    // A digit after the `-` does not make the cell a number: `-1+1` is a formula, and the classic
    // DDE payload starts `-2+3+`. Each of these came from a file, a card or a meeting before.
    for (const v of [
      "-2+3+cmd|' /C calc'!A0",
      '-0+HYPERLINK("https://evil.example/c","Open")',
      "-1+1",
      "-9+9",
      "-1+1 retainer",
      "-.5+1",
      "-5 ",
      "-12.50.1",
    ]) {
      const out = toCsv(["c"], [[v]]).split("\r\n")[1]!;
      expect(out, `${JSON.stringify(v)} left unguarded`).toMatch(/^"?'-/);
    }
  });

  it("leaves NEGATIVE NUMBERS alone — the sums the export exists for depend on it", () => {
    // A money column is the most common thing exported here. `'-1250` is text to a spreadsheet, so
    // guarding it would silently break every total in the file.
    expect(toCsv(["amount"], [[-1250]])).toContain("-1250");
    expect(toCsv(["amount"], [[-1250]])).not.toContain("'-1250");
    expect(toCsv(["amount"], [["-12.50"]])).not.toContain("'-12.50");
    expect(toCsv(["amount"], [["-.5"]])).not.toContain("'-.5");
    expect(toCsv(["amount"], [["-5"]])).toBe("amount\r\n-5");
    // ANCHOR: the guard is otherwise working in this very same call shape.
    expect(toCsv(["amount"], [["-abc"]])).toContain("'-abc");
  });

  it("round-trips: a file exported from here re-imports as itself", () => {
    // The import dialog promises exactly this, so the guard has to be symmetric.
    const rows = [['=HYPERLINK("x","y")'], ["-SUM(A1)"], ["ordinary"], ["'tis a quote"], ["-5"], ["-1+1"], ["-2+3+cmd|' /C calc'!A0"]];
    const parsed = parseCsv(toCsv(["c"], rows)).slice(1);
    expect(parsed.map((r) => r[0])).toEqual(['=HYPERLINK("x","y")', "-SUM(A1)", "ordinary", "'tis a quote", "-5", "-1+1", "-2+3+cmd|' /C calc'!A0"]);
  });
});
