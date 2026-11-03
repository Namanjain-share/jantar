/**
 * v0.11 People: Join (`/p/join#c=<code>`) and Link (`/p/link#c=<code>`).
 *
 * Join reads the code from the fragment (it never reaches a log), previews
 * the offer without spending it, and renders the page from the offer's
 * explicit fields (people-shared/join-copy.ts). Each `see` line has a switch that only
 * goes down; Accept sends `acceptedVersion` and the agreement as she left
 * it (the daemon clamps it to the offer). "Not now" spends nothing.
 *
 * After Accept and join, the same first steps as his pairing: on an iPhone,
 * Add to Home Screen (Web Push works only from there), then Turn on
 * notifications with a test push, then Today. Plan pushes, step rings and
 * alerts can't reach her phone before that.
 *
 * 0.12.1: /p/join without its code. Signing in to Access with the One-time
 * PIN brings her back here without the `#c=` (an identity provider that
 * carries state, like Google, keeps the link whole), so the page says to
 * open the link once more, or paste it. A pasted link shows the same
 * preview, and nothing is spent before Accept and join.
 *
 * 0.12.1: opening the link again in the same tab (pasted into the address
 * bar, or Android reusing the tab) changes only the fragment, so while no
 * preview shows the page follows `hashchange` (and `popstate`) to the new
 * code. Without a code it first asks her app's own check (api.me()) whether
 * this device is in already (a reload after Accept, a tab Safari dropped):
 * then it goes on to her Today, or back to her first steps, which Accept
 * keeps in the address (`/p/join?step=home|notify`) so a reload finds them.
 */
import { useEffect, useId, useMemo, useState } from 'react';
import { AGREEMENT_FIELDS, closeDependents, withField, yourLabel, type AgreementFields } from '@jantar/protocol/people-core';
import type { JoinPreview, PersonMe } from '@jantar/protocol/people';
import { Button } from '../../ui/kit/Button.js';
import { Page } from '../App.js';
import { navigate } from '../nav.js';
import type { PersonApi } from '../api.js';
import { joinCopy, levelLabel, lowerLevels, switchLabel, type CopyLine } from '../../people-shared/join-copy.js';
import { needsHomeScreen, turnOnNotifications } from '../notify.js';
import { nameApp } from '../name.js';
import { inviteCode } from '../invite-code.js';

