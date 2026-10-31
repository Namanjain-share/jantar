/**
 * Display helpers for transcript text, ported from ccw (headline, tool_desc).
 */
import { basename } from 'node:path';
import { isObj } from './values.js';

/** The line of a message most worth showing: its last question, else its first line. */
export function headline(text: string | undefined): string {
  const lines: string[] = [];
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const line = raw
      .replace(/^\s*(#+|>|[-*•]|\d+[.)])\s+/, '')
      .replaceAll('**', '')
      .replaceAll('`', '')
      .trim();
    if (line && !line.startsWith('```') && !/^[-=|:\s]+$/.test(line)) lines.push(line);
  }
  const asks = lines.filter((l) => l.endsWith('?'));
  return asks.at(-1) ?? lines[0] ?? '';
}

/** "Bash · npm test", "Edit · header.tsx", "plan ready for your approval", ... */
export function toolDesc(name: string, input: unknown): string {
  const shown = name.replaceAll('mcp__', '').replaceAll('__', '·');
  const args = isObj(input) ? input : {};
  if (shown === 'ExitPlanMode') return 'plan ready for your approval';
  if (shown === 'AskUserQuestion') {
    const qs = Array.isArray(args.questions) ? args.questions : [];
    const q = isObj(qs[0]) && typeof qs[0].question === 'string' ? qs[0].question : '';
    return `asks · ${q}`;
  }
  for (const key of ['description', 'command', 'file_path', 'pattern', 'url', 'query', 'skill', 'prompt']) {
    const v = args[key];
    if (typeof v === 'string' && v.trim()) {
      const first = v.trim().split(/\r?\n/)[0] ?? '';
      return `${shown} · ${key === 'file_path' ? basename(first) : first}`;
    }
  }
  return shown;
}
