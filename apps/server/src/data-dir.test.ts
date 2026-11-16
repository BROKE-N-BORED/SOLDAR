// Tests for the data dir resolution and the 0.2.0 -> 0.2.1 migration
// (the database used to live in the app folder; it now lives in
// ~/.config/soldar). Everything runs in temp dirs; nothing touches the
// real home directory.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultDataDir, legacyDbWarning, migrateLegacyData, resolveDataDir } from './data-dir.js';

describe('defaultDataDir', () => {
  it('uses $XDG_CONFIG_HOME when it is absolute', () => {
    expect(defaultDataDir({ XDG_CONFIG_HOME: '/home/test/.xdg', HOME: '/home/test' })).toBe(
      '/home/test/.xdg/soldar',
    );
  });

  it('falls back to ~/.config/soldar when $XDG_CONFIG_HOME is unset', () => {
    expect(defaultDataDir({ HOME: '/home/test' })).toBe('/home/test/.config/soldar');
  });

  it('ignores a relative $XDG_CONFIG_HOME', () => {
    expect(defaultDataDir({ XDG_CONFIG_HOME: 'relative/path', HOME: '/home/test' })).toBe(
      '/home/test/.config/soldar',
    );
  });
});

describe('resolveDataDir', () => {
  it('lets SOLDAR_DATA_DIR win and marks the choice explicit', () => {
    const resolved = resolveDataDir({
      SOLDAR_DATA_DIR: '/somewhere/else',
      XDG_CONFIG_HOME: '/home/test/.xdg',
      HOME: '/home/test',
    });
    expect(resolved).toEqual({ dataDir: '/somewhere/else', explicit: true });
  });

  it('uses the default and marks it not explicit without SOLDAR_DATA_DIR', () => {
    const resolved = resolveDataDir({ HOME: '/home/test' });
    expect(resolved).toEqual({ dataDir: '/home/test/.config/soldar', explicit: false });
  });
});

describe('legacyDbWarning', () => {
  let root: string;
  let appDir: string;
  let dataDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'soldar-data-dir-test-'));
    appDir = join(root, 'app');
    dataDir = join(root, 'config', 'soldar');
    mkdirSync(appDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('warns when an old database sits in the app folder and the data dir is empty', () => {
    writeFileSync(join(appDir, 'soldar.db'), 'old-db');
    const warning = legacyDbWarning(appDir, dataDir);
    expect(warning).toContain(join(appDir, 'soldar.db'));
    expect(warning).toContain(dataDir);
  });

  it('stays quiet when the data dir already has a database', () => {
    writeFileSync(join(appDir, 'soldar.db'), 'old-db');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'soldar.db'), 'new-db');
    expect(legacyDbWarning(appDir, dataDir)).toBeNull();
  });

  it('stays quiet when there is no old database', () => {
    expect(legacyDbWarning(appDir, dataDir)).toBeNull();
  });
});

describe('migrateLegacyData', () => {
  let root: string;
  let appDir: string;
  let dataDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'soldar-data-dir-test-'));
    appDir = join(root, 'app');
    dataDir = join(root, 'config', 'soldar');
    mkdirSync(appDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('moves the database and the log into a fresh data dir', () => {
    writeFileSync(join(appDir, 'soldar.db'), 'fake-db');
    writeFileSync(join(appDir, 'soldar.log'), 'fake-log');
    const result = migrateLegacyData(appDir, dataDir);
    expect(result).toEqual({ moved: ['soldar.db', 'soldar.log'], warnings: [] });
    expect(existsSync(join(dataDir, 'soldar.db'))).toBe(true);
    expect(existsSync(join(dataDir, 'soldar.log'))).toBe(true);
    expect(existsSync(join(appDir, 'soldar.db'))).toBe(false);
    expect(existsSync(join(appDir, 'soldar.log'))).toBe(false);
  });

  it('moves SQLite sidecar files and the rotated log too', () => {
    writeFileSync(join(appDir, 'soldar.db'), 'fake-db');
    writeFileSync(join(appDir, 'soldar.db-wal'), 'fake-wal');
    writeFileSync(join(appDir, 'soldar.db-shm'), 'fake-shm');
    writeFileSync(join(appDir, 'soldar.db-journal'), 'fake-journal');
    writeFileSync(join(appDir, 'soldar.log.1'), 'fake-old-log');
    const result = migrateLegacyData(appDir, dataDir);
    expect(result.moved).toEqual([
      'soldar.db',
      'soldar.db-wal',
      'soldar.db-shm',
      'soldar.db-journal',
      'soldar.log.1',
    ]);
    expect(result.warnings).toEqual([]);
    for (const name of result.moved) {
      expect(existsSync(join(dataDir, name))).toBe(true);
      expect(existsSync(join(appDir, name))).toBe(false);
    }
  });

  it('creates the data dir when it does not exist yet', () => {
    writeFileSync(join(appDir, 'soldar.db'), 'fake-db');
    expect(existsSync(dataDir)).toBe(false);
    migrateLegacyData(appDir, dataDir);
    expect(existsSync(join(dataDir, 'soldar.db'))).toBe(true);
  });

  it('leaves the old database alone and warns when the data dir already has one', () => {
    writeFileSync(join(appDir, 'soldar.db'), 'old-db');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'soldar.db'), 'new-db');
    const result = migrateLegacyData(appDir, dataDir);
    expect(result.moved).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(join(appDir, 'soldar.db'));
    expect(existsSync(join(appDir, 'soldar.db'))).toBe(true);
  });

  it('does nothing when there is no legacy database, even with a legacy log', () => {
    writeFileSync(join(appDir, 'soldar.log'), 'fake-log');
    const result = migrateLegacyData(appDir, dataDir);
    expect(result).toEqual({ moved: [], warnings: [] });
    expect(existsSync(join(appDir, 'soldar.log'))).toBe(true);
  });

  it('never overwrites a file that already exists at the destination', () => {
    writeFileSync(join(appDir, 'soldar.db'), 'old-db');
    writeFileSync(join(appDir, 'soldar.log'), 'old-log');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'soldar.log'), 'new-log');
    const result = migrateLegacyData(appDir, dataDir);
    expect(result.moved).toEqual(['soldar.db']);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('soldar.log');
    expect(existsSync(join(appDir, 'soldar.log'))).toBe(true);
  });

  it('does nothing when the app dir and the data dir are the same place', () => {
    writeFileSync(join(appDir, 'soldar.db'), 'fake-db');
    const result = migrateLegacyData(appDir, appDir);
    expect(result).toEqual({ moved: [], warnings: [] });
    expect(existsSync(join(appDir, 'soldar.db'))).toBe(true);
  });
});
