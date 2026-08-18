#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from '../core/config.js';
import { openDb } from '../core/db.js';
import { clientFromConfig } from '../core/plaid-client.js';
import { buildMcpServer } from './server.js';

const cfg = loadConfig();
const db = openDb(cfg.dbPath, cfg.environment);
const api = clientFromConfig(cfg);
const server = buildMcpServer({ db, api, cfg });
await server.connect(new StdioServerTransport());
