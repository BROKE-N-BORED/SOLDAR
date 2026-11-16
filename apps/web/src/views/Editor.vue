<template>
  <div class="editor">
    <div v-if="loading" class="editor-loading">
      <p>Loading workflow...</p>
    </div>
    <div v-else-if="loadError" class="editor-error" role="alert">
      <p>{{ loadError }}</p>
      <RouterLink to="/" class="btn btn-secondary">Back to workflows</RouterLink>
    </div>
    <template v-else-if="workflow">
      <div class="editor-bar">
        <input
          v-model="nameDraft"
          class="editor-name"
          type="text"
          aria-label="Workflow name"
          @change="renameWorkflow"
        />
        <label class="editor-active">
          <input type="checkbox" :checked="workflow.active" @change="toggleActive" />
          Active
        </label>
        <span v-if="dirty" class="editor-dirty">Unsaved changes</span>
        <span v-if="saveError" class="editor-error-text" role="alert">{{ saveError }}</span>
        <span class="editor-bar-spacer"></span>
        <button
          class="btn btn-secondary"
          type="button"
          :disabled="!dirty || saving"
          @click="save"
        >
          {{ saving ? 'Saving...' : 'Save' }}
        </button>
        <button
          class="btn btn-primary"
          type="button"
          :disabled="runState.status === 'running' || workflow.nodes.length === 0"
          @click="run"
        >
          {{ runState.status === 'running' ? 'Running...' : 'Run' }}
        </button>
      </div>

      <div class="editor-body">
        <NodePalette :nodes="nodeList" @add-node="(type) => addNode(type)" />
        <div class="canvas-wrap">
          <VueFlow
            id="soldar-editor"
            :nodes="flowNodes"
            :edges="flowEdges"
            :node-types="nodeTypes"
            :delete-key-code="['Backspace', 'Delete']"
            @nodes-change="onNodesChange"
            @edges-change="onEdgesChange"
            @connect="onConnect"
            @drop="onDrop"
            @dragover="onDragOver"
          >
            <Background :variant="BackgroundVariant.Dots" :gap="24" :size="1.5" />
            <Controls position="bottom-right" />
          </VueFlow>
        </div>
        <div class="editor-side">
          <NodeSettings
            v-if="selectedNode && selectedInfo"
            :node="selectedNode"
            :info="selectedInfo"
            @update="(params) => updateNodeParams(selectedNode!.id, params)"
            @rename="(name) => renameNode(selectedNode!.id, name)"
            @remove="removeNode(selectedNode!.id)"
            @close="selectedNodeId = null"
          />
          <ExecutionPanel :run="runState" @select-step="selectNode" />
        </div>
      </div>
    </template>
    <ConfirmDialog
      v-if="leaving"
      title="Leave without saving?"
      message="You have unsaved changes. They will be lost if you leave now."
      confirm-label="Leave without saving"
      cancel-label="Keep editing"
      @confirm="resolveLeave(true)"
      @cancel="resolveLeave(false)"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, RouterLink } from 'vue-router';
import {
  VueFlow,
  useVueFlow,
  type NodeChange,
  type EdgeChange,
  type Connection,
} from '@vue-flow/core';
import { Background, BackgroundVariant } from '@vue-flow/background';
import { Controls } from '@vue-flow/controls';
import type { Workflow, WorkflowNode } from '@soldar/engine';
import { api, openRunSocket, type NodeInfo, type StepRecord } from '../api.js';
import { useWorkflowsStore } from '../stores/workflows.js';
import NodePalette from '../components/NodePalette.vue';
import NodeSettings from '../components/NodeSettings.vue';
import ExecutionPanel from '../components/ExecutionPanel.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import SoldarNode from '../components/SoldarNode.vue';
import {
  emptyRunState,
  type NodeStatus,
  type RunState,
  type SoldarNodeData,
  type StepData,
} from '../types.js';

const props = defineProps<{ id: string }>();

