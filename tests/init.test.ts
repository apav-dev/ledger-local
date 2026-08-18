import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, type ConfigInput } from '../src/core/config.js';
import { openDb, readMeta } from '../src/core/db.js';
import { PlaidApiError, type LinkTokenResult } from '../src/core/plaid-client.js';
import { runInit, type InitDeps } from '../src/cli/init.js';
import type { Prompter } from '../src/cli/prompt.js';

const CLIENT_ID = 'cid_live_123';
const SECRET = 'sec_live_456';

let dir: string;

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

function makeEnv(existingConfig?: string): NodeJS.ProcessEnv {
  dir = mkdtempSync(path.join(tmpdir(), 'ledger-init-'));
  const configDir = path.join(dir, 'config');
  const dataDir = path.join(dir, 'data');
  mkdirSync(configDir, { recursive: true });
  if (existingConfig !== undefined) {
    writeFileSync(path.join(configDir, 'config.json'), existingConfig);
  }
  return { LEDGER_CONFIG_DIR: configDir, LEDGER_DATA_DIR: dataDir };
}

interface Script {
  selects?: string[];
  lines?: string[];
  secrets?: string[];
  confirms?: boolean[];
}

/** Replays a fixed script; throws if the flow asks more than was scripted. */
function fakePrompter(script: Script): Prompter {
  const selects = [...(script.selects ?? [])];
  const lines = [...(script.lines ?? [])];
  const secrets = [...(script.secrets ?? [])];
  const confirms = [...(script.confirms ?? [])];
  const next = <T>(queue: T[], label: string): T => {
    if (queue.length === 0) throw new Error(`fakePrompter ran out of ${label} answers`);
    return queue.shift() as T;
  };
  return {
    select: <T extends string>(_q: string, _c: readonly T[], _f: T) =>
      Promise.resolve(next(selects, 'select') as T),
    line: () => Promise.resolve(next(lines, 'line')),
    secret: () => Promise.resolve(next(secrets, 'secret')),
    confirm: () => Promise.resolve(next(confirms, 'confirm')),
    close: () => {},
  };
}

interface Harness {
  deps: InitDeps;
  output: string[];
  opened: string[];
  verified: ConfigInput[];
  /** How many times the flow asked for a prompter — 0 means it never needed a terminal. */
  prompterBuilds: () => number;
}

function harness(
  script: Script,
  opts: {
    env: NodeJS.ProcessEnv;
    force?: boolean;
    verify?: (cfg: ConfigInput, attempt: number) => Promise<LinkTokenResult>;
  },
): Harness {
  const output: string[] = [];
  const opened: string[] = [];
  const verified: ConfigInput[] = [];
  let attempt = 0;

  const prompter = fakePrompter(script);
  let prompterBuilds = 0;

  const deps: InitDeps = {
    makePrompter: () => {
      prompterBuilds += 1;
      return prompter;
    },
    openUrl: url => opened.push(url),
    write: message => output.push(message),
    env: opts.env,
    force: opts.force ?? false,
    makeApi: cfg => ({
      createLinkToken: () => {
        verified.push(cfg);
        attempt += 1;
        return (
          opts.verify?.(cfg, attempt) ??
          Promise.resolve({ linkToken: 'link-tok', hostedLinkUrl: 'https://hosted' })
        );
      },
    }),
  };
  return { deps, output, opened, verified, prompterBuilds: () => prompterBuilds };
}

const HAPPY: Script = {
  selects: ['sandbox'],
  lines: [CLIENT_ID],
  secrets: [SECRET],
  confirms: [false],
};

