/**
 * v0.12 People: Join (`/p/join#c=<code>`) and Link (`/p/link#c=<code>`).
 *
 * Join reads the code from the fragment (it never reaches a log), previews
 * the offer without spending it, and renders the page from the offer's
 * explicit fields (join/copy.ts). Each `see` line has a switch that only
 * goes down; Accept sends `acceptedVersion` and the agreement as she left
 * it (the daemon clamps it to the offer). "Not now" spends nothing.
 */
import { useEffect, useMemo, useState } from 'react';
import { AGREEMENT_FIELDS, closeDependents, withField, type AgreementFields } from '@jantar/protocol/people-core';
import type { JoinPreview } from '@jantar/protocol/people';
import { Button } from '../../ui/kit/Button.js';
import { navigate, Page } from '../App.js';
import type { PersonApi } from '../api.js';
import { joinCopy, lowerLevels, type CopyLine } from '../join/copy.js';

const codeFromHash = () => new URLSearchParams(location.hash.replace(/^#/, '')).get('c') ?? '';

function levelLabel(v: string | boolean): string {
  if (v === true) return 'On';
  if (v === false || v === 'off') return 'Off';
  return v === 'adherence' ? 'Only how often' : v === 'counts' ? 'Only counts' : 'All';
}

export function Join({ api, mode }: { api: PersonApi; mode: 'join' | 'link' }) {
  const [code] = useState(codeFromHash);
  const [preview, setPreview] = useState<JoinPreview | null>(null);
  const [agreement, setAgreement] = useState<AgreementFields | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adult, setAdult] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [deviceName] = useState(() => (typeof navigator !== 'undefined' && /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : 'Phone'));

  useEffect(() => {
    if (mode !== 'join' || !code) return;
    api.joinPreview(code).then(
      (p) => {
        setPreview(p);
        setAgreement(p.offer);
        setName(p.name);
      },
      (e: Error) => setError(e.message),
    );
  }, [api, code, mode]);

  const copy = useMemo(
    () => (preview && agreement ? joinCopy(preview.owner, agreement, { built: preview.built, foodModule: preview.modules.food }) : null),
    [preview, agreement],
  );

  if (mode === 'link') {
    return (
      <Page title="Link this device">
        <LinkForm api={api} initial={code} deviceName={deviceName} />
      </Page>
    );
  }
  if (!code) return <Page title="Open your invite link">This page needs the link you were sent.</Page>;
  if (error && !preview) return <Page title="This link doesn't work">{error}</Page>;
  if (!preview || !agreement || !copy) return <Page title="Joining">Loading…</Page>;

  const lower = (line: CopyLine, value: string | boolean) => {
    const field = AGREEMENT_FIELDS.find((f) => f.key === line.key);
    if (!field) return;
    setAgreement(closeDependents(withField(agreement, field, value)));
  };

  const accept = async () => {
    setBusy(true);
    try {
      await api.join({ code, acceptedVersion: preview.version, agreement, name: name.trim() || preview.name, deviceName });
      navigate('/p');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page title={copy.heading}>
      <p className="text-ink-2">{copy.intro}</p>
      <h2 className="mt-24 font-semibold">What {preview.owner} can see</h2>
      <ul className="mt-8 flex flex-col gap-8" aria-label="What can be seen">
        {copy.sees.map((line) => (
          <li key={line.key ?? line.text} className="flex items-start justify-between gap-12">
            <span>{line.text}</span>
            {line.levels && line.level !== undefined && lowerLevels(line).length + 1 > 1 ? (
              <select
                aria-label={`Level for ${line.key}`}
                className="rounded-btn border border-line bg-bg px-8 text-small"
                value={String(line.level)}
                onChange={(e) => {
                  const picked = line.levels?.find((l) => String(l) === e.target.value);
                  if (picked !== undefined) lower(line, picked);
                }}
              >
                {[...lowerLevels(line), line.level].map((l) => (
                  <option key={String(l)} value={String(l)}>
                    {levelLabel(l)}
                  </option>
                ))}
              </select>
            ) : null}
          </li>
        ))}
      </ul>
      <h2 className="mt-24 font-semibold">What {preview.owner} can do</h2>
      <ul className="mt-8 list-disc pl-20">{copy.does.map((l) => <li key={l.text}>{l.text}</li>)}</ul>
      <h2 className="mt-24 font-semibold">What {preview.owner} can't do</h2>
      <ul className="mt-8 list-disc pl-20">{copy.cant.map((t) => <li key={t}>{t}</li>)}</ul>
      <h2 className="mt-24 font-semibold">Always yours</h2>
      <ul className="mt-8 list-disc pl-20">{copy.yours.map((t) => <li key={t}>{t}</li>)}</ul>
      <h2 className="mt-24 font-semibold">The honest small print</h2>
      <ul className="mt-8 list-disc pl-20 text-small text-ink-2">{copy.smallPrint.map((t) => <li key={t}>{t}</li>)}</ul>
      <label className="mt-24 flex min-h-44 items-center gap-8">
        <span>Your name</span>
        <input className="flex-1 rounded-btn border border-line bg-bg px-8 py-4" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="flex min-h-44 items-center gap-8">
        <input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} />
        <span>I'm 18 or older</span>
      </label>
      {error ? <p role="alert" className="mt-8 font-medium text-ink">{error}</p> : null}
      <div className="mt-16 flex gap-12">
        <Button variant="primary" size="xl" disabled={!adult || busy} onClick={() => void accept()}>
          Accept and join
        </Button>
        <Button variant="text" size="xl" onClick={() => history.back()}>
          Not now
        </Button>
      </div>
    </Page>
  );
}

function LinkForm({ api, initial, deviceName }: { api: PersonApi; initial: string; deviceName: string }) {
  const [code, setCode] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        api.linkClaim(code.trim(), deviceName).then(
          () => navigate('/p'),
          (err: Error) => setError(err.message),
        );
      }}
    >
      <p className="text-ink-2">On a device that is linked already, open Me › Devices › Link another device, then enter the code here.</p>
      <input aria-label="Link code" className="mt-12 w-full rounded-btn border border-line bg-bg px-8 py-8" value={code} onChange={(e) => setCode(e.target.value)} />
      {error ? <p role="alert" className="mt-8 font-medium text-ink">{error}</p> : null}
      <Button className="mt-12" variant="primary" size="xl" type="submit" disabled={code.trim().length < 16}>
        Link this device
      </Button>
    </form>
  );
}
