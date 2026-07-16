import http from 'node:http';
import { z } from 'zod';

export interface AuthResult {
  accessToken: string;
  enrollmentId: string;
  institutionName: string;
}

const CallbackSchema = z.object({
  accessToken: z.string().min(1),
  enrollment: z.object({
    id: z.string().min(1),
    institution: z.object({ name: z.string().min(1) }),
  }),
});

export function connectPageHtml(applicationId: string, environment: string): string {
  const config = JSON.stringify({ applicationId, environment, selectAccount: 'multiple' });
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Teller — Link a bank</title>
  <script src="https://cdn.teller.io/connect/connect.js"></script>
</head>
<body style="font-family: system-ui; display: grid; place-items: center; min-height: 90vh">
  <div id="status"><h2>Opening Teller Connect…</h2></div>
  <script>
    const setup = Object.assign({}, ${config}, {
      onSuccess: function (enrollment) {
        fetch('/callback', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(enrollment),
        }).then(function () {
          document.getElementById('status').innerHTML =
            '<h2>Bank linked. You can close this tab and return to the terminal.</h2>';
        });
      },
      onExit: function () {
        document.getElementById('status').innerHTML =
          '<h2>Teller Connect closed. Re-run <code>teller auth</code> to try again.</h2>';
      },
    });
    TellerConnect.setup(setup).open();
  </script>
</body>
</html>`;
}

const DEFAULT_PORT = 8021;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export function startAuthServer(opts: {
  applicationId: string;
  environment: string;
  port?: number;
  timeoutMs?: number;
}): { url: string; result: Promise<AuthResult>; close: () => void } {
  let resolveResult: (r: AuthResult) => void;
  let rejectResult: (e: Error) => void;
  const result = new Promise<AuthResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  let settled = false;
  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    fn();
    clearTimeout(timer);
    server.close();
  };

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(connectPageHtml(opts.applicationId, opts.environment));
      return;
    }
    if (req.method === 'POST' && req.url === '/callback') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          parsed = null;
        }
        const check = CallbackSchema.safeParse(parsed);
        if (!check.success) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid enrollment payload' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        settle(() =>
          resolveResult({
            accessToken: check.data.accessToken,
            enrollmentId: check.data.enrollment.id,
            institutionName: check.data.enrollment.institution.name,
          }),
        );
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const timer = setTimeout(() => {
    settle(() => rejectResult(new Error('Enrollment timed out — no callback received')));
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  timer.unref();

  server.listen(opts.port ?? DEFAULT_PORT);
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : (opts.port ?? DEFAULT_PORT);

  return {
    url: `http://localhost:${port}/`,
    result,
    close: () => settle(() => rejectResult(new Error('Auth server closed'))),
  };
}
