// Live run progress over WebSocket. The editor opens one socket and sends
// { type: 'subscribe', executionId }. The server answers with a snapshot
// (the execution record plus every step so far, read from the database),
// then streams live step events and a done event. Subscribing before
// reading the snapshot means no step can slip through the gap; events that
// arrive while the snapshot is being read are buffered and sent after it.
// The editor dedupes steps by node id, so a step that lands in both the
// snapshot and the live stream is shown once.

import type { FastifyInstance } from 'fastify';
import type { RunEvent } from '../run-service.js';
import type { RouteContext } from './context.js';

export function registerWsRoute(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/ws', { websocket: true }, (socket) => {
    let unsubscribe: (() => void) | null = null;

    socket.on('message', (raw: unknown) => {
      let message: unknown;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (message === null || typeof message !== 'object') return;
      const fields = message as Record<string, unknown>;
      if (fields.type !== 'subscribe' || typeof fields.executionId !== 'string') return;
      const executionId = fields.executionId;

      unsubscribe?.();
      const pending: RunEvent[] = [];
      let snapshotSent = false;
      unsubscribe = ctx.runs.subscribe(executionId, (event) => {
        if (snapshotSent) {
          socket.send(JSON.stringify(event));
        } else {
          pending.push(event);
        }
      });

      const execution = ctx.storage.getExecution(executionId);
      if (!execution) {
        socket.send(
          JSON.stringify({ type: 'error', executionId, message: 'Unknown execution.' }),
        );
        return;
      }
      const steps = ctx.storage.listSteps(executionId);
      socket.send(
        JSON.stringify({ type: 'snapshot', executionId, execution, steps }),
      );
      snapshotSent = true;
      for (const event of pending) socket.send(JSON.stringify(event));
      const donePending = pending.some((event) => event.type === 'done');
      if (execution.status !== 'running' && !donePending) {
        socket.send(JSON.stringify({ type: 'done', executionId, execution }));
      }
    });

    socket.on('close', () => unsubscribe?.());
    socket.on('error', () => unsubscribe?.());
  });
}
