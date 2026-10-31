import { createInterface } from 'node:readline/promises';

/** Everything a command touches, injectable for tests. */
export interface CliIo {
  out(text: string): void;
  err(text: string): void;
  env: Readonly<Record<string, string | undefined>>;
  isTTY: boolean;
  /** All of stdin as text (for `jantar send <sid> -`). */
  readStdin?(): Promise<string>;
  /** Ask a yes/no question on the terminal. Absent when there is no terminal to ask on. */
  ask?(question: string): Promise<string>;
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}

async function askOnTerminal(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

export const processIo: CliIo = {
  out: (t) => process.stdout.write(t),
  err: (t) => process.stderr.write(t),
  env: process.env,
  isTTY: Boolean(process.stdout.isTTY),
  readStdin: readAllStdin,
  ...(process.stdin.isTTY ? { ask: askOnTerminal } : {}),
};

export interface MemoryIoOptions {
  stdin?: string;
  /** Answers given to `ask()`, in order. */
  answers?: string[];
  isTTY?: boolean;
}

/** An in-memory IO that captures output (tests). */
export function memoryIo(
  env: Record<string, string | undefined> = {},
  opts: MemoryIoOptions = {},
): CliIo & { stdout: string; stderr: string; questions: string[] } {
  const answers = [...(opts.answers ?? [])];
  const io: CliIo & { stdout: string; stderr: string; questions: string[] } = {
    stdout: '',
    stderr: '',
    questions: [],
    env,
    isTTY: opts.isTTY ?? false,
    out(t: string) {
      io.stdout += t;
    },
    err(t: string) {
      io.stderr += t;
    },
    readStdin: async () => opts.stdin ?? '',
  };
  if (opts.answers) {
    io.ask = async (q: string) => {
      io.questions.push(q);
      return answers.shift() ?? '';
    };
  }
  return io;
}