// Plain structural types for what we pass to the canvas. Vue Flow's own
// Node/Edge generics are deep recursive types (their `class`/`style`
// callbacks reference GraphNode, which references Node again), and
// instantiating them with our data type makes the checker give up with
// "excessively deep". These shapes carry everything the canvas reads,
// including the `selected` flag, which the plain Node/Edge types omit.
type FlowNode = {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: SoldarNodeData;
  selected?: boolean;
  width?: number | string;
  height?: number | string;
};
type FlowEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  selected?: boolean;
};

const workflowsStore = useWorkflowsStore();
const nodeTypes = { soldar: SoldarNode };
const { screenToFlowCoordinate, fitView } = useVueFlow('soldar-editor');

const loading = ref(true);
const loadError = ref('');
const workflow = ref<Workflow | null>(null);
const nameDraft = ref('');
const flowNodes = ref<FlowNode[]>([]);
const flowEdges = ref<FlowEdge[]>([]);
const dirty = ref(false);
const saving = ref(false);
const saveError = ref('');
// The unsaved-changes guard: leaving the editor with unsaved work asks
// first, both for in-app navigation (the router guard below) and for
// closing the tab or typing a new address (beforeunload). The dialog
// holds the navigation until the user picks.
const leaving = ref(false);
let leaveResolve: ((leave: boolean) => void) | null = null;

function resolveLeave(leave: boolean): void {
  leaving.value = false;
  const resolve = leaveResolve;
  leaveResolve = null;
  resolve?.(leave);
}

onBeforeRouteLeave(() => {
  if (!dirty.value) return true;
  return new Promise<boolean>((resolve) => {
    leaveResolve = resolve;
    leaving.value = true;
  });
});

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (!dirty.value) return;
  event.preventDefault();
  // The returnValue assignment is the older way of asking; harmless here
  // and still what some browsers look at.
  event.returnValue = '';
}
const selectedNodeId = ref<string | null>(null);
const runState = ref<RunState>(emptyRunState());

const nodeList = computed(() => workflowsStore.nodes);

const selectedNode = computed(
  () => workflow.value?.nodes.find((n) => n.id === selectedNodeId.value) ?? null,
);
const selectedInfo = computed(() =>
  selectedNode.value ? workflowsStore.nodeInfo(selectedNode.value.type) : undefined,
);

function nodeStatusOf(nodeId: string): NodeStatus {
  const step = runState.value.steps.find((s) => s.nodeId === nodeId);
  if (step) return step.status;
  if (runState.value.status !== 'running' || !workflow.value) return 'idle';
  // The run is on the first node whose inputs have all finished and which
  // has not finished itself yet.
  const finished = new Set(runState.value.steps.map((s) => s.nodeId));
  const inputsDone = (id: string): boolean =>
    workflow.value!.connections
      .filter((c) => c.to === id)
      .every((c) => finished.has(c.from));
  const current = workflow.value.nodes.find(
    (n) => !finished.has(n.id) && inputsDone(n.id),
  );
  return current?.id === nodeId ? 'running' : 'idle';
}

watch(
  () => runState.value.steps,
  () => {
    for (const node of flowNodes.value) {
      if (node.data) node.data.status = nodeStatusOf(node.id);
    }
  },
  { deep: true },
);

watch(
  () => runState.value.status,
  () => {
    for (const node of flowNodes.value) {
      if (node.data) node.data.status = nodeStatusOf(node.id);
    }
  },
);

function toFlowNode(node: WorkflowNode, info: NodeInfo | undefined): FlowNode {
  return {
    id: node.id,
    type: 'soldar',
    position: { x: node.position[0], y: node.position[1] },
    data: {
      label: node.name,
      displayName: info?.displayName ?? node.type,
      inputs: info?.inputs ?? 1,
      outputs: info?.outputs ?? ['main'],
      status: 'idle',
    },
  };
}

