import os from 'node:os';
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
    const server = await startAuthServer({ applicationId: 'app_42', environment: 'development', port: 0 });
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
    const server = await startAuthServer({ applicationId: 'app_42', environment: 'development', port: 0 });
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
    const server = await startAuthServer({
      applicationId: 'app_42',
      environment: 'development',
      port: 0,
      timeoutMs: 50,
    });
    await expect(server.result).rejects.toThrow(/timed out/i);
  });

  it('rejects on server error (e.g. EADDRINUSE) instead of crashing the process', async () => {
    const serverA = await startAuthServer({ applicationId: 'app_42', environment: 'development', port: 0 });
    const port = Number(new URL(serverA.url).port);

    await expect(
      startAuthServer({ applicationId: 'app_42', environment: 'development', port }),
    ).rejects.toThrow(/EADDRINUSE/);

    serverA.close();
    await expect(serverA.result).rejects.toThrow(/closed|timed out/i);
  });

  it('binds to loopback only, not all interfaces', async () => {
    const server = await startAuthServer({ applicationId: 'app_42', environment: 'development', port: 0 });
    const port = Number(new URL(server.url).port);

    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);

    const nonLoopback = Object.values(os.networkInterfaces())
      .filter((ifaces): ifaces is os.NetworkInterfaceInfo[] => Boolean(ifaces))
      .flat()
      .find((iface) => iface.family === 'IPv4' && !iface.internal);

    if (nonLoopback) {
      await expect(
        fetch(`http://${nonLoopback.address}:${port}/`, { signal: AbortSignal.timeout(500) }),
      ).rejects.toThrow();
    }

    server.close();
    await expect(server.result).rejects.toThrow(/closed|timed out/i);
  });
});
