// The Soldar server: REST API, WebSocket run stream, and the built web app.
// Built by a factory so tests can spin one up against a scratch database
// with Fastify's inject (no port needed).

import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ENGINE_VERSION, type Storage, type WorkflowStore } from '@soldar/engine';
import { RunService } from './run-service.js';
import type { Logger } from './logger.js';
import type { RouteContext } from './routes/context.js';
import { registerWorkflowRoutes } from './routes/workflows.js';
import { registerExecutionRoutes } from './routes/executions.js';
import { registerNodeRoutes } from './routes/nodes.js';
import { registerDebugRoute } from './routes/debug.js';
import { registerWsRoute } from './routes/ws.js';

export interface AppOptions {
  storage: Storage & WorkflowStore;
  logger: Logger;
  logPath: string;
  /**
   * Directory holding the built web app (apps/web/dist). When it contains
   * an index.html, the server serves it. In development it is absent and
   * the Vite dev server serves the frontend instead.
   */
  webDistDir?: string;
}

export async function createApp(options: AppOptions): Promise<FastifyInstance> {
  // pluginTimeout: Fastify's default is 10 s, which a cold start on a slow
  // PC (spinning disk, busy CPU) can genuinely exceed while a plugin is
  // still loading. 30 s is ample without hiding a real hang.
  const app = Fastify({ logger: false, pluginTimeout: 30000 });
  const runs = new RunService(options.storage);
  const ctx: RouteContext = {
    storage: options.storage,
    runs,
    logger: options.logger,
    logPath: options.logPath,
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
      ctx.logger.error(`${req.method} ${req.url} -> ${status}: ${message}\n${stack}`);
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
  registerWsRoute(app, ctx);

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
