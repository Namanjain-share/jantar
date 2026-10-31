/**
 * Synthetic cswap data: accounts, sequence.json, cache/usage.json (schema 2)
 * and `cswap list --json` output (schema 1). Addresses use the reserved
 * example.* domains; uuids are obviously fake.
 */

export interface FakeAccount {
  id: number;
  email: string;
  alias?: string;
  disabled?: boolean;
  organizationUuid: string;
  organizationName: string;
  uuid: string;
  /** cswap usageStatus this account reports. */
  usageStatus: 'ok' | 'relogin_required' | 'unavailable' | 'token_expired';
  fiveHourPct: number;
  sevenDayPct: number;
  /** Minutes until the 5-hour window resets. */
  fiveHourResetMin: number;
  /** Seconds since the usage was fetched. */
  ageS: number;
  /** null = the default login (~/.claude); otherwise the profile dir name "<n>-<slug>". */
  profile: string | null;
}

/** cswap's profile slug: non-ascii-alnum characters other than ._- become "_". */
export function slugifyEmail(email: string): string {
  return [...email.normalize('NFC')].map((ch) => (/^[A-Za-z0-9._-]$/.test(ch) ? ch : '_')).join('');
}

export function profileDirName(id: number, email: string): string {
  return `${id}-${slugifyEmail(email)}`;
}

const fakeUuid = (n: number, tag = '0') => `00000000-0000-4000-8000-${tag.repeat(10)}${n.toString(16).padStart(2, '0')}`;

/** Account 1 is the default login; 2-4 have cswap profiles. */
export function defaultAccounts(): FakeAccount[] {
  return [
    {
      id: 1,
      email: 'alpha@example.com',
      organizationUuid: '',
      organizationName: '',
      uuid: fakeUuid(1),
      usageStatus: 'ok',
      fiveHourPct: 42,
      sevenDayPct: 18,
      fiveHourResetMin: 130,
      ageS: 45,
      profile: null,
    },
    {
      id: 2,
      email: 'bravo@example.com',
      alias: 'team-b',
      organizationUuid: fakeUuid(2, 'b'),
      organizationName: 'Example Org',
      uuid: fakeUuid(2),
      usageStatus: 'ok',
      fiveHourPct: 88,
      sevenDayPct: 61,
      fiveHourResetMin: 40,
      ageS: 120,
      profile: profileDirName(2, 'bravo@example.com'),
    },
    {
      id: 3,
      email: 'charlie@example.org',
      disabled: true,
      organizationUuid: '',
      organizationName: '',
      uuid: fakeUuid(3),
      usageStatus: 'relogin_required',
      fiveHourPct: 0,
      sevenDayPct: 0,
      fiveHourResetMin: 300,
      ageS: 4000,
      profile: profileDirName(3, 'charlie@example.org'),
    },
    {
      id: 4,
      email: 'delta@example.net',
      organizationUuid: '',
      organizationName: '',
      uuid: fakeUuid(4),
      usageStatus: 'unavailable',
      fiveHourPct: 97,
      sevenDayPct: 96,
      fiveHourResetMin: 12,
      ageS: 900,
      profile: profileDirName(4, 'delta@example.net'),
    },
  ];
}

const isoS = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

export function sequenceJson(accounts: readonly FakeAccount[], now: number, active = 1): Record<string, unknown> {
  return {
    activeAccountNumber: active,
    lastUpdated: new Date(now - 3600_000).toISOString(),
    sequence: accounts.map((a) => a.id),
    accounts: Object.fromEntries(
      accounts.map((a) => {
        const row: Record<string, unknown> = {
          email: a.email,
          uuid: a.uuid,
          organizationUuid: a.organizationUuid,
          organizationName: a.organizationName,
          added: '2026-01-01T00:00:00Z',
        };
        if (a.alias) row.alias = a.alias;
        if (a.disabled) row.disabled = true;
        return [String(a.id), row];
      }),
    ),
  };
}

