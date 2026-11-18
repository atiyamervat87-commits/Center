import express from 'express';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { getDatabase } from './server/db/database.ts';
import { recordAuditEvent } from './server/audit/auditService.ts';
import { createApiRouter } from './server/routes/api.ts';

const PORT = Number(process.env.PORT ?? 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

async function startServer() {
  // Initialize SQLite database and record real server boot event
  const db = getDatabase();
  recordAuditEvent(db, {
    actor: 'SYSTEM',
    category: 'LIFECYCLE',
    action: 'COMMAND_CENTER_BOOT',
    target: `port:${PORT}`,
    outcome: 'INFO',
    details: {
      nodeVersion: process.version,
      mode: IS_PROD ? 'production' : 'development',
    },
  });

  const app = express();
  app.use(express.json({ limit: '2mb' }));

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

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`NG-ILMF Command Center listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
