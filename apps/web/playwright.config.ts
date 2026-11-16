import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { e2eDataDir } from './tests/paths.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Runs against the production build: run `pnpm build` from the repo root
// first (the server serves the built web app on port 5678).
export default defineConfig({
  testDir: './tests',
  timeout: 60000,
  // A desktop-sized window: the editor's palette + canvas + side panel need
  // the room, or the nodes on the right end up under the side panel and
  // connection drags cannot reach their handles.
  use: {
    baseURL: 'http://127.0.0.1:5678',
    viewport: { width: 1600, height: 900 },
  },
  webServer: {
    command: 'node ../../apps/server/dist/index.js',
    cwd: here,
    env: {
      SOLDAR_DATA_DIR: e2eDataDir,
      SOLDAR_PORT: '5678',
      SOLDAR_HOST: '127.0.0.1',
    },
    url: 'http://127.0.0.1:5678/api/health',
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
});
