/**
 * Read-only look at whether Claude's settings call the Jantar hook client.
 * (Editing the settings is the hooks installer's job, in @jantar/daemon.)
 */
import { readFile } from 'node:fs/promises';

/** true / false, or null when the settings file cannot be read. Never prints or returns its contents. */
export async function settingsMentionHook(settingsPath: string, hookBin: string): Promise<boolean | null> {
  try {
    const text = await readFile(settingsPath, 'utf8');
    return text.includes(hookBin);
  } catch {
    return null;
  }
}
