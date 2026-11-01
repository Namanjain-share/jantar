/**
 * v0.4 Life: projects and todos (a reminder is a todo with a time),
 * medicines, food with calories and weight, cafés, and finance. v0.7:
 * posts, plans for what the user posts on social media by hand.
 *
 * Rules every shape here follows:
 * - Ids are ulids (LifeId). Days are `YYYY-MM-DD` keys in the Life time zone
 *   (settings life.timezone), months `YYYY-MM`, times `HH:MM` on that clock.
 * - Money is an integer count of hundredths of the currency unit, whatever
 *   the currency (₹123.45 is 12345, ¥1,234 is 123400); kg is the one float
 *   on the wire, rounded to one decimal by the daemon.
 * - A write answers ids only (`{ id }` or `{ ok: true }`): the idempotency
 *   cache keeps write replies, and no reply may carry Life text. Screens
 *   reload when `state.lifeTick` moves.
 * - Bodies are strict: an unknown key is a 400.
 */
import { z } from 'zod';
import {
  FOOD_ESTIMATE_TEXT_MAX,
  POST_GOALS_MAX,
  POST_LINK_MAX,
  POST_PER_WEEK_MAX,
  POST_TEXT_MAX,
  POST_TITLE_MAX,
  POST_WHERE_MAX,
} from './constants.js';
import { IsoDateSchema } from './models.js';
import { LIFE_MODULES } from './settings.js';

/** "0" or "1" in a query string, as a boolean. */
const flag01 = z.enum(['0', '1']).transform((v) => v === '1');

// ---------------------------------------------------------------------------
// Primitives

/** A ulid (Crockford base 32, 26 characters). */
export const LifeIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
export type LifeId = z.infer<typeof LifeIdSchema>;
export const DayKeySchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/);
export type DayKey = z.infer<typeof DayKeySchema>;
export const MonthKeySchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
export type MonthKey = z.infer<typeof MonthKeySchema>;
export const HhMmSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export type HhMm = z.infer<typeof HhMmSchema>;
export const LifeModuleSchema = z.enum(LIFE_MODULES);
export type LifeModule = z.infer<typeof LifeModuleSchema>;

/** An absolute folder a project is linked to; matched against Session.cwd by path prefix. Never opened. */
export const FolderPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => p.startsWith('/') && !/[\u0000-\u001f\u007f]/.test(p), { message: 'an absolute path' });

/** A day of the month, 1 to 31; in a shorter month the 29th to 31st fall on its last day. */
const MonthDaySchema = z.number().int().min(1).max(31);

/**
 * A strict subset of Noblot's recurrence rule (same field names, interval always 1): life-core's computeNextRunAt reads it as is.
 * v0.5.3: `yearly` (birthdays, renewals), on the due day's month and `byMonthDay`; `at`, the series' own time.
 */
export const RepeatSchema = z
  .strictObject({
    freq: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
    /** Weekly only; 0 = Sunday. Absent = the due day's weekday. */
    byWeekday: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
    /**
     * Monthly or yearly only: the date it repeats on. The daemon sets it from
     * the due day whenever a todo gets a monthly (yearly) repeat or a new due
     * day, so Done after a short month comes back to the 31st (31 Jan, 28 Feb,
     * 31 Mar), and a yearly 29 Feb to the 29th in a leap year, instead of
     * staying on the 28th. Absent = the due day's date.
     */
    byMonthDay: MonthDaySchema.optional(),
    /**
     * v0.5.3: the series' time of day; the daemon sets it on create and on a
     * PATCH that carries repeat; Snooze and Undo never change it. Done moves
     * the due time back to it, so a snoozed daily 11:00 rings at 11:00 the
     * next day. A value a client sends is replaced.
     */
    at: HhMmSchema.optional(),
  })
  .refine((r) => r.byMonthDay === undefined || r.freq === 'monthly' || r.freq === 'yearly', {
    message: 'byMonthDay is for a monthly or yearly repeat',
    path: ['byMonthDay'],
  });
export type Repeat = z.infer<typeof RepeatSchema>;

/** now + 1 h / 20:00 today / 09:00 tomorrow / Monday 09:00 (life-core snoozeTarget). */
export const SnoozePresetSchema = z.enum(['1h', 'tonight', 'tomorrow', 'nextWeek']);
export type SnoozePreset = z.infer<typeof SnoozePresetSchema>;

export const IdReplySchema = z.object({ id: LifeIdSchema });
export type IdReply = z.infer<typeof IdReplySchema>;
export const OkReplySchema = z.object({ ok: z.literal(true) });
export type OkReply = z.infer<typeof OkReplySchema>;

export const LifeIdParamsSchema = z.object({ id: LifeIdSchema });
export const DayParamsSchema = z.object({ day: DayKeySchema });
/** `?day=` (default today in the Life zone). */
export const DayQuerySchema = z.object({ day: DayKeySchema.optional() });

const stamps = { createdAt: IsoDateSchema, updatedAt: IsoDateSchema };

// ---------------------------------------------------------------------------
// Projects and todos

