#!/usr/bin/env node
// Soldar server entry: serves the API, the WebSocket run stream, and the
// built web app on port 5678. Single-user, localhost only by default.
//
//   SOLDAR_DATA_DIR  where soldar.db and soldar.log live
//                    (default: ~/.config/soldar, or $XDG_CONFIG_HOME/soldar)
//   SOLDAR_PORT      port to listen on (default: 5678)
//   SOLDAR_HOST      interface to listen on (default: 127.0.0.1)

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStorage } from '@soldar/engine';
import { createApp } from './app.js';
import { createLogger } from './logger.js';
import { migrateLegacyData, legacyDbWarning, resolveDataDir } from './data-dir.js';

function appDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/index.js and src/index.ts both sit three levels below the app root.
  return join(here, '..', '..', '..');
}

async function main(): Promise<void> {
  const dir = appDir();
  const { dataDir, explicit } = resolveDataDir();
  // The data dir may not exist yet (a fresh SOLDAR_DATA_DIR, a first run).
  // Make it before anything tries to open the database or the log file.
  mkdirSync(dataDir, { recursive: true });
  // Up to 0.2.0 the database lived in the app folder. Move it to its new
  // home on first start, unless the user picked a data dir themselves
  // (then their choice stands and nothing is moved, but a warning is
  // still printed so the server never starts silently on an empty
  // database while an old one sits in the app folder). The installer does
  // the same move; this is the backstop for anyone who upgrades without
  // re-running it.
  const migration = explicit
    ? { moved: [] as string[], warnings: [] as string[] }
    : migrateLegacyData(dir, dataDir);
  const dbPath = join(dataDir, 'soldar.db');
  const logPath = join(dataDir, 'soldar.log');
  if (explicit) {
    const warning = legacyDbWarning(dir, dataDir);
    if (warning) migration.warnings.push(warning);
  }
  const logger = createLogger(logPath);
  for (const name of migration.moved) {
    const message = `Moved ${name} from the app folder to ${dataDir}.`;
    logger.info(message);
    console.log(message);
  }
  for (const warning of migration.warnings) {
    logger.warn(warning);
    console.error(`Warning: ${warning}`);
  }
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
