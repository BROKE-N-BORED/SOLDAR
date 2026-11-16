// Where Soldar keeps its data, and how data from the old location moves.
//
// Up to 0.2.0 the database and log lived in the app folder, so reinstalling
// from a new ZIP wiped every workflow and run. Since 0.2.1 they live in
// ~/.config/soldar (or $XDG_CONFIG_HOME/soldar), outside the app folder,
// and SOLDAR_DATA_DIR still overrides the location outright. install.sh
// carries the same logic in shell (see data_dir / migrate_legacy_data
// there); keep the two in step.
//
// Migration only ever runs for the default location. When the user picked
// a data dir themselves with SOLDAR_DATA_DIR, their choice stands and
// nothing is moved out of the app folder.

import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// Files that lived in the app folder before 0.2.1 and belong in the data
// dir now: the database plus SQLite's sidecar files, and the log plus its
// one rotated backup.
const LEGACY_FILES = [
  'soldar.db',
  'soldar.db-wal',
  'soldar.db-shm',
  'soldar.db-journal',
  'soldar.log',
  'soldar.log.1',
];

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  // XDG says the variable must be absolute; a relative value is ignored.
  if (xdg && xdg.startsWith('/')) return join(xdg, 'soldar');
  return join(env.HOME || homedir(), '.config', 'soldar');
}

export interface ResolvedDataDir {
  dataDir: string;
  // True when the location came from SOLDAR_DATA_DIR, not the default.
  explicit: boolean;
}

export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): ResolvedDataDir {
  const override = env.SOLDAR_DATA_DIR;
  if (override) return { dataDir: override, explicit: true };
  return { dataDir: defaultDataDir(env), explicit: false };
}

export interface MigrationResult {
  // File names moved into the data dir, in LEGACY_FILES order.
  moved: string[];
  // Loud warnings: data left behind, or a move that failed. The caller
  // prints these; the server must never silently start with an empty
  // database while an old one sits in the app folder.
  warnings: string[];
}

function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (err) {
    // Across filesystems a rename fails; copy then delete instead. Any
    // other failure is real and goes to the caller.
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    copyFileSync(from, to);
    unlinkSync(from);
  }
}

// When the user picked a data dir themselves with SOLDAR_DATA_DIR, nothing
// is moved out of the app folder, but the server still must not start
// silently on an empty database while an old one sits there. Returns a
// warning to print, or null when there is nothing to warn about.
export function legacyDbWarning(appDir: string, dataDir: string): string | null {
  const legacyDb = join(appDir, 'soldar.db');
  if (!existsSync(legacyDb)) return null;
  if (existsSync(join(dataDir, 'soldar.db'))) return null;
  return (
    `Found an old database at ${legacyDb}, but SOLDAR_DATA_DIR is set to ${dataDir}, ` +
    'so it was left alone. Move it by hand if it holds workflows you want.'
  );
}

export function migrateLegacyData(appDir: string, dataDir: string): MigrationResult {
  const moved: string[] = [];
  const warnings: string[] = [];
  if (resolve(appDir) === resolve(dataDir)) return { moved, warnings };
  const legacyDb = join(appDir, 'soldar.db');
  if (!existsSync(legacyDb)) return { moved, warnings };
  const dbPath = join(dataDir, 'soldar.db');
  if (existsSync(dbPath)) {
    warnings.push(
      `Found an old database at ${legacyDb}, but ${dbPath} already exists, so the old one was left alone. Move it by hand if it holds workflows you want.`,
    );
    return { moved, warnings };
  }
  mkdirSync(dataDir, { recursive: true });
  for (const name of LEGACY_FILES) {
    const from = join(appDir, name);
    const to = join(dataDir, name);
    if (!existsSync(from)) continue;
    if (existsSync(to)) {
      warnings.push(`Did not move ${from}: ${to} already exists.`);
      continue;
    }
    try {
      moveFile(from, to);
      moved.push(name);
    } catch (err) {
      warnings.push(
        `Could not move ${from} to ${to}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return { moved, warnings };
}
