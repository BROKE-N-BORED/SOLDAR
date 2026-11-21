// The Soldar server: REST API, WebSocket run stream, and the built web app.
// Built by a factory so tests can spin one up against a scratch database
// with Fastify's inject (no port needed).

import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ENGINE_VERSION, type Storage, type WorkflowStore } from '@soldar/engine';
import { allNodes } from '@soldar/nodes';
import { RunService } from './run-service.js';
import { SchedulerService } from './scheduler.js';
import type { Logger } from './logger.js';
import type { RouteContext } from './routes/context.js';
import { registerWorkflowRoutes } from './routes/workflows.js';
import { registerExecutionRoutes } from './routes/executions.js';
import { registerNodeRoutes } from './routes/nodes.js';
import { registerDebugRoute } from './routes/debug.js';
import { registerUpdateRoutes } from './routes/update.js';
import { registerShutdownRoute } from './routes/shutdown.js';
import { registerWsRoute } from './routes/ws.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import type { UpdateService } from './update.js';

export interface AppOptions {
  storage: Storage & WorkflowStore;
  logger: Logger;
  logPath: string;
  /**
   * The self-update service. Only the real server passes one (index.ts);
   * without it the update routes answer 503.
   */
  update?: UpdateService;
  /**
   * Called (after the reply lands) when the user asks to restart into a
   * staged update. The real server shuts down gracefully; the updater
   * script does the rest.
   */
  onRestartRequested?: () => void;
  /**
   * Called (after the reply lands) when the user asks to stop the server
   * from the UI. Only the real server passes one; without it the shutdown
   * route answers 503.
   */
  onShutdownRequested?: () => void;
  /**
   * Directory holding the built web app (apps/web/dist). When it contains
   * an index.html, the server serves it. In development it is absent and
   * the Vite dev server serves the frontend instead.
   */
  webDistDir?: string;
}

export async function createApp(options: AppOptions): Promise<FastifyInstance & { runs: RunService; scheduler: SchedulerService }> {
  // pluginTimeout: Fastify's default is 10 s, which a cold start on a slow
  // PC (spinning disk, busy CPU) can genuinely exceed while a plugin is
  // still loading. 30 s is ample without hiding a real hang.
  const app = Fastify({ logger: false, pluginTimeout: 30000 }) as unknown as FastifyInstance & {
    runs: RunService;
    scheduler: SchedulerService;
  };
  // `runs` is attached on the next line, and the entry point uses it to
  // wait for runs to finish at shutdown.
  const runs = new RunService(options.storage, options.logger);
  app.runs = runs;
  const scheduler = new SchedulerService(options.storage, runs, options.logger);
  app.scheduler = scheduler;
  const ctx: RouteContext = {
    storage: options.storage,
    runs,
    scheduler,
    logger: options.logger,
    logPath: options.logPath,
    definitions: allNodes,
    update: options.update,
    onRestartRequested: options.onRestartRequested,
    onShutdownRequested: options.onShutdownRequested,
  };

  await app.register(websocket);

  // Nothing fails silently: a 500 writes its stack to the debug log, and
  // the client gets the same plain { error } shape the routes use.
  app.setErrorHandler((error, req, reply) => {
    const err = error as { statusCode?: unknown; message?: unknown; stack?: unknown };
    const status = typeof err.statusCode === 'number' ? err.statusCode : 500;
    const message = typeof err.message === 'string' ? err.message : 'Unknown error';
    if (status >= 500) {
      const stack = typeof err.stack === 'string' ? err.stack : '';
      // The query string stays out of the log: it can carry secrets.
      const path = req.url.split('?')[0];
      ctx.logger.error(`${req.method} ${path} -> ${status}: ${message}\n${stack}`);
    }
    reply.code(status).send({
      statusCode: status,
      error: status >= 500 ? 'Internal Server Error' : message,
    });
  });

  app.get('/api/health', async () => ({ status: 'ok', version: ENGINE_VERSION }));

  registerWorkflowRoutes(app, ctx);
  registerExecutionRoutes(app, ctx);
  registerNodeRoutes(app, ctx);
  registerDebugRoute(app, ctx);
  registerUpdateRoutes(app, ctx);
  registerShutdownRoute(app, ctx);
  registerWsRoute(app, ctx);
  registerWebhookRoutes(app, ctx);

  // Active workflows pick their schedules back up on every start, and
  // the cron timers stop when the server closes.
  scheduler.syncAll();
  app.addHook('onClose', async () => {
    scheduler.stopAll();
  });

  // Serve the built web app in production, with an SPA fallback: any GET
  // that is not an API or WebSocket path serves index.html.
  const indexHtml =
    options.webDistDir !== undefined
      ? join(options.webDistDir, 'index.html')
      : '';
  if (indexHtml !== '' && existsSync(indexHtml)) {
    await app.register(fastifyStatic, {
      root: options.webDistDir as string,
      wildcard: false,
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url === '/ws') {
        reply.code(404).send({ error: 'Not found.' });
        return;
      }
      reply.sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((_req, reply) => {
      reply.code(404).send({ error: 'Not found.' });
    });
  }

  return app;
}
