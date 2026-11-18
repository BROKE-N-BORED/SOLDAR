// Tests for the self-update module. A local mock server stands in for
// GitHub's releases API, so no test here ever touches the network.

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  checkForUpdate,
  isNewer,
  parseSha256Sidecar,
  parseVersion,
  sha256File,
  UpdateService,
} from './update.js';

const ZIP_BYTES = Buffer.from('fake zip contents for the update tests');
const ZIP_HASH = createHash('sha256').update(ZIP_BYTES).digest('hex');
const WRONG_HASH = '0'.repeat(64);

type MockMode =
  | 'newer-with-checksum'
  | 'newer-no-checksum'
  | 'newer-no-zip'
  | 'newer-wrong-checksum'
  | 'current'
  | 'local-newer'
  | 'server-error'
  | 'bad-json'
  | 'bad-tag'
  | 'slow';

describe('parseVersion', () => {
  it('parses plain and v-prefixed versions', () => {
    expect(parseVersion('0.3.0')).toEqual([0, 3, 0]);
    expect(parseVersion('v0.3.0')).toEqual([0, 3, 0]);
    expect(parseVersion('0.3')).toEqual([0, 3]);
  });

  it('refuses anything that is not numbers and dots', () => {
    expect(parseVersion('v0.3.0-beta')).toBeNull();
    expect(parseVersion('banana')).toBeNull();
    expect(parseVersion('')).toBeNull();
    expect(parseVersion('0.3.0 ')).toEqual([0, 3, 0]);
  });
});

describe('isNewer', () => {
  it('compares versions numerically, padding shorter ones', () => {
    expect(isNewer('0.3.1', '0.3.0')).toBe(true);
    expect(isNewer('0.3.0', '0.3.0')).toBe(false);
    expect(isNewer('0.3.0', '0.3.1')).toBe(false);
    expect(isNewer('0.3', '0.3.0')).toBe(false);
    expect(isNewer('v0.4', '0.3.0')).toBe(true);
    expect(isNewer('0.10.0', '0.9.0')).toBe(true);
  });

  it('never reports an unparsable version as an update', () => {
    expect(isNewer('banana', '0.3.0')).toBe(false);
    expect(isNewer('0.4.0', 'banana')).toBe(false);
  });
});

describe('parseSha256Sidecar', () => {
  it('reads sha256sum format and a bare hash', () => {
    expect(parseSha256Sidecar(`${ZIP_HASH}  soldar-v0.4.0.zip\n`)).toBe(ZIP_HASH);
    expect(parseSha256Sidecar(`${ZIP_HASH}\n`)).toBe(ZIP_HASH);
    expect(parseSha256Sidecar(ZIP_HASH.toUpperCase())).toBe(ZIP_HASH);
  });

  it('refuses garbage', () => {
    expect(parseSha256Sidecar('not a hash')).toBeNull();
    expect(parseSha256Sidecar('')).toBeNull();
  });
});

