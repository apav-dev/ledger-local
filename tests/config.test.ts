import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, certsPresent, loadConfig } from '../src/core/config.js';

let dir: string;

function makeConfigDir(contents?: string): NodeJS.ProcessEnv {
  dir = mkdtempSync(path.join(tmpdir(), 'teller-test-'));
  const configDir = path.join(dir, 'config');
  const dataDir = path.join(dir, 'data');
  mkdirSync(configDir, { recursive: true });
  if (contents !== undefined) {
    writeFileSync(path.join(configDir, 'config.json'), contents);
  }
  return { TELLER_CONFIG_DIR: configDir, TELLER_DATA_DIR: dataDir };
}

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('loadConfig', () => {
  it('throws ConfigError with setup instructions when config.json missing', () => {
    const env = makeConfigDir(undefined);
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(/config\.json/);
  });

  it('loads applicationId and defaults environment to development', () => {
    const env = makeConfigDir(JSON.stringify({ applicationId: 'app_123' }));
    const cfg = loadConfig(env);
    expect(cfg.applicationId).toBe('app_123');
    expect(cfg.environment).toBe('development');
    expect(cfg.dbPath.endsWith('teller.db')).toBe(true);
    expect(cfg.certPath.endsWith('certificate.pem')).toBe(true);
  });

  it('rejects invalid environment values', () => {
    const env = makeConfigDir(
      JSON.stringify({ applicationId: 'app_123', environment: 'prod' }),
    );
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  it('certsPresent is false until both pem files exist', () => {
    const env = makeConfigDir(JSON.stringify({ applicationId: 'app_123' }));
    const cfg = loadConfig(env);
    expect(certsPresent(cfg)).toBe(false);
    writeFileSync(cfg.certPath, 'CERT');
    writeFileSync(cfg.keyPath, 'KEY');
    expect(certsPresent(cfg)).toBe(true);
  });
});