const ProjectNameSchema = z.string().trim().min(1).max(60);
export const ProjectStatusSchema = z.enum(['active', 'paused', 'done']);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;
const EmojiSchema = z.string().max(16);
export const LongNotesSchema = z.string().max(2000);

export const ProjectSchema = z.object({
  id: LifeIdSchema,
  name: ProjectNameSchema,
  status: ProjectStatusSchema,
  emoji: EmojiSchema.optional(),
  notes: LongNotesSchema.optional(),
  due: DayKeySchema.optional(),
  folder: FolderPathSchema.optional(),
  ...stamps,
});
export type Project = z.infer<typeof ProjectSchema>;
/** A project with its open and overdue todo counts. */
export const ProjectViewSchema = ProjectSchema.extend({ open: z.number().int(), overdue: z.number().int() });
export type ProjectView = z.infer<typeof ProjectViewSchema>;
/** POST /v1/projects (status defaults to active). */
export const ProjectBodySchema = z.strictObject({
  name: ProjectNameSchema,
  status: ProjectStatusSchema.optional(),
  emoji: EmojiSchema.optional(),
  notes: LongNotesSchema.optional(),
  due: DayKeySchema.optional(),
  folder: FolderPathSchema.optional(),
});
export type ProjectBody = z.infer<typeof ProjectBodySchema>;
/** PATCH /v1/projects/:id: every field optional; null clears emoji, notes, due and folder. */
export const ProjectPatchSchema = z.strictObject({
  name: ProjectNameSchema.optional(),
  status: ProjectStatusSchema.optional(),
  emoji: EmojiSchema.nullable().optional(),
  notes: LongNotesSchema.nullable().optional(),
  due: DayKeySchema.nullable().optional(),
  folder: FolderPathSchema.nullable().optional(),
});
export type ProjectPatch = z.infer<typeof ProjectPatchSchema>;
export const ProjectsResponseSchema = z.object({ projects: z.array(ProjectViewSchema) });
export type ProjectsResponse = z.infer<typeof ProjectsResponseSchema>;

/** A due day with an optional time; with a time the todo is a reminder (it pings then). */
export const DueSchema = z.strictObject({ day: DayKeySchema, time: HhMmSchema.optional() });
export type Due = z.infer<typeof DueSchema>;
export const TodoPrioritySchema = z.enum(['normal', 'high']);
export type TodoPriority = z.infer<typeof TodoPrioritySchema>;
export const TodoTitleSchema = z.string().trim().min(1).max(200);

export const TodoSchema = z.object({
  id: LifeIdSchema,
  title: TodoTitleSchema,
  notes: LongNotesSchema.optional(),
  due: DueSchema.optional(),
  priority: TodoPrioritySchema,
  projectId: LifeIdSchema.optional(),
  /** Needs `due`. One row that never ends: Done moves `due` to the next day the repeat allows after both its due day and today. */
  repeat: RepeatSchema.optional(),
  /** Never set on a repeating todo. */
  doneAt: IsoDateSchema.optional(),
  ...stamps,
});
export type Todo = z.infer<typeof TodoSchema>;

const NEEDS_DUE = { message: 'a repeating todo needs a due day', path: ['repeat'] };

/** POST /v1/todos (priority defaults to normal). */
export const TodoBodySchema = z
  .strictObject({
    title: TodoTitleSchema,
    notes: LongNotesSchema.optional(),
    due: DueSchema.optional(),
    priority: TodoPrioritySchema.optional(),
    projectId: LifeIdSchema.optional(),
    repeat: RepeatSchema.optional(),
  })
  .refine((b) => b.repeat === undefined || b.due !== undefined, NEEDS_DUE);
export type TodoBody = z.infer<typeof TodoBodySchema>;
/**
 * PATCH /v1/todos/:id: every field optional; null clears notes, due,
 * projectId and repeat. Whether the result still has a due day under a
 * repeat is checked by the daemon against the stored todo.
 */
export const TodoPatchSchema = z
  .strictObject({
    title: TodoTitleSchema.optional(),
    notes: LongNotesSchema.nullable().optional(),
    due: DueSchema.nullable().optional(),
    priority: TodoPrioritySchema.optional(),
    projectId: LifeIdSchema.nullable().optional(),
    repeat: RepeatSchema.nullable().optional(),
  })
  .refine((b) => !(b.repeat && b.due === null), NEEDS_DUE);
export type TodoPatch = z.infer<typeof TodoPatchSchema>;
/** `done: false` is Undo, for one-off todos (a repeating one is moved back by PATCHing its old `due`). */
export const TodoDoneBodySchema = z.strictObject({ done: z.boolean() });
export type TodoDoneBody = z.infer<typeof TodoDoneBodySchema>;
export const SnoozeBodySchema = z.strictObject({ preset: SnoozePresetSchema });
export type SnoozeBody = z.infer<typeof SnoozeBodySchema>;
/** `?project=<id>|none&done=0|1`. */
export const TodosQuerySchema = z.object({
  project: z.union([LifeIdSchema, z.literal('none')]).optional(),
  done: flag01.default(false),
});
export type TodosQuery = z.infer<typeof TodosQuerySchema>;
/** Open todos by due (day, then time, undated last), then createdAt; with done=1 the newest 100 done. */
export const TodosResponseSchema = z.object({ today: DayKeySchema, todos: z.array(TodoSchema) });
export type TodosResponse = z.infer<typeof TodosResponseSchema>;

