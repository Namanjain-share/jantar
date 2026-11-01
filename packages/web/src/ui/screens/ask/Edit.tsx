/**
 * A card's inline Edit (v0.5.3 spec 1.1, web only). The fields copy the
 * patterns of TodoSheet, AddFoodSheet and Finance's fields; the sheets are
 * not imported. "Save and add" sends the whole edited action, of the
 * card's own type, as `edit`; the Mac checks it again against now before
 * anything is added.
 *
 * - todo: title, day and time (clearable); its repeat, priority, project
 *   and notes stay as suggested, shown read-only.
 * - food: name, kcal, a day on or before today.
 * - money: Expense or Income, the amount (read into hundredths), a
 *   category from DEFAULT_CATEGORIES (the only names Ask suggests, so the
 *   page never loads the month), the note, a day on or before today.
 */
import clsx from 'clsx';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { DEFAULT_CATEGORIES, type AskFoodAction, type AskMoneyAction, type AskTodoAction, type AskWriteAction, type MoneyKind, type ProjectView } from '@jantar/protocol';
import { amountInput, parseAmount } from '../../../lib/money.js';
import { Button } from '../../kit/Button.js';
import { Spinner } from '../../kit/Spinner.js';
import { Segmented } from '../accounts/Segmented.js';
import { parseKcal } from '../life/food/format.js';
import { AmountField } from '../life/money/fields.js';
import { Field, INPUT, SheetActions } from '../life/today/parts.js';
import { projectLabel } from '../life/todos/model.js';
import { ASK_COPY, REPEAT_TEXT } from './model.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CHIP = 'h-32 rounded-chip border px-10 type-small transition-colors duration-120 ease-hover coarse:h-44';

interface Common {
  today: string;
  currency: string | null;
  /** The project a todo card names (shown, kept). */
  project?: ProjectView | undefined;
  /** This card's Add in flight. */
  busy: boolean;
  /** Offline, or another tap on the turn in flight. */
  disabled: boolean;
  onSave: (edit: AskWriteAction) => void;
  onCancel: () => void;
}

export function CardEdit({ action, ...rest }: { action: AskWriteAction } & Common) {
  switch (action.type) {
    case 'todo':
      return <TodoEdit action={action} {...rest} />;
    case 'food':
      return <FoodEdit action={action} {...rest} />;
    case 'money':
      return <MoneyEdit action={action} {...rest} />;
  }
}

function Actions({ ok, busy, disabled, onCancel }: { ok: boolean; busy: boolean; disabled: boolean; onCancel: () => void }) {
  return (
    <SheetActions className="mt-8">
      <Button type="submit" variant="primary" size="sm" disabled={!ok || disabled}>
        {busy ? <Spinner label="Adding" /> : null}
        Save and add
      </Button>
      <Button variant="text" size="sm" disabled={busy} onClick={onCancel}>
        Cancel
      </Button>
    </SheetActions>
  );
}

/** A suggested value the edit keeps as it is. */
function Kept({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p className="py-2 type-small text-ink-2">
      <span className="text-ink-3">{label}: </span>
      {children}
    </p>
  );
}

function TodoEdit({ action, project, busy, disabled, onSave, onCancel }: { action: AskTodoAction } & Common) {
  const id = useId();
  const [title, setTitle] = useState(action.title);
  const [day, setDay] = useState(action.due?.day ?? '');
  const [time, setTime] = useState(action.due?.time ?? '');
  // A repeat needs a day (Life refuses one without), and the form says so.
  const noDay = Boolean(action.repeat) && day === '';
  const ok = title.trim().length > 0 && (day === '' || DAY.test(day)) && !noDay;

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!ok || disabled) return;
    const { due: _due, repeat, title: _title, ...kept } = action;
    onSave({ ...kept, title: title.trim(), ...(day ? { due: { day, ...(time ? { time } : {}) } } : {}), ...(repeat && day ? { repeat } : {}) });
  };

  return (
    <form onSubmit={save} aria-label="Edit the suggestion" className="mt-4">
      <Field label="Title" htmlFor={`${id}-title`}>
        <input id={`${id}-title`} className={INPUT} value={title} maxLength={200} autoComplete="off" onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Due" id={`${id}-due`}>
        <div role="group" aria-labelledby={`${id}-due`} className="flex items-center gap-8">
          <input
            type="date"
            aria-label="Due day"
            className={INPUT}
            value={day}
            onChange={(e) => {
              setDay(e.target.value);
              if (!e.target.value) setTime('');
            }}
          />
          <input type="time" aria-label="Due time" className={INPUT} value={time} disabled={!day} onChange={(e) => setTime(e.target.value)} />
          {time ? (
            <Button variant="text" size="sm" onClick={() => setTime('')}>
              Clear time
            </Button>
          ) : null}
        </div>
        {noDay ? <p className="mt-4 type-small text-ink-3">{ASK_COPY.repeatNeedsDay}</p> : null}
      </Field>
      {action.repeat ? <Kept label="Repeat">{REPEAT_TEXT[action.repeat]}</Kept> : null}
      {action.priority === 'high' ? <Kept label="Priority">High</Kept> : null}
      {project ? <Kept label="Project">{projectLabel(project)}</Kept> : null}
      {action.notes ? (
        <Kept label="Notes">
          <span className="whitespace-pre-wrap break-words">{action.notes}</span>
        </Kept>
      ) : null}
      <Actions ok={ok} busy={busy} disabled={disabled} onCancel={onCancel} />
    </form>
  );
}

