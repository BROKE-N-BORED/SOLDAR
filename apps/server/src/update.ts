// Soldar's self-update: check GitHub for a newer Release, and — only when
// the user says so — pull it down, verify it, and stage it for the next
// restart. Modelled on Pixel Forge's updates.py (v0.69): the check never
// raises for a network or parsing problem, a failed check is just
// "unknown" with a plain reason, and a second check while one runs shares
// the in-flight result instead of starting another.
//
// The standing rule (Joshua, 2026-11-17): on launch the app silently
// checks its GitHub repo for a newer Release. Up to date means nothing
// happens — no popup, no noise. An update means a popup that asks, and
// only the user's tap pulls it. The pull goes through the verified path:
// the release's .sha256 sidecar is checked before anything is installed,
// and a release with no checksum is never installed automatically — the
// app offers the release page instead. Once pulled, the app asks about
// restarting: yes restarts on its own with the update applied, no waits
// and the update completes on the next restart (soldar.sh applies a
// staged update before it starts the server).
//
// How the pieces fit:
//   - checkForUpdate asks the GitHub releases API for the latest release
//     and compares its tag with the running version. It also finds the
//     release's zip asset and its .sha256 sidecar, if both are published.
//   - UpdateService holds the last check result, runs the download, and
//     keeps the staged update in the data dir (update/pending-update.json
//     plus the verified zip). The server never touches the app folder
//     itself — that is scripts/apply-update.sh's job, after the server
//     has stopped, so a running server is never overwritten.
//   - The web UI asks /api/update/status and shows the dialog.
//
// Test seams (never used in production): SOLDAR_UPDATE_API_BASE points
// the check at another API root (a local mock server for verification),
// and SOLDAR_NO_UPDATE_CHECK=1 skips the startup check (tests, e2e).

import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

export const GITHUB_REPO = 'BROKE-N-BORED/SOLDAR';
export const GITHUB_API_BASE = 'https://api.github.com';
export const RELEASES_PAGE_URL = `https://github.com/${GITHUB_REPO}/releases`;
// Pixel Forge uses 8 s for the same check; the release payload is small
// and a slow check must never hold up a launch.
export const CHECK_TIMEOUT_MS = 8000;
// A release zip is under 1 MB today. 50 MB leaves generous room for a
// bigger future release while stopping a bad asset from filling the disk.
export const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;

const VERSION_RE = /^v?(\d+(?:\.\d+)*)$/;

// A version string as numbers — "0.3.0" becomes [0, 3, 0], "v0.3.0" the
// same — or null when it is not a version at all. Anything but an
// optional "v" followed by numbers and dots is refused, so a tag like
// "v0.3.0-beta" reads as no usable version rather than a wrong one.
export function parseVersion(text: string): number[] | null {
  if (typeof text !== 'string') return null;
  const match = VERSION_RE.exec(text.trim());
  if (match === null) return null;
  return match[1].split('.').map((part) => Number(part));
}

export function formatVersion(parts: number[]): string {
  return parts.join('.');
}

// True when the latest version is newer than the running one. Either
// side unparsable means no — an unknown version is never reported as an
// update. Shorter versions are padded with zeros, so 0.3 and 0.3.0
// compare equal.
export function isNewer(latest: string, current: string): boolean {
  const latestParsed = parseVersion(latest);
  const currentParsed = parseVersion(current);
  if (latestParsed === null || currentParsed === null) return false;
  const width = Math.max(latestParsed.length, currentParsed.length);
  for (let i = 0; i < width; i += 1) {
    const l = latestParsed[i] ?? 0;
    const c = currentParsed[i] ?? 0;
    if (l !== c) return l > c;
  }
  return false;
}

export type CheckState = 'newer' | 'current' | 'unknown';

export interface CheckResult {
  state: CheckState;
  // The latest release version, or null when the check could not run.
  latest: string | null;
  url: string | null;
  // Plain reason, only when state is 'unknown'.
  reason?: string;
  // Download URLs for the release zip and its .sha256 sidecar, only when
  // state is 'newer'. zipUrl null means the release has no zip asset;
  // shaUrl null means no checksum was published and the update must not
  // be installed automatically.
  zipUrl?: string | null;
  shaUrl?: string | null;
}

export interface CheckOptions {
  apiBase?: string;
  fetchFn?: typeof fetch;
}

interface ReleaseAsset {
  name?: unknown;
  browser_download_url?: unknown;
}

function assetUrl(assets: ReleaseAsset[], name: string): string | null {
  for (const asset of assets) {
    if (asset.name === name && typeof asset.browser_download_url === 'string') {
      return asset.browser_download_url;
    }
  }
  return null;
}