describe('sha256File', () => {
  it('hashes a file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'soldar-hash-'));
    try {
      const path = join(dir, 'file.bin');
      writeFileSync(path, ZIP_BYTES);
      expect(await sha256File(path)).toBe(ZIP_HASH);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('checkForUpdate against a mock GitHub', () => {
  let server: Server;
  let baseUrl: string;
  let mode: MockMode = 'newer-with-checksum';
  let latestHits = 0;

  beforeEach(async () => {
    latestHits = 0;
    server = createServer((req, res) => {
      if (req.url === '/repos/BROKE-N-BORED/SOLDAR/releases/latest') {
        latestHits += 1;
        const send = (payload: unknown): void => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        const assets = (withZip: boolean, withSha: boolean): unknown[] => {
          const list: unknown[] = [];
          if (withZip) {
            list.push({
              name: 'soldar-v0.4.0.zip',
              browser_download_url: `${baseUrl}/assets/soldar-v0.4.0.zip`,
            });
          }
          if (withSha) {
            list.push({
              name: 'soldar-v0.4.0.zip.sha256',
              browser_download_url: `${baseUrl}/assets/soldar-v0.4.0.zip.sha256`,
            });
          }
          return list;
        };
        switch (mode) {
          case 'newer-with-checksum':
            send({ tag_name: 'v0.4.0', html_url: `${baseUrl}/releases/v0.4.0`, assets: assets(true, true) });
            break;
          case 'newer-no-checksum':
            send({ tag_name: 'v0.4.0', html_url: `${baseUrl}/releases/v0.4.0`, assets: assets(true, false) });
            break;
          case 'newer-no-zip':
            send({ tag_name: 'v0.4.0', html_url: `${baseUrl}/releases/v0.4.0`, assets: assets(false, true) });
            break;
          case 'newer-wrong-checksum':
            send({ tag_name: 'v0.4.0', html_url: `${baseUrl}/releases/v0.4.0`, assets: assets(true, true) });
            break;
          case 'current':
            send({ tag_name: 'v0.3.0', html_url: `${baseUrl}/releases/v0.3.0`, assets: [] });
            break;
          case 'local-newer':
            send({ tag_name: 'v0.2.1', html_url: `${baseUrl}/releases/v0.2.1`, assets: [] });
            break;
          case 'server-error':
            res.writeHead(500);
            res.end('boom');
            break;
          case 'bad-json':
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('this is not json');
            break;
          case 'bad-tag':
            send({ tag_name: 'banana', html_url: `${baseUrl}/releases/banana`, assets: [] });
            break;
          case 'slow':
            setTimeout(() => {
              send({ tag_name: 'v0.4.0', html_url: `${baseUrl}/releases/v0.4.0`, assets: assets(true, true) });
            }, 300);
            break;
        }
        return;
      }
      if (req.url === '/assets/soldar-v0.4.0.zip') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(ZIP_BYTES.length) });
        res.end(ZIP_BYTES);
        return;
      }
      if (req.url === '/assets/soldar-v0.4.0.zip.sha256') {
        const hash = mode === 'newer-wrong-checksum' ? WRONG_HASH : ZIP_HASH;
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(`${hash}  soldar-v0.4.0.zip\n`);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (typeof address !== 'object' || address === null) throw new Error('mock server did not listen');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it('reports a newer release with its zip and checksum URLs', async () => {
    mode = 'newer-with-checksum';
    const result = await checkForUpdate('0.3.0', { apiBase: baseUrl });
    expect(result.state).toBe('newer');
    expect(result.latest).toBe('0.4.0');
    expect(result.zipUrl).toBe(`${baseUrl}/assets/soldar-v0.4.0.zip`);
    expect(result.shaUrl).toBe(`${baseUrl}/assets/soldar-v0.4.0.zip.sha256`);
  });

  it('reports a newer release with no checksum as newer but with no shaUrl', async () => {
    mode = 'newer-no-checksum';
    const result = await checkForUpdate('0.3.0', { apiBase: baseUrl });
    expect(result.state).toBe('newer');
    expect(result.zipUrl).not.toBeNull();
    expect(result.shaUrl).toBeNull();
  });

  it('treats a newer release with no zip asset as unknown, with a plain reason', async () => {
    mode = 'newer-no-zip';
    const result = await checkForUpdate('0.3.0', { apiBase: baseUrl });
    expect(result.state).toBe('unknown');
    expect(result.reason).toContain('soldar-v0.4.0.zip');
  });

  it('reports current when the running version is the latest', async () => {
    mode = 'current';
    const result = await checkForUpdate('0.3.0', { apiBase: baseUrl });
    expect(result.state).toBe('current');
    expect(result.latest).toBe('0.3.0');
  });

  it('reports current when the running version is newer than the latest release', async () => {
    mode = 'local-newer';
    const result = await checkForUpdate('0.3.0', { apiBase: baseUrl });
    expect(result.state).toBe('current');
  });

  it('never throws for a server error, bad JSON, or a bad tag', async () => {
    mode = 'server-error';
    expect((await checkForUpdate('0.3.0', { apiBase: baseUrl })).state).toBe('unknown');
    mode = 'bad-json';
    const badJson = await checkForUpdate('0.3.0', { apiBase: baseUrl });
    expect(badJson.state).toBe('unknown');
    expect(badJson.reason).toBeTruthy();
    mode = 'bad-tag';
    const badTag = await checkForUpdate('0.3.0', { apiBase: baseUrl });
    expect(badTag.state).toBe('unknown');
    expect(badTag.reason).toContain('banana');
  });

  it('never throws when GitHub cannot be reached at all', async () => {
    const result = await checkForUpdate('0.3.0', { apiBase: 'http://127.0.0.1:1' });
    expect(result.state).toBe('unknown');
    expect(result.reason).toContain('Could not reach GitHub');
  });

  it('reports a timeout as unknown with a plain reason', async () => {
    const fetchFn = (async () => {
      const err = new Error('timed out');
      err.name = 'TimeoutError';
      throw err;
    }) as unknown as typeof fetch;
    const result = await checkForUpdate('0.3.0', { apiBase: baseUrl, fetchFn });
    expect(result.state).toBe('unknown');
    expect(result.reason).toContain('timed out');
  });

  it('shares one in-flight check instead of starting a second', async () => {
    mode = 'slow';
    const service = new UpdateService({
      dataDir: mkdtempSync(join(tmpdir(), 'soldar-update-')),
      appDir: '/nonexistent',
      currentVersion: '0.3.0',
      apiBase: baseUrl,
    });
    const [first, second] = await Promise.all([service.checkNow(), service.checkNow()]);
    expect(first).toEqual(second);
    expect(first.state).toBe('newer');
    expect(latestHits).toBe(1);
  });

  describe('UpdateService download and staging', () => {
    let dataDir: string;

    beforeEach(() => {
      dataDir = mkdtempSync(join(tmpdir(), 'soldar-update-'));
    });

    afterEach(() => {
      rmSync(dataDir, { recursive: true, force: true });
    });

    const makeService = (): UpdateService =>
      new UpdateService({ dataDir, appDir: '/nonexistent', currentVersion: '0.3.0', apiBase: baseUrl });

    it('downloads, verifies, and stages a newer release', async () => {
      mode = 'newer-with-checksum';
      const service = makeService();
      await service.checkNow();
      const pending = await service.download();
      expect(pending.version).toBe('0.4.0');
      expect(readFileSync(join(dataDir, 'update', 'soldar-v0.4.0.zip'))).toEqual(ZIP_BYTES);
      expect(existsSync(join(dataDir, 'update', 'pending-update.json'))).toBe(true);
      const status = await service.status();
      expect(status.stagedVersion).toBe('0.4.0');
      expect(status.installable).toBe(true);
    });

    it('refuses a download whose checksum does not match, and leaves nothing staged', async () => {
      mode = 'newer-wrong-checksum';
      const service = makeService();
      await service.checkNow();
      await expect(service.download()).rejects.toThrow('did not match its published checksum');
      expect(existsSync(join(dataDir, 'update', 'soldar-v0.4.0.zip'))).toBe(false);
      expect(existsSync(join(dataDir, 'update', 'pending-update.json'))).toBe(false);
      const status = await service.status();
      expect(status.stagedVersion).toBeNull();
    });

    it('refuses a release with no published checksum, and reports it as not installable', async () => {
      mode = 'newer-no-checksum';
      const service = makeService();
      await service.checkNow();
      const status = await service.status();
      expect(status.state).toBe('newer');
      expect(status.installable).toBe(false);
      await expect(service.download()).rejects.toThrow('no checksum published');
      expect(existsSync(join(dataDir, 'update', 'pending-update.json'))).toBe(false);
    });

    it('refuses to download when nothing newer is waiting', async () => {
      mode = 'current';
      const service = makeService();
      await service.checkNow();
      await expect(service.download()).rejects.toThrow('No update is waiting');
    });

    it('drops a staged update whose zip was damaged afterwards', async () => {
      mode = 'newer-with-checksum';
      const first = makeService();
      await first.checkNow();
      await first.download();
      // Damage the staged zip on disk, then read it back with a fresh
      // service (a restart): it must not count as staged.
      writeFileSync(join(dataDir, 'update', 'soldar-v0.4.0.zip'), 'damaged');
      const second = makeService();
      expect(await second.pendingUpdate()).toBeNull();
      expect(existsSync(join(dataDir, 'update', 'pending-update.json'))).toBe(false);
    });

    it('drops a staged update for this version or older', async () => {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(join(dataDir, 'update'), { recursive: true });
      writeFileSync(join(dataDir, 'update', 'soldar-v0.3.0.zip'), ZIP_BYTES);
      writeFileSync(
        join(dataDir, 'update', 'pending-update.json'),
        JSON.stringify({ version: '0.3.0', zipName: 'soldar-v0.3.0.zip', sha256: ZIP_HASH, stagedAt: Date.now() }),
      );
      const service = makeService();
      expect(await service.pendingUpdate()).toBeNull();
      expect(existsSync(join(dataDir, 'update', 'pending-update.json'))).toBe(false);
    });
  });
});
