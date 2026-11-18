// The update API: what the web UI uses to ask about updates, pull one,
// and restart into it. Every route answers in plain words; nothing here
// installs anything — the download only stages a verified zip in the
// data dir, and the install itself happens in scripts/apply-update.sh
// after the server has stopped.

import type { FastifyInstance } from 'fastify';
import type { RouteContext } from './context.js';

export function registerUpdateRoutes(app: FastifyInstance, ctx: RouteContext): void {
  // What the UI polls on load: the last check result plus whether an
  // update is staged and waiting for a restart.
  app.get('/api/update/status', async (_req, reply) => {
    if (!ctx.update) {
      reply.code(503);
      return { error: 'Updates are not available in this server.' };
    }
    return ctx.update.status();
  });

  // A fresh check, for the manual "Check for updates" button. A check
  // already in flight is shared, not doubled.
  app.post('/api/update/check', async (_req, reply) => {
    if (!ctx.update) {
      reply.code(503);
      return { error: 'Updates are not available in this server.' };
    }
    await ctx.update.checkNow();
    return ctx.update.status();
  });

  // Pull the newer release and stage it. Refuses unless the last check
  // found a newer release with a zip AND a published checksum, and
  // refuses a download whose bytes do not match that checksum.
  app.post('/api/update/download', async (_req, reply) => {
    if (!ctx.update) {
      reply.code(503);
      return { error: 'Updates are not available in this server.' };
    }
    try {
      await ctx.update.download();
      return ctx.update.status();
    } catch (err) {
      reply.code(502);
      return { error: err instanceof Error ? err.message : 'The update could not be downloaded.' };
    }
  });

  // Restart now to finish a staged update. The updater script is started
  // detached, the reply goes out, and only then does the server shut
  // down — the script waits for the port to go quiet before it touches
  // the app folder.
  app.post('/api/update/restart', async (_req, reply) => {
    if (!ctx.update) {
      reply.code(503);
      return { error: 'Updates are not available in this server.' };
    }
    try {
      const staged = await ctx.update.prepareRestart();
      const onRestart = ctx.onRestartRequested;
      // Let the reply land before the shutdown closes the connection.
      setTimeout(() => {
        onRestart?.();
      }, 300);
      return { status: 'restarting', version: staged.version };
    } catch (err) {
      reply.code(409);
      return { error: err instanceof Error ? err.message : 'The update could not start.' };
    }
  });
}