/**
 * v0.5.3 folder todos (ctl.sock only: `jantar mcp`'s todos_here and todo_add).
 * The daemon picks the project whose folder holds `folder` (the deepest wins,
 * selectors.ts projectFor); a project linked to `/`, `/Users` or the home
 * folder counts only for exactly that folder. The folder is the caller's
 * word: the "this session's folder" rule binds the MCP tools, not ctl.sock.
 */
export const FolderTodosQuerySchema = z.object({ folder: FolderPathSchema });
export type FolderTodosQuery = z.infer<typeof FolderTodosQuerySchema>;
export const FolderTodosResponseSchema = z.object({
  today: DayKeySchema,
  /** The project whose folder holds `folder` (the deepest wins), as the Board shows it; null when none. */
  project: ProjectSchema.pick({ id: true, name: true, emoji: true }).nullable(),
  /** Its open todos, by due (TodosResponse order); [] when project is null. */
  todos: z.array(TodoSchema),
});
export type FolderTodosResponse = z.infer<typeof FolderTodosResponseSchema>;
/** POST /v1/folder/todos: no projectId (the folder picks it) and no repeat. */
export const FolderTodoBodySchema = z.strictObject({
  folder: FolderPathSchema,
  title: TodoTitleSchema,
  notes: LongNotesSchema.optional(),
  due: DueSchema.optional(),
  priority: TodoPrioritySchema.optional(),
});
export type FolderTodoBody = z.infer<typeof FolderTodoBodySchema>;

// ---------------------------------------------------------------------------
// Medicines

function checkMedSchedule(s: { freq: string; byWeekday?: unknown; interval?: unknown }, ctx: z.RefinementCtx): void {
  if (s.freq === 'interval' && s.interval === undefined) ctx.addIssue({ code: 'custom', path: ['interval'], message: 'every N days needs an interval' });
  if (s.freq !== 'interval' && s.interval !== undefined) ctx.addIssue({ code: 'custom', path: ['interval'], message: 'an interval goes with every N days only' });
  if (s.freq !== 'weekly' && s.byWeekday !== undefined) ctx.addIssue({ code: 'custom', path: ['byWeekday'], message: 'weekdays go with a weekly schedule only' });
}

const medScheduleFields = {
  freq: z.enum(['daily', 'weekly', 'interval']),
  /** Weekly: 0 = Sunday. */
  byWeekday: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
  /** Every N days from startDay. */
  interval: z.number().int().min(2).max(60).optional(),
};

/** Which days a medicine is due. = life-core MedScheduleLike. */
export const MedScheduleSchema = z.strictObject({ ...medScheduleFields, startDay: DayKeySchema }).superRefine(checkMedSchedule);
export type MedSchedule = z.infer<typeof MedScheduleSchema>;
/** A schedule as a body sends it: startDay defaults to today. */
export const MedScheduleBodySchema = z.strictObject({ ...medScheduleFields, startDay: DayKeySchema.optional() }).superRefine(checkMedSchedule);
export type MedScheduleBody = z.infer<typeof MedScheduleBodySchema>;

const MedNameSchema = z.string().trim().min(1).max(60);
const MedDoseSchema = z.string().trim().max(40);
const MedNotesSchema = z.string().max(500);
const MedTimesSchema = z.array(HhMmSchema).min(1).max(8);
const PillsLeftSchema = z.number().int().min(0).max(100_000);
const PerDoseSchema = z.number().int().min(1).max(10);

export const MedicineSchema = z.object({
  id: LifeIdSchema,
  name: MedNameSchema,
  /** "500 mg". */
  dose: MedDoseSchema.optional(),
  /** Sorted, unique. */
  times: MedTimesSchema,
  schedule: MedScheduleSchema,
  /** Kept by the daemon: the schedule in force from each day (adherence reads it). Never sent by a client. */
  history: z.array(z.object({ from: DayKeySchema, schedule: MedScheduleSchema })).max(100),
  pills: z.object({ left: PillsLeftSchema, perDose: PerDoseSchema }).optional(),
  notes: MedNotesSchema.optional(),
  startedOn: DayKeySchema,
  stoppedOn: DayKeySchema.optional(),
  ...stamps,
});
export type Medicine = z.infer<typeof MedicineSchema>;
export const MedicineViewSchema = MedicineSchema.extend({
  supply: z.object({ daysLeft: z.number().int().nullable(), runsOut: DayKeySchema.nullable(), low: z.boolean() }).nullable(),
  /** The last 30 days, skips left out; null when nothing resolved. */
  adherencePct: z.number().min(0).max(100).nullable(),
});
export type MedicineView = z.infer<typeof MedicineViewSchema>;
/** POST /v1/medicines. Times are sorted and deduplicated by the daemon. */
export const MedicineBodySchema = z.strictObject({
  name: MedNameSchema,
  dose: MedDoseSchema.optional(),
  times: MedTimesSchema,
  schedule: MedScheduleBodySchema,
  pills: z.strictObject({ left: PillsLeftSchema, perDose: PerDoseSchema.default(1) }).optional(),
  notes: MedNotesSchema.optional(),
});
export type MedicineBody = z.infer<typeof MedicineBodySchema>;
/**
 * PATCH /v1/medicines/:id: every field optional; null clears dose, pills and
 * notes. A schedule change applies from today (history); a new `pills.left`
 * is a refill (perDose kept when left out).
 */
