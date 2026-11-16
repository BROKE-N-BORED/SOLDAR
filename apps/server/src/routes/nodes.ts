// Node catalogue: the definitions the editor's palette and settings forms
// are built from. Only the serializable half of each definition goes over
// the wire — the execute function stays on the server.

import type { FastifyInstance } from 'fastify';
import { allNodes } from '@soldar/nodes';
import type { RouteContext } from './context.js';

export function registerNodeRoutes(app: FastifyInstance, _ctx: RouteContext): void {
  app.get('/api/nodes', async () => {
    return allNodes.map((node) => ({
      type: node.type,
      displayName: node.displayName,
      description: node.description,
      inputs: node.inputs,
      outputs: node.outputs,
      parameters: node.parameters,
    }));
  });
}
