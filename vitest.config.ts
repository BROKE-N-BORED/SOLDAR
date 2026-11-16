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
  },
});