export const MedicinePatchSchema = z.strictObject({
  name: MedNameSchema.optional(),
  dose: MedDoseSchema.nullable().optional(),
  times: MedTimesSchema.optional(),
  schedule: MedScheduleBodySchema.optional(),
  pills: z.strictObject({ left: PillsLeftSchema, perDose: PerDoseSchema.optional() }).nullable().optional(),
  notes: MedNotesSchema.nullable().optional(),
});
export type MedicinePatch = z.infer<typeof MedicinePatchSchema>;

export const DoseStatusSchema = z.enum(['taken', 'skipped']);
export type DoseStatus = z.infer<typeof DoseStatusSchema>;
/** One logged dose; unique on (medicine, day, slot). A slot with no dose is a miss (never stored). */
export const DoseSchema = z.object({
  id: LifeIdSchema,
  medId: LifeIdSchema,
  day: DayKeySchema,
  slot: HhMmSchema,
  status: DoseStatusSchema,
  at: IsoDateSchema,
});
export type Dose = z.infer<typeof DoseSchema>;
export const DoseBodySchema = z.strictObject({
  day: DayKeySchema,
  slot: HhMmSchema,
  status: DoseStatusSchema,
  /** "Took it at…"; default now. Never after now. */
  at: IsoDateSchema.optional(),
});
export type DoseBody = z.infer<typeof DoseBodySchema>;
export const DoseParamsSchema = z.object({ id: LifeIdSchema, doseId: LifeIdSchema });

export const MedsDayItemSchema = z.object({
  medId: LifeIdSchema,
  name: z.string(),
  dose: z.string().optional(),
  slot: HhMmSchema,
  status: z.enum(['taken', 'skipped', 'missed', 'pending']),
  late: z.boolean().optional(),
  doseId: LifeIdSchema.optional(),
  at: IsoDateSchema.optional(),
  /** Today, pending and more than DOSE_GRACE_MINUTES (60) past its time: the one ember state. */
  overdue: z.boolean(),
});
export type MedsDayItem = z.infer<typeof MedsDayItemSchema>;
/** One day's dose checklist. */
export const MedsDaySchema = z.object({
  day: DayKeySchema,
  today: DayKeySchema,
  groups: z.array(
    z.object({
      // life-core's 'anytime' only holds medicines with no times, which cannot exist.
      period: z.enum(['morning', 'afternoon', 'night']),
      items: z.array(MedsDayItemSchema),
    }),
  ),
});
export type MedsDay = z.infer<typeof MedsDaySchema>;
/** GET /v1/medicines?day= (on or before today): the day's checklist and every medicine, stopped ones last. */
export const MedicinesResponseSchema = z.object({ day: MedsDaySchema, medicines: z.array(MedicineViewSchema) });
export type MedicinesResponse = z.infer<typeof MedicinesResponseSchema>;

// ---------------------------------------------------------------------------
// Food, calories and weight

export const FoodNameSchema = z.string().trim().min(1).max(80);
export const KcalSchema = z.number().int().min(0).max(10_000);

export const FoodEntrySchema = z.object({
  id: LifeIdSchema,
  day: DayKeySchema,
  at: IsoDateSchema,
  name: FoodNameSchema,
  kcal: KcalSchema,
  ...stamps,
});
export type FoodEntry = z.infer<typeof FoodEntrySchema>;
/** POST /v1/food: a name and kcal (`save`: keep it for one tap too), or a saved food by id. */
export const FoodBodySchema = z.union([
  z.strictObject({ day: DayKeySchema, name: FoodNameSchema, kcal: KcalSchema, save: z.boolean().optional() }),
  z.strictObject({ day: DayKeySchema, savedId: LifeIdSchema }),
]);
export type FoodBody = z.infer<typeof FoodBodySchema>;
export const FoodPatchSchema = z.strictObject({ name: FoodNameSchema.optional(), kcal: KcalSchema.optional() });
export type FoodPatch = z.infer<typeof FoodPatchSchema>;
export const SavedFoodSchema = z.object({ id: LifeIdSchema, name: FoodNameSchema, kcal: KcalSchema, uses: z.number().int() });
export type SavedFood = z.infer<typeof SavedFoodSchema>;

