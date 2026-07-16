import { describe, expect, it } from 'vitest';
import { connectPageHtml, startAuthServer } from '../src/auth/server.js';

const callbackBody = {
  accessToken: 'tok_live',
  enrollment: { id: 'enr_9', institution: { name: 'Chase' } },
};

describe('connectPageHtml', () => {
  it('embeds application id, environment, and connect.js', () => {
    const html = connectPageHtml('app_42', 'development');
    expect(html).toContain('app_42');
    expect(html).toContain('development');
    expect(html).toContain('cdn.teller.io/connect/connect.js');
  });
});

describe('startAuthServer', () => {
  it('serves the connect page and resolves on valid callback', async () => {
    const server = startAuthServer({ applicationId: 'app_42', environment: 'development', port: 0 });
    const page = await fetch(server.url);
    expect(await page.text()).toContain('app_42');
    const res = await fetch(`${server.url}callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(callbackBody),
    });
    expect(res.status).toBe(200);
    await expect(server.result).resolves.toEqual({
      accessToken: 'tok_live',
      enrollmentId: 'enr_9',
      institutionName: 'Chase',
    });
  });

  it('rejects malformed callbacks with 400 and keeps waiting', async () => {
    const server = startAuthServer({ applicationId: 'app_42', environment: 'development', port: 0 });
    const res = await fetch(`${server.url}callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nope: true }),
    });
    expect(res.status).toBe(400);
    server.close();
    await expect(server.result).rejects.toThrow(/closed|timed out/i);
  });

  it('times out when no callback arrives', async () => {
    const server = startAuthServer({
      applicationId: 'app_42',
      environment: 'development',
      port: 0,
      timeoutMs: 50,
    });
    await expect(server.result).rejects.toThrow(/timed out/i);
  });
});