function syncFlowFromWorkflow(): void {
  if (!workflow.value) return;
  flowNodes.value = workflow.value.nodes.map((node) =>
    toFlowNode(node, workflowsStore.nodeInfo(node.type)),
  );
  flowEdges.value = workflow.value.connections.map((conn) => ({
    id: `e_${conn.from}_${conn.to}_${conn.output ?? 'main'}`,
    source: conn.from,
    target: conn.to,
    sourceHandle: conn.output ?? 'main',
  }));
}

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  runState.value = emptyRunState();
  selectedNodeId.value = null;
  try {
    await workflowsStore.loadNodes();
    const detail = await api.getWorkflow(props.id);
    workflow.value = detail.workflow;
    nameDraft.value = detail.workflow.name;
    dirty.value = false;
    syncFlowFromWorkflow();
  } catch (err) {
    loadError.value =
      err instanceof Error ? err.message : 'Could not load that workflow.';
  } finally {
    loading.value = false;
  }
}

// The canvas is controlled: every change it reports must be applied to our
// own arrays, or the node snaps back. The library's applyNodeChanges /
// applyEdgeChanges helpers are deprecated and typed for its internal
// GraphNode/GraphEdge, so we apply the few change kinds we care about by
// hand. ('add' changes never arrive: nodes and edges are pushed directly.)
function onNodesChange(changes: NodeChange[]): void {
  for (const change of changes) {
    // 'add' changes never arrive (nodes are pushed directly), and the add
    // change carries no `id` — skip it before touching change.id.
    if (change.type === 'add') continue;
    const flowNode = flowNodes.value.find((n) => n.id === change.id);
    if (change.type === 'position') {
      if (flowNode) flowNode.position = change.position;
      if (change.dragging === false && workflow.value && flowNode) {
        const node = workflow.value.nodes.find((n) => n.id === change.id);
        if (node) {
          node.position = [Math.round(flowNode.position.x), Math.round(flowNode.position.y)];
          dirty.value = true;
        }
      }
    } else if (change.type === 'select') {
      if (flowNode) flowNode.selected = change.selected;
      if (change.selected) {
        selectedNodeId.value = change.id;
      } else if (selectedNodeId.value === change.id) {
        selectedNodeId.value = null;
      }
    } else if (change.type === 'remove') {
      flowNodes.value = flowNodes.value.filter((n) => n.id !== change.id);
      removeNodeFromWorkflow(change.id);
    } else if (change.type === 'dimensions') {
      const dims = change.dimensions;
      if (flowNode && dims) {
        if (dims.width !== undefined) flowNode.width = dims.width;
        if (dims.height !== undefined) flowNode.height = dims.height;
      }
    }
  }
}

function onEdgesChange(changes: EdgeChange[]): void {
  for (const change of changes) {
    if (change.type === 'remove') {
      // Capture the edge before filtering it out of the list.
      const edge = flowEdges.value.find((e) => e.id === change.id);
      flowEdges.value = flowEdges.value.filter((e) => e.id !== change.id);
      if (edge && workflow.value) {
        const output = edge.sourceHandle ?? 'main';
        workflow.value.connections = workflow.value.connections.filter(
          (c) =>
            !(c.from === edge.source && c.to === edge.target && (c.output ?? 'main') === output),
        );
        dirty.value = true;
      }
    } else if (change.type === 'select') {
      const edge = flowEdges.value.find((e) => e.id === change.id);
      if (edge) edge.selected = change.selected;
    }
  }
}

function onConnect(connection: Connection): void {
  if (!workflow.value) return;
  if (!connection.source || !connection.target || connection.source === connection.target) return;
  const output = connection.sourceHandle ?? 'main';
  const exists = workflow.value.connections.some(
    (c) => c.from === connection.source && c.to === connection.target && (c.output ?? 'main') === output,
  );
  if (exists) return;
  workflow.value.connections.push({
    from: connection.source,
    to: connection.target,
    output,
  });
  flowEdges.value.push({
    id: `e_${connection.source}_${connection.target}_${output}`,
    source: connection.source,
    target: connection.target,
    sourceHandle: output,
  });
  dirty.value = true;
}

function onDragOver(event: DragEvent): void {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
}

function onDrop(event: DragEvent): void {
  event.preventDefault();
  const type = event.dataTransfer?.getData('application/soldar-node');
  if (!type) return;
  const position = screenToFlowCoordinate({ x: event.clientX, y: event.clientY });
  addNode(type, position);
}

