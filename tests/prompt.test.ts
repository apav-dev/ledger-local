import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createTtyPrompter, parseChoice, parseConfirm, PromptError } from '../src/cli/prompt.js';

/** A prompter wired to in-memory streams, so the readline plumbing is exercised without a terminal. */
function pipePrompter(): {
  prompter: ReturnType<typeof createTtyPrompter>;
  input: PassThrough;
  written: () => string;
} {
  const input = new PassThrough();
  const chunks: string[] = [];
  const output = new PassThrough();
  output.on('data', (c: Buffer) => chunks.push(c.toString('utf8')));
  // isTTY is forced: PassThrough is not a terminal, but terminal semantics are
  // exactly what needs testing.
  const prompter = createTtyPrompter({ isTTY: true, input, output });
  return { prompter, input, written: () => chunks.join('') };
}

describe('parseChoice', () => {
  const choices = ['sandbox', 'production'] as const;

  it('accepts an exact name', () => {
    expect(parseChoice('production', choices, 'sandbox')).toBe('production');
  });

  it('accepts a 1-based index', () => {
    expect(parseChoice('1', choices, 'sandbox')).toBe('sandbox');
    expect(parseChoice('2', choices, 'sandbox')).toBe('production');
  });

  it('falls back on empty input', () => {
    expect(parseChoice('', choices, 'sandbox')).toBe('sandbox');
    expect(parseChoice('   ', choices, 'sandbox')).toBe('sandbox');
  });

  it('ignores surrounding whitespace and case', () => {
    expect(parseChoice('  PRODUCTION  ', choices, 'sandbox')).toBe('production');
  });

  it('rejects an out-of-range index rather than clamping', () => {
    // Clamping would silently pick production when the user meant something else.
    expect(parseChoice('3', choices, 'sandbox')).toBeNull();
    expect(parseChoice('0', choices, 'sandbox')).toBeNull();
    expect(parseChoice('-1', choices, 'sandbox')).toBeNull();
  });

  it('rejects an unknown name', () => {
    expect(parseChoice('development', choices, 'sandbox')).toBeNull();
  });

  it('rejects a non-integer index', () => {
    expect(parseChoice('1.5', choices, 'sandbox')).toBeNull();
  });
});

describe('parseConfirm', () => {
  it('accepts y and yes in any case', () => {
    for (const input of ['y', 'Y', 'yes', 'YES', ' Yes ']) {
      expect(parseConfirm(input, false)).toBe(true);
    }
  });

  it('accepts n and no in any case', () => {
    for (const input of ['n', 'N', 'no', 'NO', ' No ']) {
      expect(parseConfirm(input, true)).toBe(false);
    }
  });

  it('falls back on empty input', () => {
    expect(parseConfirm('', true)).toBe(true);
    expect(parseConfirm('  ', false)).toBe(false);
  });

  it('rejects anything else rather than guessing', () => {
    // A typo must not be read as consent for a destructive overwrite.
    expect(parseConfirm('sure', false)).toBeNull();
    expect(parseConfirm('yy', false)).toBeNull();
  });
});

describe('createTtyPrompter', () => {
  it('refuses to prompt when stdin is not a TTY', () => {
    // Reading a secret from a pipe would silently accept whatever is on stdin,
    // including a stray line from a script. Fail loudly instead.
    expect(() => createTtyPrompter({ isTTY: false })).toThrow(PromptError);
    expect(() => createTtyPrompter({ isTTY: false })).toThrow(/interactive terminal/);
  });

  it('reads a line', async () => {
    const { prompter, input } = pipePrompter();
    const answer = prompter.line('client_id: ');
    input.write('cid_123\n');
    await expect(answer).resolves.toBe('cid_123');
    prompter.close();
  });

  it('echoes a normal line but never echoes a secret', async () => {
    const { prompter, input, written } = pipePrompter();

    const visible = prompter.line('client_id: ');
    input.write('cid_123\n');
    await visible;

    const hidden = prompter.secret('secret: ');
    input.write('sec_456\n');
    await hidden;

    const out = written();
    expect(out).toContain('client_id: ');
    expect(out).toContain('cid_123'); // ordinary input is echoed
    expect(out).toContain('secret: '); // the prompt itself stays visible
    expect(out).not.toContain('sec_456'); // the secret does not
    prompter.close();
  });

  it('resumes echoing after a secret', async () => {
    const { prompter, input, written } = pipePrompter();

    const hidden = prompter.secret('secret: ');
    input.write('sec_456\n');
    await hidden;

    const visible = prompter.line('client_id: ');
    input.write('cid_123\n');
    await visible;

    expect(written()).toContain('cid_123');
    prompter.close();
  });

  it('fails instead of hanging when input closes mid-prompt', async () => {
    // rl.question() never settles if the stream ends while it waits, which
    // wedges the process. This must surface as an error the CLI can exit on.
    const { prompter, input } = pipePrompter();
    const pending = prompter.line('client_id: ');
    input.end();
    await expect(pending).rejects.toThrow(PromptError);
    await expect(pending).rejects.toThrow(/Input closed/);
  });

  it('fails fast on a prompt issued after input already closed', async () => {
    const { prompter, input } = pipePrompter();
    input.end();
    await new Promise(resolve => setImmediate(resolve));
    await expect(prompter.line('client_id: ')).rejects.toThrow(/Input closed/);
  });

  it('does not accumulate close listeners across prompts', async () => {
    // One listener leaked per question would trip Node's max-listener warning
    // once a flow re-prompts enough times. Default threshold is 10.
    const warnings: string[] = [];
    const onWarning = (w: Error): number => warnings.push(w.name);
    process.on('warning', onWarning);

    const { prompter, input } = pipePrompter();
    for (let i = 0; i < 15; i++) {
      const answer = prompter.line('x: ');
      input.write(`v${i}\n`);
      await answer;
    }
    await new Promise(resolve => setImmediate(resolve));
    process.off('warning', onWarning);

    expect(warnings).not.toContain('MaxListenersExceededWarning');
    prompter.close();
  });
});