function FoodEdit({ action, today, busy, disabled, onSave, onCancel }: { action: AskFoodAction } & Common) {
  const id = useId();
  const [name, setName] = useState(action.name);
  const [kcal, setKcal] = useState(String(action.kcal));
  const [day, setDay] = useState(action.day);
  const k = parseKcal(kcal);
  const ok = name.trim().length > 0 && k !== null && DAY.test(day) && day <= today;

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!ok || k === null || disabled) return;
    onSave({ type: 'food', day, name: name.trim(), kcal: k });
  };

  return (
    <form onSubmit={save} aria-label="Edit the suggestion" className="mt-4">
      <Field label="Name" htmlFor={`${id}-name`}>
        <input id={`${id}-name`} className={INPUT} value={name} maxLength={80} autoComplete="off" onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="kcal" htmlFor={`${id}-kcal`}>
        <input id={`${id}-kcal`} className={INPUT} inputMode="numeric" autoComplete="off" value={kcal} aria-invalid={k === null} onChange={(e) => setKcal(e.target.value)} />
      </Field>
      <Field label="Day" htmlFor={`${id}-day`}>
        <input id={`${id}-day`} type="date" className={INPUT} value={day} max={today} aria-invalid={day > today} onChange={(e) => setDay(e.target.value)} />
      </Field>
      <Actions ok={ok} busy={busy} disabled={disabled} onCancel={onCancel} />
    </form>
  );
}

function MoneyEdit({ action, today, currency, busy, disabled, onSave, onCancel }: { action: AskMoneyAction } & Common) {
  const id = useId();
  const start = amountInput(action.amount, currency);
  const [kind, setKind] = useState<MoneyKind>(action.kind);
  const [amount, setAmount] = useState(start);
  const [category, setCategory] = useState(action.category);
  const [note, setNote] = useState(action.note ?? '');
  const [day, setDay] = useState(action.day);
  const chips: readonly string[] = DEFAULT_CATEGORIES[kind];
  // Left as it came, the amount is the suggested one exactly (the field rounds it to the currency's decimals).
  const hundredths = amount === start ? action.amount : parseAmount(amount, currency);
  const ok = hundredths !== null && chips.includes(category) && DAY.test(day) && day <= today;

  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!ok || hundredths === null || disabled) return;
    onSave({ type: 'money', kind, amount: hundredths, category, ...(note.trim() ? { note: note.trim() } : {}), day });
  };

  return (
    <form onSubmit={save} aria-label="Edit the suggestion" className="mt-4">
      <Field label="Kind">
        <Segmented<MoneyKind>
          label="Kind"
          fill
          value={kind}
          onChange={(k) => {
            setKind(k);
            if (!(DEFAULT_CATEGORIES[k] as readonly string[]).includes(category)) setCategory('Other');
          }}
          segments={[
            { key: 'expense', label: 'Expense' },
            { key: 'income', label: 'Income' },
          ]}
        />
      </Field>
      <AmountField id={`${id}-amount`} value={amount} start={start} onChange={setAmount} currency={currency} />
      <Field label="Category" id={`${id}-cat`}>
        <div role="group" aria-labelledby={`${id}-cat`} className="flex flex-wrap gap-6">
          {chips.map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={category === c}
              onClick={() => setCategory(c)}
              className={clsx(CHIP, category === c ? 'border-line-strong bg-select text-ink' : 'border-line text-ink-2 hover:text-ink')}
            >
              {c}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Note" htmlFor={`${id}-note`}>
        <input id={`${id}-note`} className={INPUT} value={note} maxLength={200} autoComplete="off" onChange={(e) => setNote(e.target.value)} />
      </Field>
      <Field label="Day" htmlFor={`${id}-day`}>
        <input id={`${id}-day`} type="date" className={INPUT} value={day} max={today} aria-invalid={day > today} onChange={(e) => setDay(e.target.value)} />
      </Field>
      <Actions ok={ok} busy={busy} disabled={disabled} onCancel={onCancel} />
    </form>
  );
}