describe('runInit', () => {
  it('writes a config loadConfig can read back', async () => {
    const env = makeEnv();
    const { deps } = harness(HAPPY, { env });

    const result = await runInit(deps);

    expect(result.environment).toBe('sandbox');
    const cfg = loadConfig(env);
    expect(cfg.clientId).toBe(CLIENT_ID);
    expect(cfg.secret).toBe(SECRET);
    expect(cfg.environment).toBe('sandbox');
  });

  it('opens the Plaid keys page', async () => {
    const env = makeEnv();
    const { deps, opened } = harness(HAPPY, { env });
    await runInit(deps);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatch(/dashboard\.plaid\.com/);
  });

  it('verifies the pasted credentials against Plaid before writing', async () => {
    const env = makeEnv();
    const { deps, verified } = harness(HAPPY, { env });
    await runInit(deps);
    expect(verified).toEqual([
      { clientId: CLIENT_ID, secret: SECRET, environment: 'sandbox' },
    ]);
  });

  it('stamps the chosen environment into the database', async () => {
    const env = makeEnv();
    const { deps } = harness(
      { ...HAPPY, selects: ['production'] },
      { env },
    );
    await runInit(deps);

    const db = openDb(loadConfig(env).dbPath, 'production');
    expect(readMeta(db, 'environment')).toBe('production');
    db.close();
  });

  it('trims whitespace off pasted credentials', async () => {
    const env = makeEnv();
    const { deps } = harness(
      { ...HAPPY, lines: [`  ${CLIENT_ID}\t`], secrets: [` ${SECRET} `] },
      { env },
    );
    await runInit(deps);
    expect(loadConfig(env).clientId).toBe(CLIENT_ID);
    expect(loadConfig(env).secret).toBe(SECRET);
  });

  it('never writes the secret to output', async () => {
    const env = makeEnv();
    const { deps, output } = harness(HAPPY, { env });
    await runInit(deps);
    expect(output.join('\n')).not.toContain(SECRET);
  });

  it('reports whether Hosted Link is ready without blocking the write', async () => {
    const env = makeEnv();
    const { deps, output } = harness(HAPPY, {
      env,
      verify: () => Promise.resolve({ linkToken: 'link-tok', hostedLinkUrl: null }),
    });

    const result = await runInit(deps);

    // Valid keys, but a dashboard toggle is off. Writing is still correct.
    expect(result.hostedLinkReady).toBe(false);
    expect(existsSync(result.configPath)).toBe(true);
    expect(output.join('\n')).toMatch(/Hosted Link/);
  });

  it('re-prompts after bad keys and succeeds on a later attempt', async () => {
    const env = makeEnv();
    const { deps, verified } = harness(
      {
        selects: ['sandbox'],
        lines: ['typo_id', CLIENT_ID],
        secrets: ['typo_secret', SECRET],
        confirms: [false],
      },
      {
        env,
        verify: (_cfg, attempt) =>
          attempt === 1
            ? Promise.reject(
                new PlaidApiError('bad keys', 'INVALID_API_KEYS', 'INVALID_INPUT', 400),
              )
            : Promise.resolve({ linkToken: 'link-tok', hostedLinkUrl: 'https://hosted' }),
      },
    );

    await runInit(deps);

    expect(verified).toHaveLength(2);
    expect(loadConfig(env).clientId).toBe(CLIENT_ID);
  });

  it('gives up after repeated bad keys and writes nothing', async () => {
    const env = makeEnv();
    const { deps } = harness(
      {
        selects: ['sandbox'],
        lines: ['a', 'b', 'c'],
        secrets: ['1', '2', '3'],
        confirms: [false],
      },
      {
        env,
        verify: () =>
          Promise.reject(new PlaidApiError('bad keys', 'INVALID_API_KEYS', 'INVALID_INPUT', 400)),
      },
    );

    await expect(runInit(deps)).rejects.toThrow(/INVALID_API_KEYS|credential/i);
    expect(readdirSync(env['LEDGER_CONFIG_DIR'] as string)).toEqual([]);
  });

  it('surfaces a non-credential Plaid failure immediately instead of re-prompting', async () => {
    const env = makeEnv();
    const { deps, verified } = harness(HAPPY, {
      env,
      verify: () => Promise.reject(new PlaidApiError('down', 'INTERNAL_SERVER_ERROR', 'API', 500)),
    });

    // Re-asking for keys would be misleading: the keys are not the problem.
    await expect(runInit(deps)).rejects.toThrow(/down/);
    expect(verified).toHaveLength(1);
  });

  it('rejects an empty client id without calling Plaid', async () => {
    const env = makeEnv();
    const { deps, verified } = harness(
      {
        selects: ['sandbox'],
        lines: ['   ', CLIENT_ID],
        secrets: [SECRET],
        confirms: [false],
      },
      { env },
    );

    await runInit(deps);
    expect(verified).toHaveLength(1);
  });

  it('refuses to clobber an existing config without force', async () => {
    const env = makeEnv(JSON.stringify({ clientId: 'old', secret: 'old' }));
    const { deps, verified, prompterBuilds } = harness(HAPPY, { env });

    await expect(runInit(deps)).rejects.toThrow(ConfigError);
    // The guard must fire before any prompting or network call. Building the
    // prompter first would report "needs a TTY" for a run whose real problem is
    // the existing file — the wrong error, and unfixable by the advice it gives.
    expect(verified).toHaveLength(0);
    expect(prompterBuilds()).toBe(0);
  });

  it('requires an explicit confirmation to overwrite with force', async () => {
    const existing = JSON.stringify({ clientId: 'old', secret: 'old' });
    const env = makeEnv(existing);
    const { deps, verified } = harness(
      { selects: [], lines: [], secrets: [], confirms: [false] },
      { env, force: true },
    );

    await expect(runInit(deps)).rejects.toThrow(/[Cc]ancel/);
    expect(loadConfig(env).clientId).toBe('old');
    expect(verified).toHaveLength(0);
  });

  it('overwrites when force is confirmed', async () => {
    const env = makeEnv(JSON.stringify({ clientId: 'old', secret: 'old' }));
    const { deps } = harness(
      { selects: ['sandbox'], lines: [CLIENT_ID], secrets: [SECRET], confirms: [true, false] },
      { env, force: true },
    );

    await runInit(deps);
    expect(loadConfig(env).clientId).toBe(CLIENT_ID);
  });

  it('reports whether the user asked to link a bank next', async () => {
    const env = makeEnv();
    const { deps } = harness({ ...HAPPY, confirms: [true] }, { env });
    expect((await runInit(deps)).linkNow).toBe(true);
  });
});
