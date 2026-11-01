/**
 * sources/transcripts: the TranscriptReader (path lookup, byte-offset reads,
 * tail summary, transcript pages) and the TranscriptWatcher (tail state,
 * alerts, hook-less Done and, v0.6.1, background work for live sessions).
 */
export {
  createTranscriptReader,
  createFileTranscriptReader,
  encodeProjectDir,
  FileTranscriptReader,
  type TranscriptReaderOptions,
} from './reader.js';
export {
  createTranscriptWatcher,
  createTranscriptWatcherWith,
  TranscriptWatcherImpl,
  ALERT_IDS_KV_KEY,
  type TranscriptWatcherOptions,
} from './watcher.js';
export { AlertScanner, type FoundAlert } from './alerts.js';
export { BackgroundScanner, BACKGROUND_MAX_AGE_MS } from './background.js';
export { summarizeTail, itemsFromEntry, classifyUser, isTurnStart, parseLine } from './parse.js';