function lastGood(a: FakeAccount, now: number) {
  const fetched = now - a.ageS * 1000;
  return {
    five_hour: { pct: a.fiveHourPct, resets_at: new Date(now + a.fiveHourResetMin * 60_000).toISOString() },
    seven_day: { pct: a.sevenDayPct, resets_at: new Date(fetched + 3 * 86_400_000).toISOString() },
    scoped: [{ name: 'Model-A', pct: Math.round(a.sevenDayPct / 2), resets_at: new Date(fetched + 3 * 86_400_000).toISOString() }],
  };
}

/** cache/usage.json, schemaVersion 2 (epoch seconds, identity-guarded rows). */
export function usageCacheJson(accounts: readonly FakeAccount[], now: number): Record<string, unknown> {
  const rows: Record<string, unknown> = {};
  for (const a of accounts) {
    const fetchedAt = (now - a.ageS * 1000) / 1000;
    const row: Record<string, unknown> = {
      email: a.email,
      organizationUuid: a.organizationUuid,
      fetchedAt,
      lastAttemptAt: fetchedAt,
      consecutiveFailures: 0,
      lastError: null,
      backoffUntil: null,
      nextPollAt: fetchedAt + 300,
      pollIntervalS: 300,
      authDeadStrikes: 0,
      claimId: null,
      claimUntil: 0,
    };
    if (a.usageStatus !== 'relogin_required') row.lastGood = lastGood(a, now);
    if (a.usageStatus === 'unavailable') {
      row.consecutiveFailures = 2;
      row.lastError = 'http-429';
      row.last429At = now / 1000 - 60;
      row.backoffUntil = now / 1000 + 900;
    }
    if (a.usageStatus === 'relogin_required') {
      row.lastError = 'invalid_grant';
      row.authDeadStrikes = 2;
    }
    rows[String(a.id)] = row;
  }
  return { schemaVersion: 2, accounts: rows };
}

function windowJson(pct: number, resetsAt: string, weekly: boolean) {
  const w: Record<string, unknown> = { pct, resetsAt, countdown: '1h 0m', clock: '00:00' };
  if (weekly) {
    w.expectedPct = 50;
    w.aheadOfPace = pct > 50;
    w.willLastToReset = pct < 90;
  }
  return w;
}

/** `cswap list --json` output (schemaVersion 1). */
export function cswapListJson(accounts: readonly FakeAccount[], now: number, active = 1): Record<string, unknown> {
  return {
    schemaVersion: 1,
    activeAccountNumber: active,
    accounts: accounts.map((a) => {
      const lg = lastGood(a, now);
      const usage = {
        fiveHour: windowJson(a.fiveHourPct, lg.five_hour.resets_at, false),
        sevenDay: windowJson(a.sevenDayPct, lg.seven_day.resets_at, true),
        scoped: lg.scoped.map((s) => ({ ...windowJson(s.pct, s.resets_at, true), name: s.name })),
      };
      const row: Record<string, unknown> = {
        number: a.id,
        email: a.email,
        organizationName: a.organizationName,
        organizationUuid: a.organizationUuid,
        isOrganization: Boolean(a.organizationUuid),
        active: a.id === active,
        usageStatus: a.usageStatus,
        usage: a.usageStatus === 'ok' ? usage : null,
      };
      if (a.alias) row.alias = a.alias;
      if (a.disabled) row.disabled = true;
      const fetched = isoS(now - a.ageS * 1000);
      if (a.usageStatus === 'ok') {
        row.usageFetchedAt = fetched;
        row.usageAgeSeconds = a.ageS;
      } else if (a.usageStatus === 'unavailable') {
        row.lastGoodUsage = usage;
        row.lastGoodFetchedAt = fetched;
        row.lastGoodAgeSeconds = a.ageS;
      }
      return row;
    }),
  };
}
