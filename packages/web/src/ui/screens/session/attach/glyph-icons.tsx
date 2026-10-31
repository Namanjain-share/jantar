/** The icons behind glyph.tsx (v0.4.2's attachments; split out in v0.5.1), their own chunk: see there. */
import { FileIcon, FilePdfIcon, FileTextIcon, FolderIcon, ImageIcon } from '@phosphor-icons/react';
import type { GlyphProps } from './glyph.js';

const ICONS: Record<GlyphProps['name'], typeof FileIcon> = { image: ImageIcon, pdf: FilePdfIcon, office: FileIcon, text: FileTextIcon, folder: FolderIcon };

export function GlyphIcon({ name, size, className }: GlyphProps) {
  // A kind this app does not know (the Mac's reply is not checked here) gets the plain file.
  const Icon = ICONS[name] ?? FileIcon;
  return <Icon size={size} aria-hidden="true" className={className} />;
}
