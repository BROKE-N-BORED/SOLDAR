// UI-side run types. The editor normalizes both live step events and stored
// step rows into StepData so the canvas and the run panel share one shape.

import type { Item, NodeOutput } from '@soldar/engine';

export type NodeStatus = 'idle' | 'running' | 'success' | 'error' | 'skipped';

export interface StepData {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  status: 'success' | 'error' | 'skipped';
  input: Item[];
  output: NodeOutput;
  error?: string;
  startedAt: number;
  finishedAt: number;
}

export interface RunState {
  status: 'idle' | 'running' | 'success' | 'error';
  executionId: string | null;
  steps: StepData[];
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
}

/** Data carried on each Vue Flow node. */
export interface SoldarNodeData extends Record<string, unknown> {
  label: string;
  displayName: string;
  inputs: number;
  outputs: string[];
  status: NodeStatus;
}

export function emptyRunState(): RunState {
  return {
    status: 'idle',
    executionId: null,
    steps: [],
    startedAt: null,
    finishedAt: null,
    error: null,
  };
}
