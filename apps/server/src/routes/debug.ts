// Debug log download: the server's timestamped log file, as plain text.
// The Help view links here so a problem can be reported with the log.

import { existsSync, readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './context.js';

export function registerDebugRoute(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/api/debug-log', async (_req, reply) => {
    let text = '';
    if (existsSync(ctx.logPath)) {
      try {
        text = readFileSync(ctx.logPath, 'utf-8');
      } catch {
        text = '';
      }
    }
    reply.header('content-type', 'text/plain; charset=utf-8');
    return text;
  });
}
