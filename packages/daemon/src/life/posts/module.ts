/**
 * Posts (v0.7): plans for what the user posts on social media by hand.
 * Wave 0's stand-in until lane A builds the module (repo.ts, pings.ts and
 * this file): every call answers 501 not_implemented through the API, and
 * its part of Today is empty. `start` and `stop` are absent, so the Life
 * service builds and stops it like any other module; it registers no ping
 * handler, so a `post` row never rings yet.
 */
import type { LifeCore, LifeModuleDeps, PostsModule } from '../../contracts.js';
import { notBuilt } from '../../core/not-implemented.js';

export function buildPostsModule(_core: LifeCore, _deps: LifeModuleDeps): PostsModule {
  return notBuilt<PostsModule>('Posts', { name: 'posts', today: () => ({}), start: undefined, stop: undefined });
}
