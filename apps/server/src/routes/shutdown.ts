// Shutdown route: let the user stop the server from the UI. The server is
// single-user on localhost, so no auth is involved — the same trust as
// every other route. The response goes out first; the actual shutdown
// happens a beat later so the client sees the answer.

import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './context.js';

export function registerShutdownRoute(app: FastifyInstance, ctx: RouteContext): void {
  app.post('/api/shutdown', async (_req, reply) => {
    if (!ctx.onShutdownRequested) {
      reply.code(503);
      return { error: 'Shutdown is not available from this server.' };
    }
    ctx.logger.info('Shutdown requested from the UI.');
    setTimeout(() => ctx.onShutdownRequested?.(), 100).unref();
    return { ok: true };
  });
}