const codeFromHash = () => new URLSearchParams(location.hash.replace(/^#/, '')).get('c') ?? '';
type FirstStep = 'home' | 'notify';
/** 0.12.1: her first step after Accept, as the address keeps it. */
const stepFromSearch = (): FirstStep | null => {
  const s = new URLSearchParams(location.search).get('step');
  return s === 'home' || s === 'notify' ? s : null;
};
const keepStep = (s: FirstStep) => history.replaceState(null, '', `/p/join?step=${s}`);

export function Join({ api, mode }: { api: PersonApi; mode: 'join' | 'link' }) {
  // The code the link brought, or a later one in the same tab; a pasted link sets it with its preview (0.12.1).
  const [code, setCode] = useState(codeFromHash);
  const [preview, setPreview] = useState<JoinPreview | null>(null);
  const [agreement, setAgreement] = useState<AgreementFields | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adult, setAdult] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<'join' | FirstStep | 'notNow'>('join');
  // 0.12.1: without a code, whether this device is in already (null until api.me() answers), and his name and label for her first steps after a reload.
  const [joined, setJoined] = useState<boolean | null>(null);
  const [space, setSpace] = useState<{ owner: string; label?: string | undefined } | null>(null);
  const [deviceName] = useState(() => (typeof navigator !== 'undefined' && /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : 'Phone'));

  const show = (p: JoinPreview) => {
    setPreview(p);
    setAgreement(p.offer);
    setName(p.name);
  };
  useEffect(() => {
    if (mode !== 'join' || !code || preview) return;
    let live = true;
    api.joinPreview(code).then(
      (p) => live && show(p),
      // 0.12.1: a device that is in already and opens its spent link goes on to Today, not to the spent-link page.
      (e: Error) => {
        if (!live) return;
        api.me().then(
          (m: PersonMe | undefined) => {
            if (!live) return;
            if (m?.person && m.person.state !== 'left') return navigate('/p', { replace: true });
            setError(e.message);
          },
          () => live && setError(e.message),
        );
      },
    );
    return () => {
      live = false;
    };
  }, [api, code, mode, preview]);
  // 0.12.1: the link opened again in this tab changes only the fragment: follow it while no preview shows.
  useEffect(() => {
    if (step !== 'join' || (mode === 'join' && preview)) return;
    const follow = () => {
      const c = codeFromHash();
      if (!c || c === code) return;
      setError(null);
      setCode(c);
    };
    addEventListener('hashchange', follow);
    addEventListener('popstate', follow);
    return () => {
      removeEventListener('hashchange', follow);
      removeEventListener('popstate', follow);
    };
  }, [code, mode, preview, step]);
  // 0.12.1: no code: a device that is in already goes on (her first steps if the address kept one, else Today); any other gets the paste page.
  useEffect(() => {
    if (mode !== 'join' || code) return;
    let live = true;
    api.me().then(
      (m: PersonMe | undefined) => {
        if (!live) return;
        if (!m?.person || m.person.state === 'left') return setJoined(false);
        const at = stepFromSearch();
        if (!at) return navigate('/p', { replace: true });
        setSpace({ owner: m.owner?.name ?? '', label: m.label });
        setStep(at === 'home' && needsHomeScreen() ? 'home' : 'notify');
      },
      () => live && setJoined(false),
    );
    return () => {
      live = false;
    };
  }, [api, code, mode]);

  const copy = useMemo(
    () => (preview && agreement ? joinCopy(preview.owner, agreement, { built: preview.built, foodModule: preview.modules.food, label: preview.label }) : null),
    [preview, agreement],
  );
  // The tab and a Home Screen install from this page take the space's name (her app does the same once she is in).
  useEffect(() => {
    if (preview) nameApp(preview.label);
  }, [preview]);

  if (mode === 'link') {
    return (
      <Page title="Link this device">
        <LinkForm key={code} api={api} initial={code} deviceName={deviceName} />
      </Page>
    );
  }
  if (step === 'home' || step === 'notify') {
    const next = () => {
      if (step === 'notify') return navigate('/p');
      keepStep('notify');
      setStep('notify');
    };
    return <FirstSteps api={api} owner={preview?.owner ?? space?.owner ?? ''} label={preview ? preview.label : space?.label} step={step} next={next} />;
  }
  if (step === 'notNow') return <Page title="Not now">Nothing was shared and the link still works until it runs out. Open it again when you're ready.</Page>;
  if (!code) {
    if (joined === null) return <Page title="Joining">Loading…</Page>;
    return (
      <PasteInvite
        api={api}
        onPreview={(c, p) => {
          // As if she had opened the link: a reload shows the same page, and Accept takes the code out again.
          history.replaceState(null, '', `/p/join#c=${c}`);
          setCode(c);
          show(p);
        }}
      />
    );
  }
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
      // The code is spent: take it out of the address, then the first steps, which the address keeps for a reload (0.12.1).
      const first = needsHomeScreen() ? 'home' : 'notify';
      keepStep(first);
      setStep(first);
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
                aria-label={switchLabel(preview.owner, line.key)}
                className="min-h-44 rounded-btn border border-line bg-bg px-8 type-input"
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
        <input className="min-h-44 flex-1 rounded-btn border border-line bg-bg px-8 type-input" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="flex min-h-44 items-center gap-8">
        <input type="checkbox" className="size-24" checked={adult} onChange={(e) => setAdult(e.target.checked)} />
        <span>I'm 18 or older</span>
      </label>
      {error ? <p role="alert" className="mt-8 font-medium text-ink">{error}</p> : null}
      <div className="mt-16 flex gap-12">
        <Button variant="primary" size="xl" disabled={!adult || busy} onClick={() => void accept()}>
          Accept and join
        </Button>
        <Button variant="text" size="xl" onClick={() => setStep('notNow')}>
          Not now
        </Button>
      </div>
    </Page>
  );
}

