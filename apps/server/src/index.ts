#!/usr/bin/env node
// Soldar server entry: serves the API, the WebSocket run stream, and the
// built web app on port 5678. Single-user, localhost only by default.
//
//   SOLDAR_DATA_DIR  where soldar.db and soldar.log live
//                    (default: the app directory)
//   SOLDAR_PORT      port to listen on (default: 5678)
//   SOLDAR_HOST      interface to listen on (default: 127.0.0.1)

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStorage } from '@soldar/engine';
import { createApp } from './app.js';
import { createLogger } from './logger.js';

function appDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/index.js and src/index.ts both sit three levels below the app root.
  return join(here, '..', '..', '..');
}

async function main(): Promise<void> {
  const dir = appDir();
  const dataDir = process.env.SOLDAR_DATA_DIR ?? dir;
  // The data dir may not exist yet (a fresh SOLDAR_DATA_DIR, a first run).
  // Make it before anything tries to open the database or the log file.
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, 'soldar.db');
  const logPath = join(dataDir, 'soldar.log');
  const logger = createLogger(logPath);
  const port = Number(process.env.SOLDAR_PORT ?? 5678);
  const host = process.env.SOLDAR_HOST ?? '127.0.0.1';

  const storage = createStorage(dbPath);
  const app = await createApp({
    storage,
    logger,
    logPath,
    webDistDir: join(dir, 'apps', 'web', 'dist'),
  });

  const shutdown = async (): Promise<void> => {
    logger.info('Shutting down.');
    try {
      await app.close();
    } catch {
      // Already closed.
    }
    try {
      storage.close();
    } catch {
      // Already closed.
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await app.listen({ port, host });
  logger.info(`Soldar listening on http://${host}:${port}`);
  console.log(`Soldar listening on http://${host}:${port}`);
}

main().catch((err: unknown) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
