import * as readline from 'node:readline/promises';
import { Writable, type Readable } from 'node:stream';

export class PromptError extends Error {
  override readonly name = 'PromptError';
}

/**
 * The interactive surface `ledger init` and `ledger item remove` depend on.
 * Injected rather than called directly so tests drive the flow without a
 * terminal, the same way `link.ts` takes `openUrl`.
 */
export interface Prompter {
  /** Presents a numbered list; accepts a name or a 1-based index. */
  select<T extends string>(question: string, choices: readonly T[], fallback: T): Promise<T>;
  line(question: string): Promise<string>;
  /** Reads without echoing. Used for anything that must not land in scrollback. */
  secret(question: string): Promise<string>;
  confirm(question: string, fallback: boolean): Promise<boolean>;
  close(): void;
}

/**
 * Resolves a raw answer against the choice list. Returns null for anything
 * unrecognized so the caller can re-ask; guessing at an ambiguous answer is
 * worse than one more round trip.
 */
export function parseChoice<T extends string>(
  input: string,
  choices: readonly T[],
  fallback: T,
): T | null {
  const trimmed = input.trim();
  if (trimmed === '') return fallback;

  const byName = choices.find(c => c.toLowerCase() === trimmed.toLowerCase());
  if (byName !== undefined) return byName;

  // Reject "1.5" and "1e0": only a plain integer is an index.
  if (!/^\d+$/.test(trimmed)) return null;
  const index = Number(trimmed);
  if (index < 1 || index > choices.length) return null;
  return choices[index - 1] ?? null;
}

/** Returns null on anything that is not clearly yes or no. */
export function parseConfirm(input: string, fallback: boolean): boolean | null {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === '') return fallback;
  if (trimmed === 'y' || trimmed === 'yes') return true;
  if (trimmed === 'n' || trimmed === 'no') return false;
  return null;
}

/** Bounded so a piped or misbehaving stdin cannot spin the prompt forever. */
const MAX_ATTEMPTS = 5;

/**
 * Swallows echo while a secret is being typed.
 *
 * Only readline's own echo passes through here. Callers write the secret's
 * prompt directly to the sink before muting, because readline does not emit the
 * query synchronously — muting around `question()` hid the prompt too.
 */
class MutableOutput extends Writable {
  muted = false;

  constructor(private readonly sink: NodeJS.WritableStream) {
    super();
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.muted) {
      // The two write overloads are not interchangeable: only the string form
      // takes an encoding.
      if (typeof chunk === 'string') this.sink.write(chunk, encoding);
      else this.sink.write(chunk);
    }
    callback();
  }
}

const CLOSED_MESSAGE =
  'Input closed before the prompt was answered. Nothing was changed. ' +
  'Re-run the command in an interactive shell.';

export interface TtyPrompterOpts {
  /** Injected so the non-TTY guard is testable without detaching a terminal. */
  isTTY?: boolean | undefined;
  input?: (Readable & { isTTY?: boolean }) | undefined;
  output?: NodeJS.WritableStream | undefined;
  /**
   * Appended to the non-TTY error. Supplied by the caller because the way out
   * differs per command — `init` wants the hand-written config, `item remove`
   * wants --yes — and generic advice for the wrong command is worse than none.
   */
  nonTtyHint?: string | undefined;
}

export function createTtyPrompter(opts: TtyPrompterOpts = {}): Prompter {
  const input = opts.input ?? process.stdin;
  const sink = opts.output ?? process.stdout;
  const isTTY = opts.isTTY ?? input.isTTY === true;
  if (!isTTY) {
    const hint = opts.nonTtyHint ?? 'Run it directly in a shell.';
    throw new PromptError(`This command needs an interactive terminal. ${hint}`);
  }

  const output = new MutableOutput(sink);
  const rl = readline.createInterface({ input, output, terminal: true });

  let closed = false;
  rl.on('close', () => {
    closed = true;
  });

  rl.on('SIGINT', () => {
    rl.close();
    sink.write('\nCancelled.\n');
    process.exit(130);
  });

  /**
   * `rl.question()` never settles if the input stream ends while it is waiting,
   * which wedges the process instead of failing. Aborting on 'close' converts
   * that hang into an error the caller can report and exit on.
   */
  async function ask(question: string): Promise<string> {
    if (closed) throw new PromptError(CLOSED_MESSAGE);
    const controller = new AbortController();
    const onClose = (): void => controller.abort();
    rl.once('close', onClose);
    try {
      return await rl.question(question, { signal: controller.signal });
    } catch (cause) {
      if (closed) throw new PromptError(CLOSED_MESSAGE, { cause });
      throw cause;
    } finally {
      rl.removeListener('close', onClose);
    }
  }

  const line = ask;

  return {
    line,

    async secret(question: string): Promise<string> {
      // The prompt is written straight to the sink, not handed to readline, so
      // muting cannot swallow it. Muting around the call itself would depend on
      // readline emitting the query before the first await, which it does not.
      sink.write(question);
      output.muted = true;
      try {
        const answer = await ask('');
        // The user's Enter was swallowed with everything else they typed.
        sink.write('\n');
        return answer;
      } finally {
        output.muted = false;
      }
    },

    async select<T extends string>(
      question: string,
      choices: readonly T[],
      fallback: T,
    ): Promise<T> {
      const menu = choices.map((c, i) => `  ${i + 1}) ${c}`).join('\n');
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const answer = await line(`${question}\n${menu}\n[${fallback}] `);
        const choice = parseChoice(answer, choices, fallback);
        if (choice !== null) return choice;
        sink.write(`Pick a number 1-${choices.length} or a name.\n`);
      }
      throw new PromptError(`No valid choice after ${MAX_ATTEMPTS} attempts.`);
    },

    async confirm(question: string, fallback: boolean): Promise<boolean> {
      const hint = fallback ? 'Y/n' : 'y/N';
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const answer = await line(`${question} [${hint}] `);
        const confirmed = parseConfirm(answer, fallback);
        if (confirmed !== null) return confirmed;
        sink.write('Answer y or n.\n');
      }
      throw new PromptError(`No valid answer after ${MAX_ATTEMPTS} attempts.`);
    },

    close(): void {
      rl.close();
    },
  };
}
