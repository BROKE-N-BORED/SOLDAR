// Node registry — every built-in node, in one list. The runner and the
// CLI take this list; adding a node means adding its folder and one line here.

import type { NodeDefinition } from '@soldar/engine';
import { codeNode } from './code/definition.js';
import { httpNode } from './http/definition.js';
import { ifNode } from './if/definition.js';
import { manualTrigger } from './manual-trigger/definition.js';
import { setNode } from './set/definition.js';

export const allNodes: NodeDefinition[] = [
  manualTrigger,
  setNode,
  ifNode,
  codeNode,
  httpNode,
];

export function getNodeDefinition(type: string): NodeDefinition | undefined {
  return allNodes.find((node) => node.type === type);
}

export { codeNode, httpNode, ifNode, manualTrigger, setNode };
