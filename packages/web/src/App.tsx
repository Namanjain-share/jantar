/**
 * App root: dependencies (store, API, router, toasts), the providers every
 * screen relies on, and the shell (ui/shell/Shell.tsx).
 *
 * - CSPProvider disableStyleElements: Base UI never injects a <style> (the
 *   CSP is style-src 'self'); the few rules it would add live in styles/.
 * - MotionConfig reducedMotion="user": Motion drops transforms when the OS
 *   asks for reduced motion.
 * - LazyMotion (strict) with domMax loaded as its own chunk after first
 *   paint: use `m.div`, never `motion.div`. Never AnimatePresence
 *   mode="popLayout" or AnimateView: those inject a <style> element.
 */
import { CSPProvider } from '@base-ui/react/csp-provider';
import { LazyMotion, MotionConfig } from 'motion/react';
import { useState } from 'react';
import { createApi } from './lib/api.js';
import { createRouter, memoryHistory } from './lib/router.js';
import type { AppStore } from './store.js';
import { AppProvider, createToastStore, type AppDeps } from './ui/context.js';
import { Shell } from './ui/shell/Shell.js';

const loadMotionFeatures = () => import('./motionFeatures.js').then((m) => m.default);

export type AppProps = Partial<AppDeps> & { store: AppStore };

/** Fill in defaults for anything not passed (tests usually pass fakes). */
export function App(props: AppProps) {
  const [deps] = useState<AppDeps>(() => ({
    ...props,
    store: props.store,
    api: props.api ?? createApi(),
    router: props.router ?? createRouter(memoryHistory('/')),
    toasts: props.toasts ?? createToastStore(),
  }));
  return (
    <CSPProvider disableStyleElements>
      <MotionConfig reducedMotion="user">
        <LazyMotion features={loadMotionFeatures} strict>
          <AppProvider deps={deps}>
            <Shell />
          </AppProvider>
        </LazyMotion>
      </MotionConfig>
    </CSPProvider>
  );
}
