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
        <label class="editor-active" title="When Active is on, this workflow runs on its schedules and answers its webhooks. When it is off, it only runs when you press Run.">
          <input
            type="checkbox"
            :checked="workflow.active"
            @change="toggleActive"
          />
          Active
        </label>
        <span v-if="dirty" class="editor-dirty">Unsaved changes</span>
        <span v-if="saveError" class="editor-error-text" role="alert">{{ saveError }}</span>
        <button
          v-if="staleSave"
          class="btn btn-secondary btn-small"
          type="button"
          @click="askReload"
        >
          Reload workflow
        </button>
        <span v-if="!settingsValid" class="editor-error-text">
          Fix the settings errors before saving or running.
        </span>
        <span class="editor-bar-spacer"></span>
        <button
          class="btn btn-secondary"
          type="button"
          :disabled="!dirty || saving || !settingsValid"
          @click="save"
        >
          {{ saving ? 'Saving...' : 'Save' }}
        </button>
        <button
          v-if="runState.status === 'running'"
          class="btn btn-danger"
          type="button"
          @click="stopRun"
        >
          Stop
        </button>
        <button
          v-else
          class="btn btn-primary"
          type="button"
          :disabled="workflow.nodes.length === 0 || !settingsValid"
          @click="run"
        >
          Run
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
            @nodes-change="onNodesChange"
            @edges-change="onEdgesChange"
            @connect="onConnect"
            @nodes-initialized="onNodesInitialized"
            @drop="onDrop"
            @dragover="onDragOver"
          >
            <Background :variant="BackgroundVariant.Dots" :gap="24" :size="1.5" />
            <Controls position="bottom-right" />
          </VueFlow>
        </div>
        <div class="editor-side">
          <section class="workflow-settings" aria-label="Workflow settings">
            <button
              class="workflow-settings-toggle"
              type="button"
              :aria-expanded="settingsOpen"
              @click="settingsOpen = !settingsOpen"
            >
              <span
                class="workflow-settings-chevron"
                :class="{ open: settingsOpen }"
                aria-hidden="true"
              ></span>
              Workflow settings
            </button>
            <div v-if="settingsOpen" class="workflow-settings-body">
              <label class="field-toggle">
                <input
                  type="checkbox"
                  :checked="workflow.settings?.allowPrivateAddresses === true"
                  @change="togglePrivateAddresses(($event.target as HTMLInputElement).checked)"
                />
                <span class="toggle-track" aria-hidden="true"></span>
                <span class="toggle-label">Allow HTTP calls to private addresses</span>
              </label>
              <p class="field-help">
                Normally the HTTP node refuses localhost and private network
                addresses. Turn this on only for a workflow that genuinely
                needs to call a service on your own network.
              </p>
            </div>
          </section>
          <NodeSettings
            v-if="selectedNode && selectedInfo"
            :node="selectedNode"
            :info="selectedInfo"
            :sibling-names="siblingNames"
            :running="runState.status === 'running'"
            @update="(params) => updateNodeParams(selectedNode!.id, params)"
            @rename="(name) => renameNode(selectedNode!.id, name)"
            @remove="askDeleteNode(selectedNode!.id)"
            @close="selectedNodeId = null"
            @validity="(valid) => (settingsValid = valid)"
            @run-node="runNode(selectedNode!.id)"
          />
          <div ref="runPanelWrap" class="editor-run-wrap">
            <ExecutionPanel :run="runState" @select-step="selectNode" />
          </div>
        </div>
      </div>
    </template>
    <ConfirmDialog
      v-if="leaving"
      title="Leave without saving?"
      message="You have unsaved changes. They will be lost if you leave now."
      confirm-label="Leave without saving"
      cancel-label="Keep editing"
      extra-label="Save and leave"
      @confirm="resolveLeave(true)"
      @cancel="resolveLeave(false)"
      @extra="saveAndLeave"
    />
    <ConfirmDialog
      v-if="deletingNode"
      title="Delete this node?"
      :message="deleteNodeMessage"
      confirm-label="Delete it"
      cancel-label="Keep it"
      @confirm="confirmDeleteNode"
      @cancel="deletingNode = null"
    />
    <ConfirmDialog
      v-if="reloading"
      title="Reload this workflow?"
      message="Your unsaved changes will be lost, and the copy from the other tab will be shown."
      confirm-label="Reload it"
      cancel-label="Keep editing"
      @confirm="confirmReload"
      @cancel="reloading = false"
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
import { stepFromRecord } from '../steps.js';
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
// The updatedAt of the copy this editor loaded, sent back on save so the
// server can refuse when another tab saved first (optimistic concurrency).
const loadedUpdatedAt = ref(0);
// True after a save was refused as stale: the bar offers a reload.
const staleSave = ref(false);
// False while the selected node's settings have an error that would fail
// a save or a run (bad JSON, an empty required field, a duplicate name).
const settingsValid = ref(true);
const settingsOpen = ref(false);
// The node awaiting delete confirmation, and the reload confirmation.
const deletingNode = ref<{ id: string; name: string } | null>(null);
const reloading = ref(false);
const runPanelWrap = ref<HTMLElement | null>(null);
let fitted = false;
// Nodes the user added this session (palette click or drag). The
// fit-on-load below must not fire for those: refitting after every add
// would yank the canvas under their cursor (and can slide a handle under
// the settings panel mid-drag).
let nodesAddedByUser = 0;
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
// Names of the other nodes, for the duplicate-name warning in settings.
const siblingNames = computed(() =>
  (workflow.value?.nodes ?? [])
    .filter((n) => n.id !== selectedNodeId.value)
    .map((n) => n.name),
);
const deleteNodeMessage = computed(() =>
  deletingNode.value
    ? `"${deletingNode.value.name}" and its wires will be gone. Save afterwards to keep the change.`
    : '',
);