function uniqueName(displayName: string): string {
  const taken = new Set(workflow.value?.nodes.map((n) => n.name) ?? []);
  if (!taken.has(displayName)) return displayName;
  let i = 2;
  while (taken.has(`${displayName} ${i}`)) i++;
  return `${displayName} ${i}`;
}

function defaultParameters(info: NodeInfo): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const param of info.parameters) {
    if (param.default !== undefined) {
      params[param.name] = JSON.parse(JSON.stringify(param.default)) as unknown;
    }
  }
  return params;
}

function addNode(type: string, position?: { x: number; y: number }): void {
  if (!workflow.value) return;
  const info = workflowsStore.nodeInfo(type);
  if (!info) return;
  let id = '';
  do {
    id = `n_${Math.random().toString(36).slice(2, 8)}`;
  } while (workflow.value.nodes.some((n) => n.id === id));
  const count = workflow.value.nodes.length;
  // Cascade across the canvas in a row, wide enough that nodes never overlap.
  const at = position ?? {
    x: 120 + (count % 3) * 280,
    y: 120 + Math.floor(count / 3) * 170,
  };
  const node: WorkflowNode = {
    id,
    type,
    name: uniqueName(info.displayName),
    position: [Math.round(at.x), Math.round(at.y)],
    parameters: defaultParameters(info),
  };
  workflow.value.nodes.push(node);
  flowNodes.value.push(toFlowNode(node, info));
  dirty.value = true;
  selectedNodeId.value = id;
}

function removeNodeFromWorkflow(id: string): void {
  if (!workflow.value) return;
  workflow.value.nodes = workflow.value.nodes.filter((n) => n.id !== id);
  workflow.value.connections = workflow.value.connections.filter(
    (c) => c.from !== id && c.to !== id,
  );
  flowEdges.value = flowEdges.value.filter((e) => e.source !== id && e.target !== id);
  if (selectedNodeId.value === id) selectedNodeId.value = null;
  dirty.value = true;
}

function removeNode(id: string): void {
  flowNodes.value = flowNodes.value.filter((n) => n.id !== id);
  removeNodeFromWorkflow(id);
}

function updateNodeParams(id: string, parameters: Record<string, unknown>): void {
  const node = workflow.value?.nodes.find((n) => n.id === id);
  if (!node) return;
  node.parameters = parameters;
  dirty.value = true;
}

function renameNode(id: string, name: string): void {
  const node = workflow.value?.nodes.find((n) => n.id === id);
  if (!node) return;
  node.name = name;
  const flowNode = flowNodes.value.find((n) => n.id === id);
  if (flowNode?.data) flowNode.data.label = name;
  dirty.value = true;
}

function selectNode(id: string): void {
  selectedNodeId.value = id;
  for (const node of flowNodes.value) {
    node.selected = node.id === id;
  }
}

function renameWorkflow(): void {
  if (!workflow.value) return;
  const name = nameDraft.value.trim();
  if (name === '') {
    nameDraft.value = workflow.value.name;
    return;
  }
  workflow.value.name = name;
  dirty.value = true;
}

async function toggleActive(event: Event): Promise<void> {
  if (!workflow.value) return;
  const active = (event.target as HTMLInputElement).checked;
  const previous = workflow.value.active;
  workflow.value.active = active;
  try {
    await api.setActive(workflow.value.id, active);
  } catch (err) {
    workflow.value.active = previous;
    saveError.value = err instanceof Error ? err.message : 'Could not change that.';
  }
}

async function save(): Promise<boolean> {
  if (!workflow.value) return false;
  saving.value = true;
  saveError.value = '';
  try {
    const detail = await api.saveWorkflow(workflow.value.id, workflow.value);
    workflow.value = detail.workflow;
    nameDraft.value = detail.workflow.name;
    dirty.value = false;
    return true;
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : 'Could not save.';
    return false;
  } finally {
    saving.value = false;
  }
}

let socket: WebSocket | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function closeSocket(): void {
  if (socket !== null) {
    socket.close();
    socket = null;
  }
}