/** One weight a day, kg with one decimal. */
export const WeightSchema = z.object({ day: DayKeySchema, kg: z.number() });
export type Weight = z.infer<typeof WeightSchema>;
/** PUT /v1/weights/:day (on or before today; replaces that day's weight). Rounded to one decimal by the daemon. */
export const WeightBodySchema = z.strictObject({ kg: z.number().min(20).max(400) });
export type WeightBody = z.infer<typeof WeightBodySchema>;
export const WeightSummarySchema = z.object({
  latest: WeightSchema.nullable(),
  /** kg, one decimal: latest minus the newest weight on or before 7 (30) days before the latest's day. */
  change7: z.number().nullable(),
  change30: z.number().nullable(),
  goalKg: z.number().nullable(),
  /** Newest first. */
  recent: z.array(WeightSchema).max(30),
});
export type WeightSummary = z.infer<typeof WeightSummarySchema>;
/** PUT /v1/food/targets: the daily calorie target and the goal weight (null clears it). */
export const FoodTargetsBodySchema = z
  .strictObject({
    kcalTarget: z.number().int().min(800).max(6000).optional(),
    goalKg: z.number().min(20).max(400).nullable().optional(),
  })
  .refine((b) => b.kcalTarget !== undefined || b.goalKg !== undefined, { message: 'set kcalTarget or goalKg' });
export type FoodTargetsBody = z.infer<typeof FoodTargetsBodySchema>;
/** GET /v1/food?day=. */
export const FoodDaySchema = z.object({
  day: DayKeySchema,
  today: DayKeySchema,
  target: z.number().int(),
  kcal: z.number().int(),
  entries: z.array(FoodEntrySchema),
  /** By uses, then last used. */
  saved: z.array(SavedFoodSchema).max(30),
  weight: WeightSummarySchema,
});
export type FoodDay = z.infer<typeof FoodDaySchema>;
/** POST /v1/food/estimate: "2 rotis and dal". Never saved; the web sends it with no Idempotency-Key. */
export const FoodEstimateBodySchema = z.strictObject({ text: z.string().trim().min(1).max(FOOD_ESTIMATE_TEXT_MAX) });
export type FoodEstimateBody = z.infer<typeof FoodEstimateBodySchema>;
/** Ask Claude's answer: editable rows the phone adds as ordinary entries once confirmed. */
export const FoodEstimateSchema = z.object({
  items: z.array(z.object({ name: z.string().min(1).max(80), kcal: z.number().int().min(0).max(5000) })).max(20),
  note: z.string().max(200).optional(),
});
export type FoodEstimate = z.infer<typeof FoodEstimateSchema>;

// ---------------------------------------------------------------------------
// Cafés

export const DishSchema = z.strictObject({ name: z.string().trim().min(1).max(60), rating: z.number().int().min(1).max(5) });
export type Dish = z.infer<typeof DishSchema>;
const PlaceNameSchema = z.string().trim().min(1).max(80);
const AreaSchema = z.string().trim().max(60);
/** A maps or menu link; opened in a new tab only. */
const PlaceLinkSchema = z.url({ protocol: /^https$/ }).max(500);
const PlaceNotesSchema = z.string().max(1000);
const DishesSchema = z.array(DishSchema).max(30);

export const PlaceSchema = z.object({
  id: LifeIdSchema,
  name: PlaceNameSchema,
  area: AreaSchema.optional(),
  link: PlaceLinkSchema.optional(),
  notes: PlaceNotesSchema.optional(),
  tried: z.boolean(),
  dishes: DishesSchema,
  /** Derived: the highest dish rating. */
  best: z.number().int().min(1).max(5).nullable(),
  ...stamps,
});
export type Place = z.infer<typeof PlaceSchema>;
/** POST /v1/places (tried defaults to false, dishes to none). */
export const PlaceBodySchema = z.strictObject({
  name: PlaceNameSchema,
  area: AreaSchema.optional(),
  link: PlaceLinkSchema.optional(),
  notes: PlaceNotesSchema.optional(),
  tried: z.boolean().optional(),
  dishes: DishesSchema.optional(),
});
export type PlaceBody = z.infer<typeof PlaceBodySchema>;
/** PATCH /v1/places/:id: every field optional; null clears area, link and notes; dishes replace wholesale. */
export const PlacePatchSchema = z.strictObject({
  name: PlaceNameSchema.optional(),
  area: AreaSchema.nullable().optional(),
  link: PlaceLinkSchema.nullable().optional(),
  notes: PlaceNotesSchema.nullable().optional(),
  tried: z.boolean().optional(),
  dishes: DishesSchema.optional(),
});
export type PlacePatch = z.infer<typeof PlacePatchSchema>;
/** Always sorted by best. */
export const PlacesQuerySchema = z.object({ filter: z.enum(['all', 'tried', 'want']).default('all') });
export type PlacesQuery = z.infer<typeof PlacesQuerySchema>;
export const PlacesResponseSchema = z.object({ places: z.array(PlaceSchema) });
export type PlacesResponse = z.infer<typeof PlacesResponseSchema>;

// ---------------------------------------------------------------------------
// Finance (amounts: integer hundredths of the currency unit)

export const CategorySchema = z
  .string()
  .trim()
  .min(1)
  .max(24)
  .regex(/^[^\u0000-\u001f\u007f]+$/);
