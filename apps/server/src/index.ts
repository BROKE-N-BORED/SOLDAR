#!/usr/bin/env node
// Soldar server entry: serves the API, the WebSocket run stream, and the
// built web app on port 5678. Single-user, localhost only by default.
//
//   SOLDAR_DATA_DIR  where soldar.db and soldar.log live
//                    (default: ~/.config/soldar, or $XDG_CONFIG_HOME/soldar)
//   SOLDAR_PORT      port to listen on (default: 5678)
//   SOLDAR_HOST      interface to listen on (default: 127.0.0.1)
//   SOLDAR_NO_UPDATE_CHECK=1  skip the silent startup update check (tests)
//   SOLDAR_UPDATE_API_BASE    point the update check at another API root
//                    (verification only; production always uses GitHub)

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStorage, ENGINE_VERSION } from '@soldar/engine';
import { createApp } from './app.js';
import { createLogger } from './logger.js';
import { migrateLegacyData, legacyDbWarning, resolveDataDir } from './data-dir.js';
import { UpdateService } from './update.js';

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
  // Written once the server is listening; stop-soldar.sh and the
  // uninstaller read it to find this process.
  const pidPath = join(dataDir, 'soldar.pid');
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
  const portRaw = process.env.SOLDAR_PORT ?? '5678';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(
      `Error: SOLDAR_PORT must be a whole number between 1 and 65535, not "${portRaw}".`,
    );
    process.exit(1);
  }
  const host = process.env.SOLDAR_HOST ?? '127.0.0.1';
  // Soldar has no login yet, so opening it past this computer opens the
  // whole API — every workflow, every run — to the network. Say so loudly
  // instead of starting silently.
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    const warning =
      `Soldar is listening on ${host}, which other computers on the network ` +
      `can reach, and Soldar has no login yet, so anyone who can reach it ` +
      `can read and run every workflow. Keep SOLDAR_HOST at 127.0.0.1 unless ` +
      `you mean to share it.`;
    logger.warn(warning);
    console.error(`Warning: ${warning}`);
  }

  const storage = createStorage(dbPath);
  // A run left "running" by a crash or a restart is not running any more.
  try {
    const stale = storage.markStaleRunningInterrupted();
    if (stale > 0) {
      logger.warn(
        `${stale} run${stale === 1 ? ' was' : 's were'} still marked running from before the restart; marked as interrupted.`,
      );
    }
  } catch (err) {
    logger.warn(
      `Could not check for interrupted runs: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // Retention: keep the newest 200 runs per workflow, drop the rest.
  try {
    const pruned = storage.pruneExecutions(200);
    if (pruned > 0) {
      logger.info(`Pruned ${pruned} old run${pruned === 1 ? '' : 's'} (keeping the newest 200 per workflow).`);
    }
  } catch (err) {
    logger.warn(
      `Could not prune old runs: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const updateService = new UpdateService({
    dataDir,
    appDir: dir,
    currentVersion: ENGINE_VERSION,
    logger,
  });
  const app = await createApp({
    storage,
    logger,
    logPath,
    update: updateService,
    // The updater script is already running detached by the time this
    // fires; the server just needs to get out of the way.
    onRestartRequested: () => void shutdown(),
    // The UI's Stop button: the same graceful shutdown as SIGINT.
    onShutdownRequested: () => void shutdown(),
    webDistDir: join(dir, 'apps', 'web', 'dist'),
  });

  const shutdown = async (): Promise<void> => {
    logger.info('Shutting down.');
    // Let a run in flight finish instead of killing it mid-write (up to
    // 30 seconds, then the shutdown proceeds anyway).
    try {
      await app.runs.waitForIdle();
    } catch {
      // Waiting must never block the shutdown.
    }
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
    // Remove the PID file, but only when it still holds this process's
    // PID — a newer server may have written its own by now.
    try {
      const current = readFileSync(pidPath, 'utf-8').trim();
      if (current === String(process.pid)) rmSync(pidPath, { force: true });
    } catch {
      // Already gone, or never written.
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await app.listen({ port, host });
  logger.info(`Soldar listening on http://${host}:${port}`);
  console.log(`Soldar listening on http://${host}:${port}`);
  try {
    writeFileSync(pidPath, `${process.pid}\n`, 'utf-8');
  } catch {
    // A missing PID file never stops the server; the stop script falls
    // back to matching the process by its command line.
  }
  // The silent startup update check: it runs in the background, never
  // holds up a launch, and a failure is a log line at most — the web UI
  // only shows a popup when a newer release is actually waiting.
  if (process.env.SOLDAR_NO_UPDATE_CHECK !== '1') {
    updateService.startBackgroundCheck();
  }
}

main().catch((err: unknown) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
