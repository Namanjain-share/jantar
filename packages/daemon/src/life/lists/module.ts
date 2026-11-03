/**
 * v0.11 People (P4, spec 5.3): shared lists. A list is a project in a shared
 * space (`s:<id>`) with `list: {kind}` in its json; its items are to-dos in
 * the same space with that project. No new table: the `space` columns of
 * schema 4 already hold them.
 *
 * - Both members add, edit, tick, untick and delete items and rename
 *   lists. A tick records `doneBy` (the caller, never a body field). An
 *   item never has a due day and never rings anyone.
 * - Deleting a list deletes its items; the other member gets one push and
 *   an Activity row (core.shared).
 * - "Assign to {her}" (his side only) makes an assigned to-do in her space
 *   with the item's title, and marks the item `handed`; nothing links the
 *   two rows (C6).
 * - Every query names the space (TodosRepo works in one space); an id of
 *   another space is not found. A forgotten member's rows move to the
 *   owner's space with their authorship as 'gone' (people/module.ts).
 */
import { SHARED_LIST_ITEMS_MAX, SHARED_LISTS_MAX, type PersonTodo, type SharedItem, type SharedItemBody, type SharedItemPatch, type SharedList, type SharedListKind } from '@jantar/protocol/people';
import type { Project } from '@jantar/protocol';
import type { LifeCore, LifeResult, Logger } from '../../contracts.js';
import { TodosRepo } from '../todos/repo.js';

export const LIST_SENTENCES = {
  closed: 'Life is not open right now. Try again in a moment.',
  noList: 'That list is gone.',
  noItem: 'That item is gone.',
  listsFull: `Up to ${SHARED_LISTS_MAX} shared lists. Delete one to add another.`,
  itemsFull: `Up to ${SHARED_LIST_ITEMS_MAX} items in a list. Delete some to add more.`,
} as const;

type Refusal = Extract<LifeResult, { ok: false }>;
const refuse = (code: Refusal['code'], reason: string): Refusal => ({ ok: false, code, reason });
const OK: LifeResult = { ok: true, value: true };

export class SharedLists {
  constructor(
    private readonly core: () => LifeCore | null,
    private readonly log: Logger,
  ) {}

  private repo(space: string): { repo: TodosRepo; core: LifeCore } | null {
    const core = this.core();
    if (!core || !space.startsWith('s:')) return null;
    return { repo: new TodosRepo(core, this.log, space), core };
  }

  private listOf(repo: TodosRepo, id: string): (Project & { list: { kind: SharedListKind } }) | null {
    const p = repo.project(id);
    return p?.list ? (p as Project & { list: { kind: SharedListKind } }) : null;
  }

  private view(repo: TodosRepo, p: Project & { list: { kind: SharedListKind } }): SharedList {
    return { id: p.id, name: p.name, kind: p.list.kind, open: repo.open(p.id).length, done: repo.done(p.id, SHARED_LIST_ITEMS_MAX).length, createdAt: p.createdAt, updatedAt: p.updatedAt };
  }

