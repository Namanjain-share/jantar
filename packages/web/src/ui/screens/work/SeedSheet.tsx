/**
 * 0.13.0 "Start from your client folders" (W28, design 11): Work's empty
 * state opens this sheet. He picks one of the Mac's roots and a folder
 * under it (Launch's folder browser while Launch is on, else Files', W40:
 * Work adds no way of its own to list the Mac's folders), sees its
 * subfolders, all unticked, ticks the ones that are projects, and taps
 * Create: one project per ticked folder with the folder linked
 * (`POST /v1/work/seed`), and, with "Also make a client for each" (on by
 * default), a company client each, linked to its project. Never automatic.
 *
 * A ticked folder's name is suggested from the folder ("acme-web" is "Acme
 * Web") and can be changed. A folder a project links already is marked
 * and can't be ticked; the daemon skips one anyway and says how many.
 * Nothing is written into a folder.
 */
import { CaretLeftIcon, CaretRightIcon, FolderSimpleIcon } from '@phosphor-icons/react';
import { useId, useMemo, useState, type FormEvent } from 'react';
import type { FileRoot, FilesRootsResponse, ProjectView } from '@jantar/protocol';
import { useDeps, useToast } from '../../context.js';
import { Button } from '../../kit/Button.js';
import { IconButton } from '../../kit/IconButton.js';
import { Sheet } from '../../kit/Sheet.js';
import { Spinner } from '../../kit/Spinner.js';
import { useFeatures } from '../../shell/data.js';
import { LifeEmpty, NotSaved } from '../life/shared/states.js';
import { useLifeLoad } from '../life/shared/useLife.js';
import { Field, INPUT, Loaded, OfflineLine, SheetActions, useOffline, useWrite } from '../life/today/parts.js';
import { workClient } from './client.js';
import { linkedFolders, nameFromFolder } from './model.js';

/** At most this many folders in one Create (WORK_LIMITS.seedItems). */
export const SEED_MAX = 50;

export interface SeedSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sheetKey: number;
  /** His projects, to mark the folders they link. */
  projects: readonly ProjectView[];
  onSaved: () => void;
}

export function SeedSheet({ open, onOpenChange, sheetKey, projects, onSaved }: SeedSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title="Start from your client folders">
      {open ? <SeedForm key={sheetKey} projects={projects} onDone={() => onOpenChange(false)} onSaved={onSaved} /> : null}
    </Sheet>
  );
}

interface Listing {
  /** "~/Desktop/work/client": the folder shown. */
  display: string;
  folders: string[];
}

