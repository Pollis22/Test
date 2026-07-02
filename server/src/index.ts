import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { env } from './env.js';
import { pool } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { publicRouter } from './routes/public.js';
import { webhooksRouter } from './routes/webhooks.js';
import { authRouter } from './routes/auth.js';
import { dashboardRouter } from './routes/dashboard.js';
import { toolsRouter } from './routes/tools.js';
import { startJobs } from './jobs/scheduler.js';

const app = express();
app.use(cookieParser(env.sessionSecret));

// webhooks mount BEFORE json parser (stripe raw-body verification)
app.use('/api/payments', webhooksRouter);
// capture raw bytes for HMAC verification (voice tool webhooks)
app.use(express.json({ verify: (req, _res, buf) => ((req as express.Request & { rawBody?: Buffer }).rawBody = buf) }));

app.get('/healthz', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, payments: env.paymentsMode, email: env.emailMode, google: env.googleCalendarEnabled });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.use('/api', publicRouter);
app.use('/api/auth', authRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/tools', toolsRouter);

// last-resort error handler — a bad request must never kill the process
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[express]', err);
  if (!res.headersSent) res.status(500).json({ error: 'INTERNAL' });
});
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));

// production: serve the built client
const here = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(here, '../../client/dist');
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

async function main() {
  await runMigrations(pool);
  startJobs();
  app.listen(env.port, () => {
    console.log(`[server] Prelo Booking on :${env.port} (payments=${env.paymentsMode}, email=${env.emailMode}, google=${env.googleCalendarEnabled ? 'on' : 'off'})`);
  });
}

// Export for tests; run when invoked directly.
export { app };
const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