  private item(t: PersonTodo): SharedItem {
    return {
      id: t.id,
      title: t.title,
      ...(t.notes ? { notes: t.notes } : {}),
      by: t.by ?? '',
      ...(t.doneAt ? { doneAt: t.doneAt } : {}),
      ...(t.doneBy !== undefined ? { doneBy: t.doneBy } : {}),
      ...(t.editedBy !== undefined ? { editedBy: t.editedBy } : {}),
      ...(t.handed ? { handed: t.handed } : {}),
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  }

  private told(core: LifeCore, space: string, by: string, kind: 'list' | 'item', action: 'added' | 'changed' | 'deleted' | 'ticked', title?: string): void {
    core.changed();
    core.shared?.({ space, by, kind, action, ...(title ? { title } : {}) });
  }

  lists(space: string): LifeResult<{ space: string; lists: SharedList[] }> {
    const r = this.repo(space);
    if (!r) return refuse('life_unavailable', LIST_SENTENCES.closed);
    const lists = r.repo
      .projects()
      .filter((p): p is Project & { list: { kind: SharedListKind } } => p.list !== undefined)
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id))
      .map((p) => this.view(r.repo, p));
    return { ok: true, value: { space, lists } };
  }

  createList(space: string, by: string, body: { name: string; kind: SharedListKind }): LifeResult<{ id: string }> {
    const r = this.repo(space);
    if (!r) return refuse('life_unavailable', LIST_SENTENCES.closed);
    if (r.repo.projects().filter((p) => p.list).length >= SHARED_LISTS_MAX) return refuse('conflict', LIST_SENTENCES.listsFull);
    const at = r.core.now().toISOString();
    const p: Project = { id: r.core.newId(), name: body.name, status: 'active', list: { kind: body.kind }, createdAt: at, updatedAt: at };
    r.repo.saveProject(p);
    this.told(r.core, space, by, 'list', 'added', p.name);
    return { ok: true, value: { id: p.id } };
  }

  renameList(space: string, by: string, id: string, name: string): LifeResult {
    const r = this.repo(space);
    if (!r) return refuse('life_unavailable', LIST_SENTENCES.closed);
    const p = this.listOf(r.repo, id);
    if (!p) return refuse('not_found', LIST_SENTENCES.noList);
    r.repo.saveProject({ ...p, name, updatedAt: r.core.now().toISOString() });
    this.told(r.core, space, by, 'list', 'changed', name);
    return OK;
  }

  /** The list and its items (one transaction); the other member is told. */
  deleteList(space: string, by: string, id: string): LifeResult {
    const r = this.repo(space);
    if (!r) return refuse('life_unavailable', LIST_SENTENCES.closed);
    const p = this.listOf(r.repo, id);
    if (!p) return refuse('not_found', LIST_SENTENCES.noList);
    r.core.db.tx(() => {
      for (const t of [...r.repo.open(id), ...r.repo.done(id, SHARED_LIST_ITEMS_MAX)]) r.repo.deleteTodo(t.id);
      r.repo.deleteProject(id, r.core.now().toISOString());
    });
    this.told(r.core, space, by, 'list', 'deleted', p.name);
    return OK;
  }

  items(space: string, id: string): LifeResult<{ list: SharedList; items: SharedItem[] }> {
    const r = this.repo(space);
    if (!r) return refuse('life_unavailable', LIST_SENTENCES.closed);
    const p = this.listOf(r.repo, id);
    if (!p) return refuse('not_found', LIST_SENTENCES.noList);
    const open = (r.repo.open(id) as PersonTodo[]).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const done = r.repo.done(id, SHARED_LIST_ITEMS_MAX) as PersonTodo[];
    return { ok: true, value: { list: this.view(r.repo, p), items: [...open, ...done].map((t) => this.item(t)) } };
  }

  private itemIn(repo: TodosRepo, listId: string, itemId: string): PersonTodo | null {
    const t = repo.todo(itemId) as PersonTodo | null;
    return t && t.projectId === listId ? t : null;
  }

  addItem(space: string, by: string, listId: string, body: SharedItemBody): LifeResult<{ id: string }> {
    const r = this.repo(space);
    if (!r) return refuse('life_unavailable', LIST_SENTENCES.closed);
    const p = this.listOf(r.repo, listId);
    if (!p) return refuse('not_found', LIST_SENTENCES.noList);
    if (r.repo.open(listId).length >= SHARED_LIST_ITEMS_MAX) return refuse('conflict', LIST_SENTENCES.itemsFull);
    const at = r.core.now().toISOString();
    const t: PersonTodo = { id: r.core.newId(), title: body.title, priority: 'normal', projectId: listId, ...(body.note ? { notes: body.note } : {}), createdAt: at, updatedAt: at };
    r.repo.saveTodo(t, by);
    this.told(r.core, space, by, 'item', 'added', p.name);
    return { ok: true, value: { id: t.id } };
  }

  updateItem(space: string, by: string, listId: string, itemId: string, patch: SharedItemPatch): LifeResult {
    const r = this.repo(space);
    if (!r) return refuse('life_unavailable', LIST_SENTENCES.closed);
    const t = this.itemIn(r.repo, listId, itemId);
    if (!t) return refuse('not_found', LIST_SENTENCES.noItem);
    const next: PersonTodo = { ...t, updatedAt: r.core.now().toISOString() };
    if (patch.title !== undefined) next.title = patch.title;
    if (patch.note === null) delete next.notes;
    else if (patch.note !== undefined) next.notes = patch.note;
    if ((t.by ?? '') !== by) next.editedBy = by;
    else delete next.editedBy;
    r.repo.saveTodo(next);
    this.told(r.core, space, by, 'item', 'changed');
    return OK;
  }

  deleteItem(space: string, by: string, listId: string, itemId: string): LifeResult {
    const r = this.repo(space);
    if (!r) return refuse('life_unavailable', LIST_SENTENCES.closed);
    if (!this.itemIn(r.repo, listId, itemId)) return refuse('not_found', LIST_SENTENCES.noItem);
    r.repo.deleteTodo(itemId);
    this.told(r.core, space, by, 'item', 'deleted');
    return OK;
  }

  /** Tick or untick; `doneBy` is the caller. */
  tick(space: string, by: string, listId: string, itemId: string, done: boolean): LifeResult {
    const r = this.repo(space);
    if (!r) return refuse('life_unavailable', LIST_SENTENCES.closed);
    const t = this.itemIn(r.repo, listId, itemId);
    if (!t) return refuse('not_found', LIST_SENTENCES.noItem);
    if (Boolean(t.doneAt) === done) return OK;
    const at = r.core.now().toISOString();
    const next: PersonTodo = { ...t, updatedAt: at };
    if (done) {
      next.doneAt = at;
      next.doneBy = by;
    } else {
      delete next.doneAt;
      delete next.doneBy;
    }
    r.repo.saveTodo(next);
    this.told(r.core, space, by, 'item', 'ticked');
    return OK;
  }

  /** "Assign to {her}" (his side): the item is marked handed and ticked; the caller makes her to-do (no link, C6). */
  handOn(space: string, listId: string, itemId: string, to: string): LifeResult<{ title: string; notes?: string }> {
    const r = this.repo(space);
    if (!r) return refuse('life_unavailable', LIST_SENTENCES.closed);
    const t = this.itemIn(r.repo, listId, itemId);
    if (!t) return refuse('not_found', LIST_SENTENCES.noItem);
    const at = r.core.now().toISOString();
    const next: PersonTodo = { ...t, handed: { to, at }, doneAt: t.doneAt ?? at, doneBy: t.doneBy ?? '', updatedAt: at };
    r.repo.saveTodo(next);
    this.told(r.core, space, '', 'item', 'ticked');
    return { ok: true, value: { title: t.title, ...(t.notes ? { notes: t.notes } : {}) } };
  }
}
