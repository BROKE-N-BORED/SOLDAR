import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against workspace source, so no build step is needed first.
    alias: [
      {
        find: '@soldar/engine',
        replacement: path.resolve(root, 'packages/engine/src/index.ts'),
      },
      {
        find: '@soldar/nodes',
        replacement: path.resolve(root, 'packages/nodes/index.ts'),
      },
    ],
  },
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/nodes/**/*.test.ts',
      'apps/server/src/**/*.test.ts',
    ],
    // One worker per test file reloads the native modules
    // (better-sqlite3, isolated-vm) and the whole engine for every file:
    // most of the suite's wall time was that loading, not the tests
    // (collect 177 s vs tests 89 s summed across workers). Sharing
    // workers across files loads them once. Safe here: no test mutates
    // module-level state — each test builds its own storage in a temp
    // dir, and no test mocks modules.
    poolOptions: {
      threads: {
        isolate: false,
      },
    },
  },
});
