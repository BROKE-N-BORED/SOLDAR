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
  /** The node's icon, as inline SVG markup (served by the API). */
  icon?: string;
}

export interface UpdateStatus {
  current: string;
  state: 'newer' | 'current' | 'unknown' | 'checking';
  latest: string | null;
  url: string | null;
  // True when the update can be pulled: a newer release with a zip asset
  // AND a published checksum. A newer release with no checksum is never
  // installed automatically.
  installable: boolean;
  reason?: string;
  stagedVersion: string | null;
  checking: boolean;
  downloading: boolean;
}

/**
 * One API call. Times out after `timeoutMs` (default 30 s) so a hung
 * request never leaves a button stuck on "Saving..." forever. The caller
 * can pass a longer timeout for calls that legitimately take a while
 * (an update download).
 */
async function request<T>(
  path: string,
  init?: RequestInit,
  timeoutMs = 30000,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  // Only declare a JSON body when there is one: Fastify rejects a
  // request that says application/json but sends no body, which broke
  // both DELETE calls (they carry no body).
  const headers: Record<string, string> =
    init?.body !== undefined ? { 'content-type': 'application/json' } : {};
  try {
    res = await fetch(path, {
      headers,
      signal: controller.signal,
      ...init,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('The server took too long to answer. Try again.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
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
  saveWorkflow: (id: string, workflow: Workflow, expectedUpdatedAt?: number) =>
    request<WorkflowDetail>(`/api/workflows/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ ...workflow, expectedUpdatedAt }),
    }),
  duplicateWorkflow: (id: string) =>
    request<WorkflowDetail>(`/api/workflows/${id}/duplicate`, {
      method: 'POST',
      body: '{}',
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
  runNode: (id: string, nodeId: string) =>
    request<{ executionId: string }>(`/api/workflows/${id}/run-node`, {
      method: 'POST',
      body: JSON.stringify({ nodeId }),
    }),
  listNodes: () => request<NodeInfo[]>('/api/nodes'),
  listExecutions: (workflowId?: string, limit?: number, offset?: number) => {
    const params = new URLSearchParams();
    if (workflowId) params.set('workflowId', workflowId);
    if (limit !== undefined) params.set('limit', String(limit));
    if (offset !== undefined) params.set('offset', String(offset));
    const query = params.toString();
    return request<ExecutionRecord[]>(`/api/executions${query ? `?${query}` : ''}`);
  },
  getExecution: (id: string) =>
    request<{ execution: ExecutionRecord; steps: StepRecord[] }>(
      `/api/executions/${id}`,
    ),
  deleteExecution: (id: string) =>
    request<void>(`/api/executions/${id}`, { method: 'DELETE' }),
  cancelExecution: (id: string) =>
    request<{ cancelled: boolean }>(`/api/executions/${id}/cancel`, {
      method: 'POST',
      body: '{}',
    }),
  shutdownServer: () =>
    request<{ ok: boolean }>('/api/shutdown', { method: 'POST', body: '{}' }),
  getUpdateStatus: () => request<UpdateStatus>('/api/update/status'),
  checkForUpdate: () =>
    request<UpdateStatus>('/api/update/check', { method: 'POST', body: '{}' }),
  downloadUpdate: () =>
    // A download can legitimately take minutes on a slow connection.
    request<UpdateStatus>('/api/update/download', { method: 'POST', body: '{}' }, 300000),
  restartForUpdate: () =>
    request<{ status: string; version: string }>('/api/update/restart', {
      method: 'POST',
      body: '{}',
    }),
};

/** Open a WebSocket to the run stream. Same host as the page, so it works
 *  both through the Vite dev proxy and against the production server. */
export function openRunSocket(): WebSocket {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return new WebSocket(`${protocol}//${window.location.host}/ws`);
}
