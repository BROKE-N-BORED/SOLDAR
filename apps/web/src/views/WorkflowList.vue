<template>
  <div class="page">
    <div class="page-head">
      <h1 class="page-title">Workflows</h1>
      <div class="page-head-actions">
        <button
          class="btn btn-secondary"
          type="button"
          @click="importInput?.click()"
        >
          Import workflow
        </button>
        <input
          ref="importInput"
          type="file"
          accept=".json,application/json"
          class="visually-hidden"
          aria-label="Import a workflow file"
          @change="onImportFile"
        />
        <button
          v-if="!creating"
          class="btn btn-primary"
          type="button"
          @click="creating = true"
        >
          New workflow
        </button>
      </div>
    </div>

    <form v-if="creating" class="new-workflow" @submit.prevent="create">
      <label class="field-label" for="new-workflow-name">Name your workflow</label>
      <input
        id="new-workflow-name"
        ref="nameInput"
        v-model="newName"
        class="field-input"
        type="text"
        placeholder="Untitled workflow"
        autocomplete="off"
      />
      <p v-if="duplicateNameWarning" class="field-error" role="alert">
        {{ duplicateNameWarning }}
      </p>
      <div class="new-workflow-actions">
        <button class="btn btn-primary" type="submit" :disabled="creatingBusy">
          {{ creatingBusy ? 'Making it...' : 'Make it' }}
        </button>
        <button class="btn btn-secondary" type="button" @click="creating = false">
          Cancel
        </button>
      </div>
    </form>

    <p v-if="store.error" class="page-error" role="alert">
      {{ store.error }}
      <button class="btn btn-secondary btn-small" type="button" @click="reload">
        Try again
      </button>
    </p>
    <p v-if="importError" class="page-error" role="alert">{{ importError }}</p>

    <ul v-if="store.loading" class="workflow-list" aria-label="Loading workflows">
      <li v-for="i in 3" :key="i" class="workflow-row skeleton-row" aria-hidden="true">
        <span class="skeleton skeleton-name"></span>
        <span class="skeleton skeleton-meta"></span>
      </li>
    </ul>

    <div v-else-if="store.list.length === 0 && !store.error" class="empty-state">
      <p class="empty-state-title">No workflows yet.</p>
      <p class="empty-state-text">
        A workflow is a row of steps you run by pressing Run. Make one, drag
        some nodes onto the canvas, connect them, and press Run.
      </p>
      <button class="btn btn-primary" type="button" @click="creating = true">
        Make your first workflow
      </button>
    </div>

    <ul v-else class="workflow-list">
      <li
        v-for="workflow in store.list"
        :key="workflow.id"
        class="workflow-row"
        @click="open(workflow.id)"
      >
        <div class="workflow-row-main">
          <span class="workflow-row-name">{{ workflow.name }}</span>
          <span class="workflow-row-meta">
            {{ workflow.nodeCount }} {{ workflow.nodeCount === 1 ? 'node' : 'nodes' }}
            &middot; Updated {{ formatDate(workflow.updatedAt) }}
            <span v-if="lastRun(workflow.id)" class="workflow-row-run" :class="`run-${lastRun(workflow.id)!.status}`">
              Last run: {{ lastRun(workflow.id)!.status }} &middot; {{ formatDate(lastRun(workflow.id)!.startedAt) }}
            </span>
          </span>
        </div>
        <label
          class="workflow-row-active"
          title="Schedules arrive in a later version. For now, workflows only run when you press Run."
          @click.stop
        >
          <input
            type="checkbox"
            :checked="workflow.active"
            disabled
            @change="toggleActive(workflow.id, ($event.target as HTMLInputElement).checked)"
          />
          Active
        </label>
        <button
          class="btn btn-secondary btn-small"
          type="button"
          title="Make a copy of this workflow"
          @click.stop="duplicate(workflow.id)"
        >
          Duplicate
        </button>
        <button
          class="btn btn-secondary btn-small"
          type="button"
          title="Download this workflow as a file"
          @click.stop="exportWorkflow(workflow.id, workflow.name)"
        >
          Export
        </button>
        <button
          class="btn btn-icon"
          type="button"
          title="Delete this workflow"
          aria-label="Delete this workflow"
          @click.stop="askDelete(workflow.id, workflow.name)"
        >
          X
        </button>
      </li>
    </ul>

    <ConfirmDialog
      v-if="deleting"
      title="Delete this workflow?"
      :message="deleteMessage"
      confirm-label="Delete it"
      @confirm="confirmDelete"
      @cancel="deleting = null"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { Workflow } from '@soldar/engine';
import { useWorkflowsStore } from '../stores/workflows.js';
import { useExecutionsStore } from '../stores/executions.js';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import { api, type ExecutionRecord } from '../api.js';

const router = useRouter();
const store = useWorkflowsStore();
const executionsStore = useExecutionsStore();