export type Category = z.infer<typeof CategorySchema>;
/** The category picker's fixed list; categories used in the last 12 months are added to it. */
export const DEFAULT_CATEGORIES = {
  expense: ['Food', 'Groceries', 'Transport', 'Bills', 'Rent', 'Shopping', 'Health', 'Fun', 'Other'],
  income: ['Salary', 'Other'],
} as const;
export const AmountSchema = z.number().int().min(1).max(1e12);
export const MoneyKindSchema = z.enum(['expense', 'income']);
export type MoneyKind = z.infer<typeof MoneyKindSchema>;
export const MoneyNoteSchema = z.string().max(200);

export const MoneyEntrySchema = z.object({
  id: LifeIdSchema,
  kind: MoneyKindSchema,
  amount: AmountSchema,
  category: CategorySchema,
  note: MoneyNoteSchema.optional(),
  day: DayKeySchema,
  /** Set on the expense a bill's Paid added. */
  billId: LifeIdSchema.optional(),
  ...stamps,
});
export type MoneyEntry = z.infer<typeof MoneyEntrySchema>;
export const MoneyBodySchema = z.strictObject({
  kind: MoneyKindSchema,
  amount: AmountSchema,
  category: CategorySchema,
  note: MoneyNoteSchema.optional(),
  day: DayKeySchema,
});
export type MoneyBody = z.infer<typeof MoneyBodySchema>;
/** PATCH /v1/money/:id: every field optional; null clears the note. */
export const MoneyPatchSchema = z.strictObject({
  kind: MoneyKindSchema.optional(),
  amount: AmountSchema.optional(),
  category: CategorySchema.optional(),
  note: MoneyNoteSchema.nullable().optional(),
  day: DayKeySchema.optional(),
});
export type MoneyPatch = z.infer<typeof MoneyPatchSchema>;
/** PUT /v1/money/budgets: a category's monthly budget; null removes it. */
export const BudgetBodySchema = z.strictObject({ category: CategorySchema, amount: AmountSchema.nullable() });
export type BudgetBody = z.infer<typeof BudgetBodySchema>;

export const BillRepeatSchema = z.enum(['monthly', 'yearly']);
export type BillRepeat = z.infer<typeof BillRepeatSchema>;
const BillNameSchema = z.string().trim().min(1).max(60);
/** A bill or subscription: pings at 09:00 on its due day; Paid logs an expense and moves the due day on. */
export const BillSchema = z.object({
  id: LifeIdSchema,
  name: BillNameSchema,
  amount: AmountSchema,
  category: CategorySchema,
  repeat: BillRepeatSchema,
  nextDue: DayKeySchema,
  /**
   * The date of the month it falls due, set by the daemon from nextDue on
   * create and whenever nextDue is changed by hand: Paid moves nextDue to
   * this date a month (or a year) on, so a bill due on the 31st is due on
   * 28 Feb and on 31 Mar again. Absent = nextDue's date.
   */
  byMonthDay: MonthDaySchema.optional(),
  ...stamps,
});
export type Bill = z.infer<typeof BillSchema>;
export const BillBodySchema = z.strictObject({
  name: BillNameSchema,
  amount: AmountSchema,
  category: CategorySchema,
  repeat: BillRepeatSchema,
  nextDue: DayKeySchema,
});
export type BillBody = z.infer<typeof BillBodySchema>;
export const BillPatchSchema = z.strictObject({
  name: BillNameSchema.optional(),
  amount: AmountSchema.optional(),
  category: CategorySchema.optional(),
  repeat: BillRepeatSchema.optional(),
  nextDue: DayKeySchema.optional(),
});
export type BillPatch = z.infer<typeof BillPatchSchema>;
/** POST /v1/bills/:id/paid: the day paid (default today) and the amount (default the bill's). Answers the new expense's id. */
export const BillPaidBodySchema = z.strictObject({ day: DayKeySchema.optional(), amount: AmountSchema.optional() });
export type BillPaidBody = z.infer<typeof BillPaidBodySchema>;
/** `?month=` (default this month in the Life zone). */
export const MoneyQuerySchema = z.object({ month: MonthKeySchema.optional() });
/** GET /v1/money?month=. */
export const MoneyMonthSchema = z.object({
  month: MonthKeySchema,
  currency: z.string().nullable(),
  /** Newest first. */
  entries: z.array(MoneyEntrySchema),
  spent: z.number().int(),
  income: z.number().int(),
  /** Expense categories with a spend or a budget, by spend. */
  byCategory: z.array(z.object({ category: z.string(), spent: z.number().int(), budget: z.number().int().nullable() })),
  /** Defaults plus any used before, for the picker. */
  categories: z.array(z.string()),
  /** Every bill, by nextDue. */
  bills: z.array(BillSchema),
});
export type MoneyMonth = z.infer<typeof MoneyMonthSchema>;

// ---------------------------------------------------------------------------
// Posts (v0.7): a plan for one thing the user posts by hand. Jantar never
// posts, never fetches a link and calls no network: it keeps the text, rings
// at the time, gives Copy and Open, and counts what is marked Posted.