// Ask GitHub for the latest release and compare it with the running
// version. Never throws for a network or parsing problem: every failure
// comes back as state 'unknown' with a plain reason, so the caller can
// stay silent instead of crashing.
export async function checkForUpdate(
  currentVersion: string,
  options: CheckOptions = {},
): Promise<CheckResult> {
  const apiBase = options.apiBase ?? GITHUB_API_BASE;
  const fetchFn = options.fetchFn ?? fetch;
  const url = `${apiBase}/repos/${GITHUB_REPO}/releases/latest`;
  let payload: unknown;
  try {
    const response = await fetchFn(url, {
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) {
      return {
        state: 'unknown',
        latest: null,
        url: null,
        reason: `GitHub answered with ${response.status} instead of the latest release.`,
      };
    }
    payload = await response.json();
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { state: 'unknown', latest: null, url: null, reason: 'The update check timed out.' };
    }
    return {
      state: 'unknown',
      latest: null,
      url: null,
      reason: 'Could not reach GitHub to check for updates.',
    };
  }
  if (typeof payload !== 'object' || payload === null) {
    return {
      state: 'unknown',
      latest: null,
      url: null,
      reason: 'GitHub did not answer in a form Soldar understands.',
    };
  }
  const record = payload as { tag_name?: unknown; html_url?: unknown; assets?: unknown };
  if (typeof record.tag_name !== 'string' || record.tag_name === '') {
    return {
      state: 'unknown',
      latest: null,
      url: null,
      reason: 'The releases page did not name a version.',
    };
  }
  const latestParsed = parseVersion(record.tag_name);
  if (latestParsed === null) {
    return {
      state: 'unknown',
      latest: null,
      url: null,
      reason: `The latest release tag did not look like a version: ${record.tag_name}`,
    };
  }
  const latest = formatVersion(latestParsed);
  const pageUrl =
    typeof record.html_url === 'string' && record.html_url !== ''
      ? record.html_url
      : RELEASES_PAGE_URL;
  if (!isNewer(latest, currentVersion)) {
    return { state: 'current', latest, url: pageUrl };
  }
  const assets = Array.isArray(record.assets) ? (record.assets as ReleaseAsset[]) : [];
  const zipName = `soldar-v${latest}.zip`;
  const zipUrl = assetUrl(assets, zipName);
  if (zipUrl === null) {
    return {
      state: 'unknown',
      latest,
      url: pageUrl,
      reason: `Soldar ${latest} is out, but the release has no ${zipName} to download.`,
    };
  }
  return {
    state: 'newer',
    latest,
    url: pageUrl,
    zipUrl,
    shaUrl: assetUrl(assets, `${zipName}.sha256`),
  };
}

