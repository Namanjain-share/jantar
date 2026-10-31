/**
 * The inside of the "From this session's folder" sheet (attach/FolderPicker.tsx),
 * its own chunk with files/Browse.tsx: the session's folder (`s.<sid>`), its
 * subfolders by tap and breadcrumb, and a file tap hands that file's path in
 * the folder to `onPick`. Nothing outside the session's root is offered.
 */
import { useCallback, useState } from 'react';
import type { FilesLocation } from '../../../../lib/router.js';
import { useDeps } from '../../../context.js';
import { Browse } from '../../files/Browse.js';
import { useLoad } from '../../files/data.js';

export interface FolderBrowseProps {
  sid: string;
  phone: boolean;
  onPick: (path: string) => void;
}

export function FolderBrowse({ sid, phone, onPick }: FolderBrowseProps) {
  const { api } = useDeps();
  const loadRoots = useCallback(() => api.filesRoots(), [api]);
  const roots = useLoad('roots', loadRoots);
  const root = `s.${sid}`;
  const [path, setPath] = useState('');
  const go = (next: FilesLocation) => {
    if (next.root !== root) return;
    const p = next.path ?? '';
    // A path not ending in "/" is a file (files/model.ts placeOf).
    if (p && !p.endsWith('/')) onPick(p);
    else setPath(p);
  };
  return <Browse roots={roots} root={root} path={path} phone={phone} onLocation={go} />;
}