function applyStepData(step: StepData): void {
  const existing = runState.value.steps.findIndex((s) => s.nodeId === step.nodeId);
  if (existing >= 0) {
    runState.value.steps[existing] = step;
  } else {
    runState.value.steps.push(step);
  }
}

function stepFromRecord(record: StepRecord): StepData {
  return {
    nodeId: record.nodeId,
    nodeName: record.nodeName,
    nodeType: record.nodeType,
    status: record.status,
    input: JSON.parse(record.inputJson) as StepData['input'],
    output: JSON.parse(record.outputJson) as StepData['output'],
    error: record.error ?? undefined,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
  };
}

function finishRun(status: 'success' | 'error', finishedAt: number, error: string | null): void {
  runState.value.status = status;
  runState.value.finishedAt = finishedAt;
  runState.value.error = error;
  stopPolling();
  closeSocket();
}

function startPolling(executionId: string): void {
  stopPolling();
  pollTimer = setInterval(() => {
    void api
      .getExecution(executionId)
      .then((detail) => {
        for (const record of detail.steps) applyStepData(stepFromRecord(record));
        if (detail.execution.status !== 'running') {
          finishRun(
            detail.execution.status,
            detail.execution.finishedAt ?? Date.now(),
            detail.execution.error,
          );
        }
      })
      .catch(() => {
        // Keep polling; the next round may get through.
      });
  }, 1000);
}

function subscribe(executionId: string): void {
  closeSocket();
  socket = openRunSocket();
  socket.addEventListener('open', () => {
    socket?.send(JSON.stringify({ type: 'subscribe', executionId }));
  });
  socket.addEventListener('message', (event) => {
    let message: unknown;
    try {
      message = JSON.parse(event.data as string);
    } catch {
      return;
    }
    if (message === null || typeof message !== 'object') return;
    const fields = message as Record<string, unknown>;
    if (fields.type === 'snapshot') {
      const steps = fields.steps as StepRecord[];
      for (const record of steps) applyStepData(stepFromRecord(record));
    } else if (fields.type === 'step') {
      const step = fields.step as StepData;
      applyStepData(step);
    } else if (fields.type === 'done') {
      const execution = fields.execution as { status: string; finishedAt: number | null; error: string | null };
      finishRun(
        execution.status === 'success' ? 'success' : 'error',
        execution.finishedAt ?? Date.now(),
        execution.error,
      );
    } else if (fields.type === 'error') {
      runState.value.error =
        typeof fields.message === 'string' ? fields.message : 'The run stream broke.';
      startPolling(executionId);
    }
  });
  socket.addEventListener('close', () => {
    // If the run is still going, fall back to polling so the run is not lost.
    if (runState.value.status === 'running') startPolling(executionId);
  });
  socket.addEventListener('error', () => {
    if (runState.value.status === 'running') startPolling(executionId);
  });
}

async function run(): Promise<void> {
  if (!workflow.value) return;
  if (dirty.value) {
    const saved = await save();
    if (!saved) return;
  }
  saveError.value = '';
  runState.value = {
    ...emptyRunState(),
    status: 'running',
    startedAt: Date.now(),
  };
  try {
    const { executionId } = await api.runWorkflow(workflow.value.id);
    runState.value.executionId = executionId;
    subscribe(executionId);
  } catch (err) {
    runState.value.status = 'error';
    runState.value.finishedAt = Date.now();
    runState.value.error = err instanceof Error ? err.message : 'The run could not start.';
  }
}

function onKeydown(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key === 's') {
    event.preventDefault();
    void save();
  }
}

watch(
  () => props.id,
  () => void load(),
);

onMounted(() => {
  void load().then(() => {
    // Fit the canvas to the loaded workflow once it is drawn. Only when
    // something was actually loaded, and only if nothing changed since
    // (fitting mid-edit would yank the canvas out from under the user).
    const loadedCount = flowNodes.value.length;
    if (loadedCount === 0) return;
    setTimeout(() => {
      if (flowNodes.value.length === loadedCount) fitView({ padding: 0.2 });
    }, 50);
  });
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('beforeunload', onBeforeUnload);
});

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('beforeunload', onBeforeUnload);
  stopPolling();
  closeSocket();
});
</script>
