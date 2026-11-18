// Debug log download: the server's timestamped log file, as plain text.
// The Help view links here so a problem can be reported with the log.

import { createReadStream, existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './context.js';

export function registerDebugRoute(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/api/debug-log', async (_req, reply) => {
    reply.header('content-type', 'text/plain; charset=utf-8');
    if (!existsSync(ctx.logPath)) {
      return '';
    }
    // Streamed, never read whole into memory: the log rotates at 1 MB,
    // and one request should not park that on the event loop.
    return createReadStream(ctx.logPath, 'utf-8');
  });
}
