import type { LogFields, Logger } from '../contracts.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Keys whose values are never written to logs. */
const REDACT = /^(text|prompt|body|token|key|secret|password|authorization|cookie|code|deviceKey)$/i;

export function redactFields(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) out[k] = REDACT.test(k) ? '[redacted]' : v;
  return out;
}

/**
 * JSON-lines logger. Writes to `write` (default: stderr, which launchd sends
 * to the log file). Field names that usually carry secrets or prompt bodies
 * are redacted.
 */
export function createLogger(
  opts: { level?: LogLevel; write?: (line: string) => void; bindings?: LogFields; now?: () => number } = {},
): Logger {
  const level = ORDER[opts.level ?? 'info'];
  const write = opts.write ?? ((line: string) => process.stderr.write(line));
  const now = opts.now ?? Date.now;
  const bindings = opts.bindings ?? {};
  const log = (lvl: LogLevel, msg: string, fields?: LogFields) => {
    if (ORDER[lvl] < level) return;
    const rec = { t: new Date(now()).toISOString(), level: lvl, msg, ...redactFields({ ...bindings, ...fields }) };
    let line: string;
    try {
      line = JSON.stringify(rec);
    } catch {
      line = JSON.stringify({ t: rec.t, level: lvl, msg, note: 'unserializable fields' });
    }
    write(`${line}\n`);
  };
  return {
    debug: (m, f) => log('debug', m, f),
    info: (m, f) => log('info', m, f),
    warn: (m, f) => log('warn', m, f),
    error: (m, f) => log('error', m, f),
    child: (b) => createLogger({ ...opts, bindings: { ...bindings, ...b } }),
  };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};

export interface LogRecord {
  level: LogLevel;
  msg: string;
  fields: LogFields;
}

/** A logger that keeps records in memory (for tests). */
export function memoryLogger(): Logger & { records: LogRecord[] } {
  const records: LogRecord[] = [];
  const make = (bindings: LogFields): Logger => ({
    debug: (msg, f) => records.push({ level: 'debug', msg, fields: { ...bindings, ...f } }),
    info: (msg, f) => records.push({ level: 'info', msg, fields: { ...bindings, ...f } }),
    warn: (msg, f) => records.push({ level: 'warn', msg, fields: { ...bindings, ...f } }),
    error: (msg, f) => records.push({ level: 'error', msg, fields: { ...bindings, ...f } }),
    child: (b) => make({ ...bindings, ...b }),
  });
  return Object.assign(make({}), { records });
}
