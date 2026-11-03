// Portions adapted from Noblot (c) 2026 Naman Jain. See THIRD_PARTY_NOTICES.md (jantar-secrets-allow: the licensor, as in LICENSE)
// Minimal RFC-4180 CSV, both directions. Lives in core so the export, the import preview and
// the importer all agree on quoting — and so there is no csv dependency for ~70 lines.

export type CsvCell = string | number | boolean | Date | null | undefined;

/**
 * Cells a spreadsheet would EXECUTE rather than display.
 *
 * Excel, Google Sheets and LibreOffice all treat a cell beginning `=`, `+`, `@`, a tab or a CR as a
 * formula. A client named `=HYPERLINK("http://…","Click")` becomes a live formula in the file its
 * owner downloads and opens. Quoting does not help: the quotes are stripped by the parser before
 * the formula is evaluated.
 *
 * `-` is deliberately NOT in this class on its own. Money columns export negatives, and prefixing
 * `-5` would turn a number into text in a spreadsheet's eyes. A leading `-` is only a formula when
 * what follows is not a number.
 */
const FORMULA_LEAD = /^[=+@\t\r]/;
const DANGEROUS_MINUS = /^-(?![\d.])/;

/** The prefix that makes a spreadsheet display a formula instead of running it. Stripped again by
 *  `parseCsv`, so a file exported from here still re-imports as itself. */
const GUARD = "'";

function cell(value: CsvCell): string {
  if (value === null || value === undefined) return "";
  const raw = value instanceof Date ? value.toISOString() : String(value);
  // Only STRINGS are guarded. A number arrives as a number and stays one, so `-5` is untouched.
  const s =
    typeof value === "string" && (FORMULA_LEAD.test(raw) || DANGEROUS_MINUS.test(raw))
      ? GUARD + raw
      : raw;
  // Quote when the cell contains a delimiter, a quote, a newline, or edge whitespace
  // (Excel eats leading spaces otherwise).
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Undo {@link cell}'s formula guard. Exactly one leading `'` is removed, and only when what
 *  follows would itself have been guarded — so a value that genuinely starts with an apostrophe
 *  ("'tis") is never touched. */
export function unguardCsvCell(s: string): string {
  if (!s.startsWith(GUARD)) return s;
  const rest = s.slice(1);
  return FORMULA_LEAD.test(rest) || DANGEROUS_MINUS.test(rest) ? rest : s;
}

/** CRLF line endings — what Excel and Google Sheets both expect. */
export function toCsv(headers: readonly string[], rows: readonly CsvCell[][]): string {
  return [headers.map(cell).join(","), ...rows.map((r) => r.map(cell).join(","))].join("\r\n");
}

/**
 * Parse into a raw grid. Handles quoted fields containing commas / newlines / doubled
 * quotes, a UTF-8 BOM, and either line ending. Blank lines are dropped.
 */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let started = false; // distinguishes a real (possibly empty) field from a blank line

  const endField = () => {
    // Symmetric with `cell`'s formula guard: a file exported from here re-imports as-is.
    row.push(unguardCsvCell(field));
    field = "";
    started = false;
  };
  const endRow = () => {
    endField();
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && !started) {
      quoted = true;
      started = true;
    } else if (ch === ",") {
      endField();
    } else if (ch === "\r") {
      if (src[i + 1] === "\n") i++;
      endRow();
    } else if (ch === "\n") {
      endRow();
    } else {
      field += ch;
      started = true;
    }
  }
  if (field !== "" || row.length > 0) endRow();

  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** Grid → header list + header-keyed row objects. Short rows are padded with "". */
export function toCsvRows(grid: string[][]): {
  headers: string[];
  rows: Record<string, string>[];
} {
  const [headers, ...body] = grid;
  if (!headers) return { headers: [], rows: [] };
  const trimmed = headers.map((h) => h.trim());
  return {
    headers: trimmed,
    rows: body.map((cells) =>
      Object.fromEntries(trimmed.map((h, i) => [h, (cells[i] ?? "").trim()])),
    ),
  };
}
