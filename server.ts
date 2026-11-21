import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { getDatabase } from './server/db/database.ts';
import { recordAuditEvent } from './server/audit/auditService.ts';
import { createApiRouter } from './server/routes/api.ts';
import { getRealtimeSyncService } from './server/services/realtimeSyncService.ts';
import { ensureLocalBootstrapFile } from './server/services/securityService.ts';

const PORT = Number(process.env.PORT ?? 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

function resolveServerBindHost(): string {
  const explicit = (process.env.NG_ILMF_BIND_HOST ?? '').trim();
  if (explicit) return explicit;
  const isTermuxOrAndroid =
    Boolean(process.env.TERMUX_VERSION) ||
    Boolean(process.env.ANDROID_ROOT) ||
    fs.existsSync('/data/data/com.termux');
  return isTermuxOrAndroid ? '127.0.0.1' : '0.0.0.0';
}

async function startServer() {
  // Initialize SQLite database and record real server boot event
  const db = getDatabase();
  const bootstrapToken = ensureLocalBootstrapFile(db);

  const bindHost = resolveServerBindHost();

  recordAuditEvent(db, {
    actor: 'SYSTEM',
    category: 'LIFECYCLE',
    action: 'COMMAND_CENTER_BOOT',
    target: `${bindHost}:${PORT}`,
    outcome: 'INFO',
    details: {
      nodeVersion: process.version,
      mode: IS_PROD ? 'production' : 'development',
      bindHost,
      ownerBootstrapPending: Boolean(bootstrapToken),
    },
  });

  if (bootstrapToken && !process.env.NG_ILMF_BOOTSTRAP_TOKEN) {
    console.log(
      '[NG-ILMF] Initial Owner Lock bootstrap token initialized at workspace .bootstrap_token (mode 0600).',
    );
  }

  // Start background real-time metrics synchronization loop for subscribed clients
  const syncService = getRealtimeSyncService();
  syncService.start(db, 5000);

  const app = express();
  app.disable('x-powered-by');
  app.use(
    express.json({
      limit: '16mb',
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: string }).rawBody = buf.toString('utf-8');
      },
    }),
  );
  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err && typeof err === 'object' && 'type' in err && (err as { type?: string }).type === 'entity.too.large') {
      res.status(413).json({ error: 'Request payload exceeds 16MB limit' });
      return;
    }
    if (err instanceof SyntaxError) {
      res.status(400).json({ error: 'Malformed JSON request body' });
      return;
    }
    next(err);
  });

  // Mount API routes
  app.use('/api/v1', createApiRouter());

  if (!IS_PROD) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const server = app.listen(PORT, bindHost, () => {
    console.log(`NG-ILMF Command Center listening on http://${bindHost}:${PORT}`);
  });

  const shutdown = () => {
    syncService.stop();
    server.close();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
