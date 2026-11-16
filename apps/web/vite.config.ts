import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: [
      {
        find: '@soldar/engine',
        replacement: path.resolve(root, '../../packages/engine/src/index.ts'),
      },
      {
        find: '@soldar/nodes',
        replacement: path.resolve(root, '../../packages/nodes/index.ts'),
      },
    ],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:5678',
      '/ws': {
        target: 'ws://127.0.0.1:5678',
        ws: true,
      },
    },
  },
});
