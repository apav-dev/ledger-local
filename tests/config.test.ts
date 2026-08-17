import { chmodSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, loadConfig } from '../src/core/config.js';

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