/** Her first steps after joining (spec 2.4), like his pairing: Home Screen (iPhone), notifications, Today. */
function FirstSteps({ api, owner, label, step, next }: { api: PersonApi; owner: string; label?: string | undefined; step: 'home' | 'notify'; next: () => void }) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (step === 'home') {
    return (
      <Page title="Step 1 of 2: Add to your Home Screen">
        <p>On iPhone, notifications from {owner || yourLabel(label)} reach you only from the app on your Home Screen.</p>
        <ol className="mt-12 list-decimal pl-20">
          <li>Tap the Share button at the bottom of Safari.</li>
          <li>Tap Add to Home Screen, then Add.</li>
          <li>Open the app from your Home Screen. It opens on your Today.</li>
        </ol>
        <div className="mt-16 flex gap-12">
          <Button variant="primary" size="xl" onClick={next}>
            Next
          </Button>
        </div>
      </Page>
    );
  }
  return (
    <Page title={needsHomeScreen() ? 'Step 2 of 2: Turn on notifications' : 'Turn on notifications'}>
      <p>Your plan, its rings, reminders and alerts from {owner || yourLabel(label)} come as notifications. You choose what shows on the lock screen in Me › Notifications.</p>
      {note ? (
        <p role="status" className="mt-12 font-medium">
          {note}
        </p>
      ) : null}
      <div className="mt-16 flex flex-wrap gap-12">
        <Button
          variant="primary"
          size="xl"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void turnOnNotifications(api).then((r) => (setNote(r), setBusy(false)));
          }}
        >
          Turn on notifications
        </Button>
        <Button variant={note ? 'primary' : 'text'} size="xl" onClick={next}>
          {note ? 'Go to Today' : 'Later'}
        </Button>
      </div>
    </Page>
  );
}

export const NOT_AN_INVITE = "That isn't an invite link. Paste the whole link you were sent.";
export const NOT_A_LINK_CODE = "That isn't a link code. Enter the code from your other device, or paste the whole link.";

/**
 * 0.12.1: a field's error under it: the field says it is invalid and is
 * described by the error (aria-invalid, aria-describedby), and the same words
 * a second time are a new alert, so a screen reader says them again.
 */
function useFieldError() {
  const id = useId();
  const [error, setError] = useState<{ text: string; n: number } | null>(null);
  return {
    fail: (text: string) => setError((e) => ({ text, n: (e?.n ?? 0) + 1 })),
    clear: () => setError(null),
    field: error ? { 'aria-invalid': true, 'aria-describedby': id } : {},
    alert: error ? (
      <p key={error.n} id={id} role="alert" className="mt-8 font-medium text-ink">
        {error.text}
      </p>
    ) : null,
  };
}

/** 0.12.1: the join page without its code. A pasted link (or its code) loads the preview here; a wrong one says so and she tries again. */
function PasteInvite({ api, onPreview }: { api: PersonApi; onPreview: (code: string, preview: JoinPreview) => void }) {
  const [text, setText] = useState('');
  const error = useFieldError();
  const [busy, setBusy] = useState(false);
  return (
    <Page title="Open your invite link once more">
      <p>You're signed in. Signing in drops the part of the link that holds your invite, so open the link you were sent once more, or paste it here.</p>
      <form
        className="mt-16"
        onSubmit={(e) => {
          e.preventDefault();
          const c = inviteCode(text);
          if (!c) return error.fail(NOT_AN_INVITE);
          error.clear();
          setBusy(true);
          api.joinPreview(c).then(
            (p) => onPreview(c, p),
            (err: Error) => {
              error.fail(err.message);
              setBusy(false);
            },
          );
        }}
      >
        <label className="flex flex-col gap-8">
          <span>Paste your invite link</span>
          <input
            className="min-h-44 w-full rounded-btn border border-line bg-bg px-8 type-input"
            value={text}
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            {...error.field}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        {error.alert}
        <p role="status" className={busy ? 'mt-8 text-ink-2' : undefined}>
          {busy ? 'Loading…' : null}
        </p>
        <Button className="mt-12" variant="primary" size="xl" type="submit" disabled={busy || !text.trim()}>
          Continue
        </Button>
      </form>
    </Page>
  );
}

/** /p/link: the code from another device of hers. 0.12.1: read like a pasted invite, so the whole /p/link#c= link works too. */
function LinkForm({ api, initial, deviceName }: { api: PersonApi; initial: string; deviceName: string }) {
  const [code, setCode] = useState(initial);
  const error = useFieldError();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const c = inviteCode(code);
        if (!c) return error.fail(NOT_A_LINK_CODE);
        error.clear();
        api.linkClaim(c, deviceName).then(
          () => navigate('/p'),
          (err: Error) => error.fail(err.message),
        );
      }}
    >
      <p className="text-ink-2">On a device that is linked already, open Me › Devices › Link another device, then enter the code here.</p>
      <input aria-label="Link code" className="mt-12 w-full rounded-btn border border-line bg-bg px-8 py-8 type-input" value={code} {...error.field} onChange={(e) => setCode(e.target.value)} />
      {error.alert}
      <Button className="mt-12" variant="primary" size="xl" type="submit" disabled={code.trim().length < 16}>
        Link this device
      </Button>
    </form>
  );
}
