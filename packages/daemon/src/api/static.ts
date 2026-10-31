/**
 * Serves the built web app (packages/web/dist) at `/`.
 *
 * - Files only from the dist folder; dotfiles are ignored; no listings.
 * - Hashed assets (`/assets/*`) are cached for a year; `index.html`,
 *   `sw.js` and the manifest are revalidated every time so an update shows up.
 * - Unknown non-API paths that accept HTML get `index.html` (client routes
 *   such as /s/<sid> and /pair).
 * - `webHash` (sent in `hello`) changes whenever index.html or sw.js does, so
 *   open pages know to reload.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const REVALIDATE = new Set(['index.html', 'sw.js', 'manifest.webmanifest', 'manifest.json']);

export function webIndexExists(dist: string): boolean {
  return existsSync(join(dist, 'index.html'));
}

export function computeWebHash(dist: string): string | null {
  const h = createHash('sha256');
  let any = false;
  for (const name of ['index.html', 'sw.js', 'manifest.webmanifest']) {
    try {
      h.update(name).update('\0').update(readFileSync(join(dist, name))).update('\0');
      any = true;
    } catch {
      /* optional file */
    }
  }
  return any ? h.digest('hex').slice(0, 16) : null;
}

export function isApiPath(path: string): boolean {
  return path === '/v1' || path.startsWith('/v1/') || path === '/ctl' || path.startsWith('/ctl/') || path === '/healthz';
}

function acceptsHtml(req: FastifyRequest): boolean {
  const accept = String(req.headers.accept ?? '');
  return accept === '' || accept.includes('text/html') || accept.includes('*/*');
}

export async function registerWebApp(app: FastifyInstance, dist: string): Promise<void> {
  await app.register(fastifyStatic, {
    root: dist,
    prefix: '/',
    wildcard: true,
    index: false,
    dotfiles: 'ignore',
    serveDotFiles: false,
    list: false,
    redirect: false,
    cacheControl: false,
    etag: true,
    lastModified: true,
    decorateReply: true,
    allowedPath: (pathName) => !isApiPath(pathName),
    setHeaders: (reply: FastifyReply, path: string) => {
      const name = path.split('/').pop() ?? '';
      if (REVALIDATE.has(name)) reply.header('cache-control', 'no-cache');
      else if (path.includes('/assets/')) reply.header('cache-control', 'public, max-age=31536000, immutable');
      else reply.header('cache-control', 'public, max-age=3600');
      if (name === 'sw.js') reply.header('service-worker-allowed', '/');
      if (name.endsWith('.webmanifest')) reply.header('content-type', 'application/manifest+json; charset=utf-8');
    },
  });
  // `/` itself is the app shell (the wildcard route would treat it as a directory).
  app.get('/', (_req, reply) => reply.header('cache-control', 'no-cache').sendFile('index.html'));
}

/** The SPA fallback: true when it answered. */
export function serveIndexFallback(req: FastifyRequest, reply: FastifyReply, available: boolean): boolean {
  const path = req.url.split('?')[0] ?? '/';
  if ((req.method !== 'GET' && req.method !== 'HEAD') || isApiPath(path) || !acceptsHtml(req)) return false;
  if (!available) {
    reply
      .code(503)
      .header('content-type', 'text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(
        '<!doctype html><meta charset="utf-8"><title>Jantar</title>' +
          '<p>jantard is running, but the web app is not built.</p>' +
          '<p>Build it with <code>pnpm --filter @jantar/web build</code>.</p>',
      );
    return true;
  }
  reply.header('cache-control', 'no-cache');
  void reply.sendFile('index.html');
  return true;
}