const creating = ref(false);
const creatingBusy = ref(false);
const newName = ref('');
const nameInput = ref<HTMLInputElement | null>(null);
const importInput = ref<HTMLInputElement | null>(null);
const importError = ref('');
const deleting = ref<{ id: string; name: string } | null>(null);

const deleteMessage = computed(() =>
  deleting.value
    ? `"${deleting.value.name}" will be gone for good, and its past runs go with it.`
    : '',
);

// Two workflows may share a name; the list shows dates so they can be
// told apart, and creating one warns instead of blocking.
const duplicateNameWarning = computed(() => {
  const name = newName.value.trim();
  if (name === '') return '';
  const taken = store.list.some((w) => w.name.toLowerCase() === name.toLowerCase());
  return taken ? `A workflow called "${name}" already exists. The date below each one tells them apart.` : '';
});

function lastRun(workflowId: string): ExecutionRecord | undefined {
  return executionsStore.history.find((e) => e.workflowId === workflowId);
}

function formatDate(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

async function reload(): Promise<void> {
  await Promise.all([store.loadList(), executionsStore.loadHistory()]);
}

function open(id: string): void {
  void router.push({ name: 'editor', params: { id } });
}

async function create(): Promise<void> {
  creatingBusy.value = true;
  try {
    const id = await store.create(newName.value.trim() || undefined);
    newName.value = '';
    creating.value = false;
    await router.push({ name: 'editor', params: { id } });
  } catch (err) {
    store.error = err instanceof Error ? err.message : 'Could not make that workflow.';
  } finally {
    creatingBusy.value = false;
  }
}

async function duplicate(id: string): Promise<void> {
  try {
    await store.duplicate(id);
  } catch (err) {
    store.error = err instanceof Error ? err.message : 'Could not duplicate that workflow.';
  }
}

async function exportWorkflow(id: string, name: string): Promise<void> {
  try {
    const detail = await api.getWorkflow(id);
    const text = JSON.stringify(detail.workflow, null, 2);
    const safeName = name.replace(/[^A-Za-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '') || 'workflow';
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${safeName}.soldar.json`;
    link.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    store.error = err instanceof Error ? err.message : 'Could not export that workflow.';
  }
}

async function onImportFile(event: Event): Promise<void> {
  importError.value = '';
  const file = (event.target as HTMLInputElement).files?.[0];
  if (importInput.value) importInput.value.value = '';
  if (!file) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text()) as unknown;
  } catch {
    importError.value = 'That file is not valid JSON.';
    return;
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    typeof (parsed as Record<string, unknown>).name !== 'string' ||
    !Array.isArray((parsed as Record<string, unknown>).nodes) ||
    !Array.isArray((parsed as Record<string, unknown>).connections)
  ) {
    importError.value = 'That file does not look like a workflow. It needs a name, nodes, and connections.';
    return;
  }
  const imported = parsed as Workflow;
  // The shape is checked here; the graph itself (cycles, dangling wires,
  // duplicate names, unknown node types) is checked by the server on save,
  // which answers with a plain error the import shows as-is.
  const taken = new Set(store.list.map((w) => w.name.toLowerCase()));
  let name = imported.name.trim() === '' ? 'Imported workflow' : imported.name;
  if (taken.has(name.toLowerCase())) {
    let i = 2;
    while (taken.has(`${name} ${i}`.toLowerCase())) i++;
    name = `${name} ${i}`;
  }
  try {
    const id = await store.create(name);
    try {
      await api.saveWorkflow(id, { ...imported, id, name, active: false });
    } catch (err) {
      // Do not leave an empty workflow behind when the import fails.
      await api.deleteWorkflow(id).catch(() => undefined);
      throw err;
    }
    await store.loadList();
    await router.push({ name: 'editor', params: { id } });
  } catch (err) {
    importError.value = err instanceof Error ? err.message : 'Could not import that workflow.';
  }
}

async function toggleActive(id: string, active: boolean): Promise<void> {
  // The toggle is disabled until schedules exist (Phase 3); this stays as
  // the handler for when it is enabled again.
  try {
    await store.toggleActive(id, active);
  } catch (err) {
    store.error = err instanceof Error ? err.message : 'Could not change that.';
  }
}

function askDelete(id: string, name: string): void {
  deleting.value = { id, name };
}

async function confirmDelete(): Promise<void> {
  if (!deleting.value) return;
  const id = deleting.value.id;
  deleting.value = null;
  try {
    await store.remove(id);
  } catch (err) {
    store.error = err instanceof Error ? err.message : 'Could not delete that workflow.';
  }
}

onMounted(() => {
  void reload();
});

async function focusName(): Promise<void> {
  await nextTick();
  nameInput.value?.focus();
}

watch(creating, (value) => {
  if (value) void focusName();
});
</script>
