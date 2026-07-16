import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { TellerEnvironment } from './types.js';

const ConfigFileSchema = z.object({
  applicationId: z.string().min(1),
  environment: z.enum(['sandbox', 'development', 'production']).default('development'),
});

export interface TellerConfig {
  applicationId: string;
  environment: TellerEnvironment;
  configDir: string;
  certPath: string;
  keyPath: string;
  dbPath: string;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export function setupInstructions(configDir: string): string {
  return [
    `Teller is not configured. To set up:`,
    `  1. Create a Teller application at https://teller.io (dashboard).`,
    `  2. Download your client certificate pair from the dashboard.`,
    `  3. Create ${path.join(configDir, 'config.json')} containing:`,
    `       { "applicationId": "app_...", "environment": "development" }`,
    `  4. Save the certificate as ${path.join(configDir, 'certificate.pem')}`,
    `     and the key as ${path.join(configDir, 'private_key.pem')} (chmod 600 both).`,
    `  5. Run: teller auth`,
  ].join('\n');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): TellerConfig {
  const configDir = env['TELLER_CONFIG_DIR'] ?? path.join(os.homedir(), '.config', 'teller');
  const dataDir = env['TELLER_DATA_DIR'] ?? path.join(os.homedir(), '.local', 'share', 'teller');
  const configPath = path.join(configDir, 'config.json');

  if (!fs.existsSync(configPath)) {
    throw new ConfigError(`Missing ${configPath}.\n${setupInstructions(configDir)}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (cause) {
    throw new ConfigError(`Unparseable JSON in ${configPath}`, { cause });
  }

  const parsed = ConfigFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`Invalid ${configPath}: ${parsed.error.message}`);
  }

  fs.mkdirSync(dataDir, { recursive: true });

  return {
    applicationId: parsed.data.applicationId,
    environment: parsed.data.environment,
    configDir,
    certPath: path.join(configDir, 'certificate.pem'),
    keyPath: path.join(configDir, 'private_key.pem'),
    dbPath: path.join(dataDir, 'teller.db'),
  };
}

export function certsPresent(cfg: TellerConfig): boolean {
  return fs.existsSync(cfg.certPath) && fs.existsSync(cfg.keyPath);
}