/**
 * One line: no C0 or C1 control, DEL, or bidi embedding, override or
 * isolate. The class of meetings.ts NO_CONTROL (a copy: meetings.ts imports
 * this file), so a newline or a bidi override never reaches a lock screen or
 * a CLI list line.
 */
const POST_LINE = /^[^\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]+$/;
const ONE_LINE = { message: 'one line, with no control characters' };

export const POST_PLATFORMS = ['reddit', 'instagram', 'x', 'linkedin', 'youtube', 'tiktok', 'threads', 'facebook', 'hn', 'other'] as const;
export const POST_KINDS = ['post', 'comment', 'reel', 'story', 'thread', 'short', 'video', 'link'] as const;
export const PostPlatformSchema = z.enum(POST_PLATFORMS);
export type PostPlatform = z.infer<typeof PostPlatformSchema>;
export const PostKindSchema = z.enum(POST_KINDS);
export type PostKind = z.infer<typeof PostKindSchema>;
/** Idea, then Ready, then Posted (or Skipped). A new post is an idea or ready. */
export const PostStatusSchema = z.enum(['idea', 'ready', 'posted', 'skipped']);
export type PostStatus = z.infer<typeof PostStatusSchema>;
/** A subreddit, an account or a handle ("r/exampletools", "@example.studio"). */
export const PostWhereSchema = z.string().trim().min(1).max(POST_WHERE_MAX).regex(POST_LINE, ONE_LINE);
export const PostTitleSchema = z.string().trim().min(1).max(POST_TITLE_MAX).regex(POST_LINE, ONE_LINE);
/** The body or caption: Copy copies it. Ends trimmed, newlines kept. Never in a push, log, event or reply but the owner's GET. */
export const PostTextSchema = z.string().trim().min(1).max(POST_TEXT_MAX);
/** Where it gets posted, or the posted post: https only, opened by the user's tap, never requested by the daemon. */
export const PostLinkSchema = z.url({ protocol: /^https$/ }).max(POST_LINK_MAX);

/** The platform names the push, the CLI and the phone show. */
export const POST_PLATFORM_LABEL: Readonly<Record<PostPlatform, string>> = {
  reddit: 'Reddit',
  instagram: 'Instagram',
  x: 'X',
  linkedin: 'LinkedIn',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  threads: 'Threads',
  facebook: 'Facebook',
  hn: 'Hacker News',
  other: 'Other',
};
/** Each kind's name, one and many ("Reel", "Reels"). */
export const POST_KIND_LABEL: Readonly<Record<PostKind, readonly [one: string, many: string]>> = {
  post: ['Post', 'Posts'],
  comment: ['Comment', 'Comments'],
  reel: ['Reel', 'Reels'],
  story: ['Story', 'Stories'],
  thread: ['Thread', 'Threads'],
  short: ['Short', 'Shorts'],
  video: ['Video', 'Videos'],
  link: ['Link', 'Links'],
};

export const PostSchema = z.object({
  id: LifeIdSchema,
  platform: PostPlatformSchema,
  kind: PostKindSchema,
  where: PostWhereSchema.optional(),
  title: PostTitleSchema.optional(),
  text: PostTextSchema.optional(),
  /** Flair, media to attach, the sub's rules: shown only in the sheet, never copied, never in a push. */
  notes: LongNotesSchema.optional(),
  link: PostLinkSchema.optional(),
  /** With a time it rings, like a todo; a day alone lists it under that day. */
  due: DueSchema.optional(),
  status: PostStatusSchema,
  /** Set by the daemon when it becomes posted; cleared when it stops being posted. */
  postedAt: IsoDateSchema.optional(),
  /** The posted post's link; only while posted. */
  postedUrl: PostLinkSchema.optional(),
  ...stamps,
});
export type Post = z.infer<typeof PostSchema>;
/** POST /v1/posts (kind defaults to post, status to idea; never posted or skipped). */
export const PostBodySchema = z.strictObject({
  platform: PostPlatformSchema,
  kind: PostKindSchema.optional(),
  where: PostWhereSchema.optional(),
  title: PostTitleSchema.optional(),
  text: PostTextSchema.optional(),
  notes: LongNotesSchema.optional(),
  link: PostLinkSchema.optional(),
  due: DueSchema.optional(),
  status: z.enum(['idea', 'ready']).optional(),
});
export type PostBody = z.infer<typeof PostBodySchema>;
/**
 * PATCH /v1/posts/:id: every field optional; null clears where, title, text,
 * notes, link, due and the posted link. Any status may follow any other; the
 * daemon stamps postedAt, clears it and the posted link out of posted, and
 * refuses a posted link unless the result is posted.
 */
export const PostPatchSchema = z.strictObject({
  platform: PostPlatformSchema.optional(),
  kind: PostKindSchema.optional(),
  where: PostWhereSchema.nullable().optional(),
  title: PostTitleSchema.nullable().optional(),
  text: PostTextSchema.nullable().optional(),
  notes: LongNotesSchema.nullable().optional(),
  link: PostLinkSchema.nullable().optional(),
  due: DueSchema.nullable().optional(),
  status: PostStatusSchema.optional(),
  postedUrl: PostLinkSchema.nullable().optional(),
});
export type PostPatch = z.infer<typeof PostPatchSchema>;

