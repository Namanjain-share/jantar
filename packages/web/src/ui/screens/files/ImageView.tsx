/**
 * A raster image (v0.3 spec 5.2.3): the bytes from GET /v1/files/raw as a
 * Blob, shown through an object URL that is revoked on unmount. The
 * daemon serves only allowlisted images whose magic bytes match (anything
 * else is a 415, shown as its sentence). Native pinch zoom on the phone.
 * Leaving the viewer, or opening another file, aborts the download.
 */
import { useCallback } from 'react';
import { FILES_RAW_IMAGE_MAX } from '@jantar/protocol';
import { useDeps } from '../../context.js';
import { useObjectUrl } from './blob.js';
import { useLoad, useOffline } from './data.js';
import { sizeText } from './model.js';
import { LoadError, Loading, StateLine } from './states.js';

export function ImageView({ root, path, name, size }: { root: string; path: string; name: string; size: number }) {
  const { api } = useDeps();
  const offline = useOffline();
  const tooBig = size > FILES_RAW_IMAGE_MAX;
  const load = useCallback((signal: AbortSignal) => api.filesRaw({ root, path }, { signal }), [api, root, path]);
  // Bytes are never cached between views: each open asks again.
  const raw = useLoad(tooBig ? null : `raw:${root}\u0000${path}`, load, { cache: false });
  const url = useObjectUrl(raw.data);

  if (tooBig) {
    return (
      <StateLine>
        Image · {sizeText(size)}. Jantar shows images up to {sizeText(FILES_RAW_IMAGE_MAX)}.
      </StateLine>
    );
  }
  if (!raw.data) {
    if (raw.error) return <LoadError error={raw.error} offline={offline} onRetry={raw.reload} />;
    return <Loading caption="Loading the image…" count={2} />;
  }
  return (
    <div className="min-h-0 flex-1 overflow-auto p-16 md:p-24">
      {url ? <img src={url} alt={name} className="mx-auto h-auto max-w-full" /> : null}
    </div>
  );
}