// With no node selected there is no settings form to be invalid.
watch(selectedNodeId, (id) => {
  if (id === null) settingsValid.value = true;
});

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
  // A node without a valid position (allowed by validation, e.g. after an
  // import) gets a cascaded default instead of throwing.
  const position =
    Array.isArray(node.position) &&
    node.position.length === 2 &&
    node.position.every((n) => typeof n === 'number' && Number.isFinite(n))
      ? node.position
      : [120, 120];
  return {
    id: node.id,
    type: 'soldar',
    position: { x: position[0], y: position[1] },
    data: {
      label: node.name,
      displayName: info?.displayName ?? node.type,
      inputs: info?.inputs ?? 1,
      outputs: info?.outputs ?? ['main'],
      status: 'idle',
      icon: info?.icon,
    },
  };
}

function syncFlowFromWorkflow(): void {
  if (!workflow.value) return;
  // Default missing positions on the workflow itself, cascaded so the
  // nodes never overlap. Not marked dirty: the defaults are saved with
  // the next save, and loading alone should not dirty the workflow.
  workflow.value.nodes.forEach((node, index) => {
    if (
      !Array.isArray(node.position) ||
      node.position.length !== 2 ||
      !node.position.every((n) => typeof n === 'number' && Number.isFinite(n))
    ) {
      node.position = [60 + (index % 3) * 240, 100 + Math.floor(index / 3) * 170];
    }
  });
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
  fitted = false;
  nodesAddedByUser = 0;
  try {
    await workflowsStore.loadNodes();
    const detail = await api.getWorkflow(props.id);
    workflow.value = detail.workflow;
    nameDraft.value = detail.workflow.name;
    loadedUpdatedAt.value = detail.updatedAt;
    staleSave.value = false;
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
      // The drag-end change (dragging: false) carries no position at all:
      // the library only flags that the drag stopped. Assigning it would
      // wipe the node's position to undefined, and the sync below would
      // crash reading .x off it (the console TypeError seen while
      // dragging). Only a change that carries a position moves the node;
      // at drag end the node still holds its last dragged position.
      if (flowNode && change.position) flowNode.position = change.position;
      if (change.dragging === false && workflow.value && flowNode?.position) {
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
  // Cascade across the canvas in a row, wide enough that nodes never
  // overlap, and kept left so the third node in a row stays clear of the
  // settings sidebar at ordinary window widths.
  const at = position ?? {
    x: 60 + (count % 3) * 240,
    y: 100 + Math.floor(count / 3) * 170,
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
  nodesAddedByUser += 1;
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

// Deleting a node is one keypress and irreversible except by not saving,
// so both the Delete key and the Remove button ask first.
function askDeleteNode(id: string): void {
  const node = workflow.value?.nodes.find((n) => n.id === id);
  if (!node) return;
  deletingNode.value = { id: node.id, name: node.name };
}

function confirmDeleteNode(): void {
  if (!deletingNode.value) return;
  const id = deletingNode.value.id;
  deletingNode.value = null;
  removeNode(id);
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

function togglePrivateAddresses(allowed: boolean): void {
  if (!workflow.value) return;
  workflow.value.settings = { ...workflow.value.settings, allowPrivateAddresses: allowed };
  dirty.value = true;
}

async function save(): Promise<boolean> {
  if (!workflow.value) return false;
  saving.value = true;
  saveError.value = '';
  staleSave.value = false;
  try {
    const detail = await api.saveWorkflow(
      workflow.value.id,
      workflow.value,
      loadedUpdatedAt.value,
    );
    workflow.value = detail.workflow;
    nameDraft.value = detail.workflow.name;
    loadedUpdatedAt.value = detail.updatedAt;
    dirty.value = false;
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Could not save.';
    saveError.value = message;
    // A stale-copy refusal (409) offers a reload instead of a dead end.
    if (message.includes('changed in another tab')) staleSave.value = true;
    return false;
  } finally {
    saving.value = false;
  }
}

async function saveAndLeave(): Promise<void> {
  const saved = await save();
  resolveLeave(saved);
}

function askReload(): void {
  reloading.value = true;
}

function confirmReload(): void {
  reloading.value = false;
  void load();
}

let socket: WebSocket | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

function stopPolling(): void {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
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

function finishRun(status: 'success' | 'error', finishedAt: number, error: string | null): void {
  runState.value.status = status;
  runState.value.finishedAt = finishedAt;
  runState.value.error = error;
  stopPolling();
  closeSocket();
  // Bring the run panel into view: after a run the results sit under the
  // settings panel, below the fold at most heights. `nearest` only
  // scrolls when the panel is actually out of view.
  runPanelWrap.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function startPolling(executionId: string): void {
  stopPolling();
  // Back off instead of fetching the full execution every second forever:
  // 1 s, 2 s, 4 s, then 8 s. A long run with big step data stays light.
  let delay = 1000;
  const poll = (): void => {
    pollTimer = setTimeout(() => {
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
          } else {
            delay = Math.min(delay * 2, 8000);
            poll();
          }
        })
        .catch(() => {
          // Keep polling; the next round may get through.
          delay = Math.min(delay * 2, 8000);
          poll();
        });
    }, delay);
  };
  poll();
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

// Run just one node, alone, with one empty item — for debugging that node
// without running the whole workflow.
async function runNode(nodeId: string): Promise<void> {
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
    singleNode: true,
  };
  try {
    const { executionId } = await api.runNode(workflow.value.id, nodeId);
    runState.value.executionId = executionId;
    subscribe(executionId);
  } catch (err) {
    runState.value.status = 'error';
    runState.value.finishedAt = Date.now();
    runState.value.error = err instanceof Error ? err.message : 'The run could not start.';
  }
}

async function stopRun(): Promise<void> {
  const executionId = runState.value.executionId;
  if (!executionId) return;
  try {
    await api.cancelExecution(executionId);
  } catch (err) {
    // The run may have finished between the click and the call; the done
    // event (or the poll) will settle the panel either way.
    saveError.value = err instanceof Error ? err.message : 'Could not stop that run.';
  }
}

function onKeydown(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key === 's') {
    event.preventDefault();
    void save();
    return;
  }
  // Delete/Backspace removes the selected node — with a confirm first.
  // Vue Flow's own delete-key handling is off, so this is the only path.
  // Never fire while typing in a field.
  if (event.key !== 'Delete' && event.key !== 'Backspace') return;
  const target = event.target as HTMLElement | null;
  if (
    target &&
    (target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT' ||
      target.isContentEditable)
  ) {
    return;
  }
  if (selectedNodeId.value) {
    event.preventDefault();
    askDeleteNode(selectedNodeId.value);
  }
}

// Fit the canvas once the loaded nodes have their real dimensions — the
// nodes-initialized event, not a setTimeout, so slow machines fit too.
// Only for a load: nodes the user adds must never trigger a refit.
function onNodesInitialized(): void {
  if (fitted || flowNodes.value.length === 0 || nodesAddedByUser > 0) return;
  fitted = true;
  fitView({ padding: 0.2 });
}

watch(
  () => props.id,
  () => void load(),
);

onMounted(() => {
  void load();
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