const postGoalFields = {
  platform: PostPlatformSchema,
  /** Absent: any kind on that platform. */
  kind: PostKindSchema.optional(),
  perWeek: z.number().int().min(1).max(POST_PER_WEEK_MAX),
};
/** "Reels 3 a week" is { instagram, reel, 3 }; "Reddit 6 a week" is { reddit, 6 }. */
export const PostGoalSchema = z.strictObject(postGoalFields);
export type PostGoal = z.infer<typeof PostGoalSchema>;
/** PUT /v1/posts/goals: the whole list ([] removes every goal), one per platform and kind. */
export const PostGoalsBodySchema = z
  .strictObject({ goals: z.array(PostGoalSchema).max(POST_GOALS_MAX) })
  .refine((b) => new Set(b.goals.map((g) => `${g.platform}/${g.kind ?? ''}`)).size === b.goals.length, {
    message: 'one goal per platform and kind',
    path: ['goals'],
  });
export type PostGoalsBody = z.infer<typeof PostGoalsBodySchema>;
/** `?done=0|1`. */
export const PostsQuerySchema = z.object({ done: flag01.default(false) });
export type PostsQuery = z.infer<typeof PostsQuerySchema>;
/**
 * GET /v1/posts: open posts (idea and ready) by due (day, then time, untimed
 * after timed, undated last), then createdAt; with done=1 the newest 100
 * posted or skipped. `week` runs Monday to Sunday in the Life zone and counts
 * what was posted in it, against each goal.
 */
export const PostsResponseSchema = z.object({
  today: DayKeySchema,
  week: z.object({
    from: DayKeySchema,
    to: DayKeySchema,
    posted: z.number().int().nonnegative(),
    goals: z.array(z.object({ ...postGoalFields, done: z.number().int().nonnegative() })),
  }),
  posts: z.array(PostSchema),
});
export type PostsResponse = z.infer<typeof PostsResponseSchema>;

/** A goal's name: the kind's plural with a kind ("Reels"), else the platform ("Reddit"). */
export function postGoalLabel(g: Pick<PostGoal, 'platform' | 'kind'>): string {
  return g.kind ? POST_KIND_LABEL[g.kind][1] : POST_PLATFORM_LABEL[g.platform];
}

// ---------------------------------------------------------------------------
// Status, Today, backups

export const LifeStatusSchema = z.object({
  /** life.db is open (false while every module is off, or when it is broken). */
  open: z.boolean(),
  /** The fixed sentence when life.db would not open. */
  broken: z.string().optional(),
  timezone: z.string(),
  today: DayKeySchema,
  currency: z.string().nullable(),
  lockScreenDetails: z.boolean(),
  modules: z.record(LifeModuleSchema, z.boolean()),
  /** Ask Claude can run on this Mac, or why not. */
  estimate: z.object({ available: z.boolean(), reason: z.string().optional() }),
  backups: z.object({ last: IsoDateSchema.nullable(), count: z.number().int() }),
  /** Who would get a medicine ping now: control-scope devices with a push subscription, and the notify.webpush switch. */
  push: z.object({ devices: z.number().int().nonnegative(), webpush: z.boolean() }),
});
export type LifeStatus = z.infer<typeof LifeStatusSchema>;

/** GET /v1/life/today?day=: only the modules that are on. */
export const TodaySchema = z.object({
  day: DayKeySchema,
  meds: MedsDaySchema.optional(),
  todos: z.object({ overdue: z.array(TodoSchema), today: z.array(TodoSchema) }).optional(),
  food: z.object({ kcal: z.number().int(), target: z.number().int(), weight: WeightSchema.nullable() }).optional(),
  /** nextDue <= today + 3 days. */
  bills: z.array(BillSchema).optional(),
  /** v0.7: open posts due today, and due before today. */
  posts: z.object({ today: z.number().int().nonnegative(), late: z.number().int().nonnegative() }).optional(),
});
export type Today = z.infer<typeof TodaySchema>;

/** POST /v1/life/backup (ctl.sock only): a file name inside <state dir>/backups. */
export const LifeBackupResponseSchema = z.object({ file: z.string(), at: IsoDateSchema });
export type LifeBackupResponse = z.infer<typeof LifeBackupResponseSchema>;
/** A backup's file name: `life-*.db`, directly inside <state dir>/backups (no path). */
export const LifeBackupNameSchema = z.string().regex(/^life-[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.db$/);
/** POST /v1/life/restore (ctl.sock only). */
export const LifeRestoreBodySchema = z.strictObject({ file: LifeBackupNameSchema });
export type LifeRestoreBody = z.infer<typeof LifeRestoreBodySchema>;
/** `kept`: the name the previous life.db was kept under, beside it in the state dir. */
export const LifeRestoreResponseSchema = z.object({ ok: z.literal(true), kept: z.string() });
export type LifeRestoreResponse = z.infer<typeof LifeRestoreResponseSchema>;
