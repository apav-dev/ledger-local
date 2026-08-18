import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, configPathFor, loadConfig, writeConfig } from '../src/core/config.js';

let dir: string;

function makeConfigDir(contents?: string): NodeJS.ProcessEnv {
  dir = mkdtempSync(path.join(tmpdir(), 'ledger-test-'));
  const configDir = path.join(dir, 'config');
  const dataDir = path.join(dir, 'data');
  mkdirSync(configDir, { recursive: true });
  if (contents !== undefined) {
    const file = path.join(configDir, 'config.json');
    writeFileSync(file, contents);
    chmodSync(file, 0o600); // default to the secure case; loosen explicitly per test
  }
  return { LEDGER_CONFIG_DIR: configDir, LEDGER_DATA_DIR: dataDir };
}

const VALID = JSON.stringify({ clientId: 'cid_123', secret: 'sec_456' });

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('throws ConfigError with setup instructions when config.json missing', () => {
    const env = makeConfigDir(undefined);
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(/config\.json/);
    expect(() => loadConfig(env)).toThrow(/dashboard\.plaid\.com/);
  });

  it('loads credentials and defaults environment to sandbox', () => {
    const cfg = loadConfig(makeConfigDir(VALID));
    expect(cfg.clientId).toBe('cid_123');
    expect(cfg.secret).toBe('sec_456');
    expect(cfg.environment).toBe('sandbox');
    expect(cfg.dbPath.endsWith('ledger.db')).toBe(true);
  });

  it('accepts production as an environment', () => {
    const env = makeConfigDir(
      JSON.stringify({ clientId: 'cid_123', secret: 'sec_456', environment: 'production' }),
    );
    expect(loadConfig(env).environment).toBe('production');
  });

  it('rejects environments Plaid no longer has', () => {
    // Plaid retired Development; accepting it would produce a bad base URL.
    const env = makeConfigDir(
      JSON.stringify({ clientId: 'cid_123', secret: 'sec_456', environment: 'development' }),
    );
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  it('requires both clientId and secret', () => {
    expect(() => loadConfig(makeConfigDir(JSON.stringify({ clientId: 'cid_123' })))).toThrow(
      ConfigError,
    );
    expect(() => loadConfig(makeConfigDir(JSON.stringify({ secret: 'sec_456' })))).toThrow(
      ConfigError,
    );
  });

  it('rejects empty-string credentials rather than passing them to Plaid', () => {
    const env = makeConfigDir(JSON.stringify({ clientId: '', secret: 'sec_456' }));
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  it('throws ConfigError on unparseable JSON', () => {
    expect(() => loadConfig(makeConfigDir('{not json'))).toThrow(/Unparseable JSON/);
  });

  it('never puts the secret in a validation error message', () => {
    // The secret is the one value that must not reach stderr on a bad config.
    const env = makeConfigDir(JSON.stringify({ clientId: 'cid_123', secret: 42 }));
    expect(() => loadConfig(env)).toThrow(ConfigError);
    try {
      loadConfig(env);
    } catch (error) {
      expect((error as Error).message).not.toContain('42');
    }
  });

  it('warns when the config holding the secret is group/world readable', () => {
    const env = makeConfigDir(VALID);
    chmodSync(path.join(env['LEDGER_CONFIG_DIR'] as string, 'config.json'), 0o644);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    loadConfig(env);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('chmod 600'));
  });

  it('stays quiet when the config is already mode 600', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    loadConfig(makeConfigDir(VALID));
    expect(stderr).not.toHaveBeenCalled();
  });
});

describe('configPathFor', () => {
  it('resolves the same path loadConfig reads', () => {
    const env = makeConfigDir(VALID);
    expect(configPathFor(env)).toBe(path.join(env['LEDGER_CONFIG_DIR'] as string, 'config.json'));
  });
});

describe('writeConfig', () => {
  const INPUT = { clientId: 'cid_123', secret: 'sec_456', environment: 'sandbox' } as const;

  it('writes a config loadConfig can read back', () => {
    const env = makeConfigDir(undefined);
    const written = writeConfig(INPUT, { env });
    expect(written).toBe(configPathFor(env));

    const cfg = loadConfig(env);
    expect(cfg.clientId).toBe('cid_123');
    expect(cfg.secret).toBe('sec_456');
    expect(cfg.environment).toBe('sandbox');
  });

  it('creates the file mode 600 regardless of umask', () => {
    const env = makeConfigDir(undefined);
    // A loose umask must not be able to widen a file holding a live API secret.
    const previous = process.umask(0o000);
    try {
      writeConfig(INPUT, { env });
    } finally {
      process.umask(previous);
    }
    expect(statSync(configPathFor(env)).mode & 0o777).toBe(0o600);
  });

  it('creates the config directory when it does not exist yet', () => {
    const env = makeConfigDir(undefined);
    const nested = path.join(dir, 'brand', 'new');
    writeConfig(INPUT, { env: { ...env, LEDGER_CONFIG_DIR: nested } });
    expect(statSync(path.join(nested, 'config.json')).isFile()).toBe(true);
  });

  it('refuses to clobber an existing config without force', () => {
    const env = makeConfigDir(VALID);
    expect(() => writeConfig(INPUT, { env })).toThrow(ConfigError);
    expect(() => writeConfig(INPUT, { env })).toThrow(/already exists/);
    // The original must survive an attempted overwrite untouched.
    expect(readFileSync(configPathFor(env), 'utf8')).toBe(VALID);
  });

  it('overwrites when force is set', () => {
    const env = makeConfigDir(VALID);
    writeConfig({ ...INPUT, clientId: 'cid_new' }, { env, force: true });
    expect(loadConfig(env).clientId).toBe('cid_new');
  });

  it('leaves no temp file behind', () => {
    const env = makeConfigDir(undefined);
    writeConfig(INPUT, { env });
    expect(readdirSync(env['LEDGER_CONFIG_DIR'] as string)).toEqual(['config.json']);
  });

  it('rejects empty credentials before touching the disk', () => {
    const env = makeConfigDir(undefined);
    expect(() => writeConfig({ ...INPUT, secret: '' }, { env })).toThrow(ConfigError);
    expect(readdirSync(env['LEDGER_CONFIG_DIR'] as string)).toEqual([]);
  });

  it('never puts the secret in a validation error message', () => {
    const env = makeConfigDir(undefined);
    try {
      writeConfig({ ...INPUT, clientId: '' }, { env });
      expect.unreachable('writeConfig should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain('sec_456');
    }
  });

  it('round-trips production', () => {
    const env = makeConfigDir(undefined);
    writeConfig({ ...INPUT, environment: 'production' }, { env });
    expect(loadConfig(env).environment).toBe('production');
  });
});
