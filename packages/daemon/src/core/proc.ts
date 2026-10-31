import type { ProcessProbe } from '../contracts.js';

/** kill(pid, 0); EPERM means the process exists but belongs to someone else. */
export const realProcessProbe: ProcessProbe = {
  isAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
};