// The first 64 hex characters of a sha256sum sidecar ("<hash>  <file>"),
// or null when the sidecar does not carry a usable hash.
export function parseSha256Sidecar(text: string): string | null {
  const match = /^[0-9a-fA-F]{64}/.exec(text.trim());
  return match === null ? null : match[0].toLowerCase();
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

export interface PendingUpdate {
  version: string;
  zipName: string;
  sha256: string;
  stagedAt: number;
}

export interface UpdateStatus {
  current: string;
  state: CheckState | 'checking';
  latest: string | null;
  url: string | null;
  // True when the update can be pulled: a newer release with a zip asset
  // AND a published checksum. False for a newer release with no
  // checksum — that one is never installed automatically.
  installable: boolean;
  reason?: string;
  // Version of the staged update, when one is waiting for a restart.
  stagedVersion: string | null;
  checking: boolean;
  downloading: boolean;
}

export interface UpdateServiceOptions {
  dataDir: string;
  appDir: string;
  currentVersion: string;
  apiBase?: string;
  fetchFn?: typeof fetch;
  logger?: { info(message: string): void; warn(message: string): void; error(message: string): void };
}

export class UpdateService {
  private readonly dataDir: string;
  private readonly appDir: string;
  private readonly currentVersion: string;
  private readonly apiBase: string;
  private readonly fetchFn: typeof fetch;
  private readonly logger: UpdateServiceOptions['logger'];
  private lastCheck: CheckResult | null = null;
  private checkPromise: Promise<CheckResult> | null = null;
  private downloadPromise: Promise<PendingUpdate> | null = null;
  private staged: PendingUpdate | null = null;
  private stagedLoaded = false;

  constructor(options: UpdateServiceOptions) {
    this.dataDir = options.dataDir;
    this.appDir = options.appDir;
    this.currentVersion = options.currentVersion;
    this.apiBase = options.apiBase ?? process.env.SOLDAR_UPDATE_API_BASE ?? GITHUB_API_BASE;
    this.fetchFn = options.fetchFn ?? fetch;
    this.logger = options.logger;
  }

  get updateDir(): string {
    return join(this.dataDir, 'update');
  }

  get appDirPath(): string {
    return this.appDir;
  }

  get dataDirPath(): string {
    return this.dataDir;
  }

  private pendingPath(): string {
    return join(this.updateDir, 'pending-update.json');
  }

  // The staged update, if one is waiting. The staged zip is re-checked
  // against its recorded hash before it counts: a damaged or half-written
  // stage is dropped, never offered. A stage for this version or older
  // (the user updated some other way) is dropped too.
  async pendingUpdate(): Promise<PendingUpdate | null> {
    if (this.stagedLoaded) return this.staged;
    this.stagedLoaded = true;
    this.staged = null;
    const path = this.pendingPath();
    if (!existsSync(path)) return null;
    let record: unknown;
    try {
      record = JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      this.clearPending();
      return null;
    }
    if (typeof record !== 'object' || record === null) {
      this.clearPending();
      return null;
    }
    const { version, zipName, sha256, stagedAt } = record as Partial<PendingUpdate>;
    if (
      typeof version !== 'string' ||
      typeof zipName !== 'string' ||
      typeof sha256 !== 'string' ||
      typeof stagedAt !== 'number'
    ) {
      this.clearPending();
      return null;
    }
    if (!isNewer(version, this.currentVersion)) {
      this.clearPending();
      return null;
    }
    const zipPath = join(this.updateDir, zipName);
    if (!existsSync(zipPath)) {
      this.clearPending();
      return null;
    }
    try {
      const actual = await sha256File(zipPath);
      if (actual !== sha256.toLowerCase()) {
        this.logger?.warn(`Staged update ${version} failed its checksum; dropping it.`);
        this.clearPending();
        return null;
      }
    } catch {
      this.clearPending();
      return null;
    }
    this.staged = { version, zipName, sha256: sha256.toLowerCase(), stagedAt };
    return this.staged;
  }

  clearPending(): void {
    this.staged = null;
    // Remove the staged files, but keep update.log as the record.
    rmSync(this.pendingPath(), { force: true });
    if (!existsSync(this.updateDir)) return;
    for (const name of readdirSync(this.updateDir)) {
      if (name.startsWith('soldar-v') && (name.endsWith('.zip') || name.endsWith('.zip.sha256'))) {
        rmSync(join(this.updateDir, name), { force: true });
      }
    }
    rmSync(join(this.updateDir, 'dist-backup'), { recursive: true, force: true });
  }

  async status(): Promise<UpdateStatus> {
    const staged = await this.pendingUpdate();
    const checking = this.checkPromise !== null;
    const downloading = this.downloadPromise !== null;
    const state: UpdateStatus['state'] =
      this.lastCheck === null ? (checking ? 'checking' : 'unknown') : this.lastCheck.state;
    return {
      current: this.currentVersion,
      state,
      latest: this.lastCheck?.latest ?? null,
      url: this.lastCheck?.url ?? null,
      installable:
        this.lastCheck?.state === 'newer' &&
        this.lastCheck.zipUrl !== null &&
        this.lastCheck.zipUrl !== undefined &&
        this.lastCheck.shaUrl !== null &&
        this.lastCheck.shaUrl !== undefined,
      reason: this.lastCheck?.reason,
      stagedVersion: staged?.version ?? null,
      checking,
      downloading,
    };
  }

  // Run the check now. A check already in flight is shared, not doubled:
  // the caller awaits the same result.
  checkNow(): Promise<CheckResult> {
    if (this.checkPromise !== null) return this.checkPromise;
    this.checkPromise = checkForUpdate(this.currentVersion, {
      apiBase: this.apiBase,
      fetchFn: this.fetchFn,
    })
      .then((result) => {
        this.lastCheck = result;
        return result;
      })
      .finally(() => {
        this.checkPromise = null;
      });
    return this.checkPromise;
  }

  // The silent startup check: fire and forget, never blocks a launch,
  // and a failure is a log line at most — never a popup.
  startBackgroundCheck(): void {
    void this.checkNow().then((result) => {
      if (result.state === 'newer') {
        this.logger?.info(`Update available: Soldar ${result.latest}.`);
      } else if (result.state === 'unknown') {
        this.logger?.info(`Update check could not run: ${result.reason ?? 'unknown reason'}`);
      }
    });
  }

  // Pull the newer release, verify it against its published checksum,
  // and stage it for the next restart. Only runs when the last check
  // found a newer release with a zip AND a checksum — anything else is
  // refused, never installed blind.
  download(): Promise<PendingUpdate> {
    if (this.downloadPromise !== null) return this.downloadPromise;
    this.downloadPromise = this.downloadOnce().finally(() => {
      this.downloadPromise = null;
    });
    return this.downloadPromise;
  }

  private async downloadOnce(): Promise<PendingUpdate> {
    const check = this.lastCheck;
    if (check === null || check.state !== 'newer') {
      throw new Error('No update is waiting to download.');
    }
    if (!check.zipUrl) {
      throw new Error('The release has no file to download.');
    }
    if (!check.shaUrl) {
      throw new Error(
        `Soldar ${check.latest} is out, but it has no checksum published, so it cannot be installed automatically.`,
      );
    }
    const version = check.latest as string;
    const zipName = `soldar-v${version}.zip`;
    mkdirSync(this.updateDir, { recursive: true });
    const zipPath = join(this.updateDir, zipName);
    const sidecarPath = join(this.updateDir, `${zipName}.sha256`);
    try {
      const sidecarText = await this.fetchText(check.shaUrl);
      const expected = parseSha256Sidecar(sidecarText);
      if (expected === null) {
        throw new Error('The published checksum could not be read, so the update was not installed.');
      }
      await this.fetchToFile(check.zipUrl, zipPath);
      const actual = await sha256File(zipPath);
      if (actual !== expected) {
        throw new Error(
          'The downloaded update did not match its published checksum, so it was thrown away. Nothing was installed.',
        );
      }
      writeFileSync(sidecarPath, sidecarText);
      const pending: PendingUpdate = {
        version,
        zipName,
        sha256: expected,
        stagedAt: Date.now(),
      };
      writeFileSync(this.pendingPath(), JSON.stringify(pending, null, 2));
      this.staged = pending;
      this.stagedLoaded = true;
      this.logger?.info(`Update ${version} downloaded, verified, and staged.`);
      return pending;
    } catch (err) {
      rmSync(zipPath, { force: true });
      rmSync(sidecarPath, { force: true });
      rmSync(this.pendingPath(), { force: true });
      throw err;
    }
  }

  // Start the updater for a restart now. The script runs detached: it
  // waits for this server to stop answering, applies the staged update,
  // and relaunches Soldar. The caller replies to the user first and then
  // shuts the server down — the script does the rest on its own.
  async prepareRestart(): Promise<PendingUpdate> {
    const staged = await this.pendingUpdate();
    if (staged === null) {
      throw new Error('No update is waiting to install.');
    }
    const script = join(this.appDir, 'scripts', 'apply-update.sh');
    if (!existsSync(script)) {
      throw new Error('The update script is missing from this install, so the update cannot be applied.');
    }
    const port = process.env.SOLDAR_PORT ?? '5678';
    const child = spawn(
      'bash',
      [script, this.appDir, this.dataDir, port],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
    this.logger?.info(`Restarting to apply Soldar ${staged.version}.`);
    return staged;
  }

  private async fetchText(url: string): Promise<string> {
    const response = await this.fetchFn(url, {
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      headers: { Accept: 'text/plain' },
    });
    if (!response.ok) {
      throw new Error(`Could not fetch the published checksum (GitHub answered ${response.status}).`);
    }
    return response.text();
  }

  private async fetchToFile(url: string, destPath: string): Promise<void> {
    const response = await this.fetchFn(url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      headers: { Accept: 'application/octet-stream' },
    });
    if (!response.ok) {
      throw new Error(`Could not download the update (GitHub answered ${response.status}).`);
    }
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && Number(contentLength) > MAX_DOWNLOAD_BYTES) {
      throw new Error('The update is bigger than Soldar will download, so it was refused.');
    }
    if (response.body === null) {
      throw new Error('The download came back empty.');
    }
    // Read chunk by chunk and count the bytes, so an asset that lies
    // about its size (or has no size at all) still cannot fill the disk.
    const reader = response.body.getReader();
    const file = createWriteStream(destPath);
    let written = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        written += value.byteLength;
        if (written > MAX_DOWNLOAD_BYTES) {
          throw new Error('The update is bigger than Soldar will download, so it was refused.');
        }
        if (!file.write(value)) await once(file, 'drain');
      }
    } finally {
      file.end();
    }
    await once(file, 'finish');
  }
}
