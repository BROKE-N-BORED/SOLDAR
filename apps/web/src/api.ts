// The Soldar API client. Every call throws a plain Error with the server's
// message when something goes wrong, so the UI can show it as-is.

import type { ParameterSchema, Workflow } from '@soldar/engine';

export interface WorkflowSummary {
  id: string;
  name: string;
  active: boolean;
  nodeCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowDetail extends WorkflowSummary {
  workflow: Workflow;
}

export interface ExecutionRecord {
  id: string;
  workflowId: string;
  workflowName: string;
  status: 'running' | 'success' | 'error';
  trigger: string;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
}

export interface StepRecord {
  id: string;
  executionId: string;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  status: 'success' | 'error' | 'skipped';
  inputJson: string;
  outputJson: string;
  error: string | null;
  startedAt: number;
  finishedAt: number;
}

export interface NodeInfo {
  type: string;
  displayName: string;
  description: string;
  inputs: number;
  outputs: string[];
  parameters: ParameterSchema[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  if (res.status === 204) return undefined as T;
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      body !== null &&
      typeof body === 'object' &&
      typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `Request failed (${res.status}).`;
    throw new Error(message);
  }
  return body as T;
}

export const api = {
  health: () => request<{ status: string; version: string }>('/api/health'),
  listWorkflows: () => request<WorkflowSummary[]>('/api/workflows'),
  createWorkflow: (name?: string) =>
    request<WorkflowDetail>('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  getWorkflow: (id: string) => request<WorkflowDetail>(`/api/workflows/${id}`),
  saveWorkflow: (id: string, workflow: Workflow) =>
    request<WorkflowDetail>(`/api/workflows/${id}`, {
      method: 'PUT',
      body: JSON.stringify(workflow),
    }),
  setActive: (id: string, active: boolean) =>
    request<WorkflowSummary>(`/api/workflows/${id}/active`, {
      method: 'PATCH',
      body: JSON.stringify({ active }),
    }),
  deleteWorkflow: (id: string) =>
    request<void>(`/api/workflows/${id}`, { method: 'DELETE' }),
  runWorkflow: (id: string) =>
    request<{ executionId: string }>(`/api/workflows/${id}/run`, {
      method: 'POST',
      body: '{}',
    }),
  listNodes: () => request<NodeInfo[]>('/api/nodes'),
  listExecutions: (workflowId?: string) =>
    request<ExecutionRecord[]>(
      `/api/executions${workflowId ? `?workflowId=${encodeURIComponent(workflowId)}` : ''}`,
    ),
  getExecution: (id: string) =>
    request<{ execution: ExecutionRecord; steps: StepRecord[] }>(
      `/api/executions/${id}`,
    ),
};

/** Open a WebSocket to the run stream. Same host as the page, so it works
 *  both through the Vite dev proxy and against the production server. */
export function openRunSocket(): WebSocket {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return new WebSocket(`${protocol}//${window.location.host}/ws`);
}
