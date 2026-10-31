/**
 * The project chip on a Board row (v0.4 spec 5.3): the project whose
 * folder holds the session's cwd, as its emoji (or a folder icon) and name
 * in mono --ink-2. Board rows render it in their meta line while Life is
 * on; with no project there it renders nothing. Every chip reads the one
 * cached list from useProjects, so a Board of many rows makes one request.
 */
import { FolderSimpleIcon } from '@phosphor-icons/react';
import { projectFor, useProjects } from './useProjects.js';

export interface ProjectChipProps {
  cwd: string;
}

export function ProjectChip({ cwd }: ProjectChipProps) {
  const project = projectFor(cwd, useProjects());
  if (!project) return null;
  return (
    <span data-project-chip className="ml-12 inline-flex min-w-0 max-w-160 flex-none items-center gap-4 type-mono text-ink-2">
      <span className="sr-only">Project </span>
      {project.emoji ? <span aria-hidden="true">{project.emoji}</span> : <FolderSimpleIcon size={12} aria-hidden="true" className="flex-none" />}
      <span className="truncate">{project.name}</span>
    </span>
  );
}