function SeedForm({ projects, onDone, onSaved }: { projects: readonly ProjectView[]; onDone: () => void; onSaved: () => void }) {
  const { api } = useDeps();
  const features = useFeatures();
  const offline = useOffline();
  const toast = useToast();
  const w = useWrite();
  const id = useId();
  // Launch's browser lists folders only (with live and pinned ones first); Files' lists everything, of which the folders.
  const viaLaunch = features.launch;
  const roots = useLifeLoad<FilesRootsResponse>(`work:seed:roots:${viaLaunch ? 'launch' : 'files'}`, () => (viaLaunch ? api.foldersRoots() : api.filesRoots()));
  const configured = useMemo(() => (roots.data?.roots ?? []).filter((r) => r.kind === 'configured'), [roots.data]);
  const [rootId, setRootId] = useState<string | null>(null);
  const root: FileRoot | undefined = configured.find((r) => r.id === rootId) ?? configured[0];
  const [path, setPath] = useState('');
  const listing = useLifeLoad<Listing>(root ? `work:seed:list:${root.id}:${path}` : null, async () => {
    if (!root) return { display: '', folders: [] };
    if (viaLaunch) {
      const l = await api.foldersList({ root: root.id, path });
      return { display: l.display, folders: l.entries.map((e) => e.name) };
    }
    const l = await api.filesList({ root: root.id, path });
    return { display: path ? `${root.display}/${path}` : root.display, folders: l.entries.filter((e) => e.type === 'dir').map((e) => e.name) };
  });
  const linked = useMemo(() => linkedFolders(projects), [projects]);
  // Ticked folders by their path under the root, with the name each project gets.
  const [picked, setPicked] = useState<ReadonlyMap<string, string>>(new Map());
  const [clients, setClients] = useState(true);
  const count = picked.size;
  const names = [...picked.values()];
  const ok = count > 0 && count <= SEED_MAX && names.every((n) => n.trim().length > 0) && root !== undefined;

  const go = (next: string) => {
    setPath(next);
  };
  const toggle = (sub: string, folder: string) =>
    setPicked((cur) => {
      const m = new Map(cur);
      if (m.has(sub)) m.delete(sub);
      else m.set(sub, nameFromFolder(folder));
      return m;
    });
  const rename = (sub: string, name: string) => setPicked((cur) => new Map(cur).set(sub, name));

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok || !root || w.busy || offline) return;
    const body = { items: [...picked].map(([p, name]) => ({ root: root.id, path: p, name: name.trim() })), clients };
    const r = await w.run(JSON.stringify(body), (key) => workClient(api).seed(body, key));
    if (!r.ok) return;
    const made = r.value.projects.length;
    const parts = [made === 1 ? 'Made 1 project' : `Made ${made} projects`];
    if (r.value.clients?.length) parts.push(r.value.clients.length === 1 ? '1 client' : `${r.value.clients.length} clients`);
    if (r.value.skipped) parts.push(`${r.value.skipped} skipped: a project links ${r.value.skipped === 1 ? 'it' : 'them'} already`);
    toast(`${parts.join(', ')}.`);
    onSaved();
    onDone();
  };

  const up = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  return (
    <form onSubmit={(e) => void create(e)} aria-label="Start from your client folders">
      <p className="type-small text-ink-2">Tick the folders that are projects. Each becomes a project with its folder linked. Nothing is written into them.</p>
      <Loaded load={roots} count={2}>
        {() =>
          configured.length === 0 ? (
            <LifeEmpty className="px-0">No folders are set up on your Mac to choose from.</LifeEmpty>
          ) : (
            <>
              {configured.length > 1 ? (
                <Field label="Where" htmlFor={`${id}-root`}>
                  <select
                    id={`${id}-root`}
                    className={INPUT}
                    value={root?.id ?? ''}
                    onChange={(e) => {
                      setRootId(e.target.value);
                      setPath('');
                      setPicked(new Map());
                    }}
                  >
                    {configured.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : null}
              <div className="mt-8 flex min-h-44 items-center gap-4 border-b border-line">
                {path ? (
                  <IconButton aria-label="Up one folder" className="size-44" onClick={() => go(up)}>
                    <CaretLeftIcon size={16} aria-hidden="true" />
                  </IconButton>
                ) : null}
                <span className="min-w-0 flex-1 truncate type-mono text-ink-2">{listing.data?.display ?? root?.display ?? ''}</span>
                {count ? <span className="flex-none type-mono text-ink-3">{count} ticked</span> : null}
              </div>
              <Loaded load={listing} count={3}>
                {(l) =>
                  l.folders.length === 0 ? (
                    <LifeEmpty className="px-0">No folders here.</LifeEmpty>
                  ) : (
                    <ul aria-label="Folders">
                      {l.folders.map((f) => {
                        const sub = path ? `${path}/${f}` : f;
                        const has = linked.has(`${l.display.replace(/\/+$/, '')}/${f}`);
                        const on = picked.has(sub);
                        return (
                          <li key={f} className="border-b border-line">
                            <div className="flex min-h-44 items-center gap-4">
                              <label className="flex min-h-44 min-w-0 flex-1 cursor-pointer items-center gap-12 pr-8">
                                <input type="checkbox" className="size-20 flex-none accent-ink" checked={on} disabled={has || (!on && count >= SEED_MAX)} onChange={() => toggle(sub, f)} />
                                <FolderSimpleIcon size={16} aria-hidden="true" className="flex-none text-ink-3" />
                                <span className="min-w-0 flex-1 truncate type-row text-ink">{f}</span>
                                {has ? <span className="flex-none type-mono text-ink-3">a project</span> : null}
                              </label>
                              <IconButton aria-label={`Open ${f}`} className="size-44" onClick={() => go(sub)}>
                                <CaretRightIcon size={16} aria-hidden="true" />
                              </IconButton>
                            </div>
                            {on ? (
                              <div className="pb-8 pl-32">
                                <input
                                  aria-label={`Project name for ${f}`}
                                  className={INPUT}
                                  value={picked.get(sub) ?? ''}
                                  maxLength={60}
                                  autoComplete="off"
                                  onChange={(e) => rename(sub, e.target.value)}
                                />
                              </div>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  )
                }
              </Loaded>
              <label className="mt-8 flex min-h-44 cursor-pointer items-center gap-12">
                <input type="checkbox" className="size-20 flex-none accent-ink" checked={clients} onChange={(e) => setClients(e.target.checked)} />
                <span className="type-row text-ink">Also make a client for each</span>
              </label>
            </>
          )
        }
      </Loaded>
      {w.error ? <NotSaved error={w.error} /> : null}
      <SheetActions>
        <Button type="submit" variant="primary" size="lg" className="flex-1" disabled={!ok || w.busy || offline}>
          {w.busy ? <Spinner label="Creating" /> : null}
          {count > 1 ? `Create ${count} projects` : 'Create project'}
        </Button>
        <Button variant="text" size="lg" onClick={onDone}>
          Cancel
        </Button>
      </SheetActions>
      {offline ? <OfflineLine className="mt-8" /> : null}
    </form>
  );
}
