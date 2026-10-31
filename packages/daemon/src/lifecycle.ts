import type { Logger, Service } from './contracts.js';

export type NamedService = readonly [name: string, service: Service];

/**
 * Start services in order. If one fails, the ones already started are
 * stopped in reverse order and the error is rethrown. Returns a function
 * that stops everything in reverse order (errors are logged, not thrown).
 */
export async function startServices(services: readonly NamedService[], log: Logger): Promise<() => Promise<void>> {
  const started: NamedService[] = [];
  const stopAll = async () => {
    for (const [name, svc] of [...started].reverse()) {
      try {
        await svc.stop();
      } catch (e) {
        log.error('service failed to stop', { service: name, error: String(e) });
      }
    }
    started.length = 0;
  };
  for (const entry of services) {
    try {
      await entry[1].start();
      started.push(entry);
    } catch (e) {
      log.error('service failed to start', { service: entry[0], error: String(e) });
      await stopAll();
      throw e;
    }
  }
  return stopAll;
}
