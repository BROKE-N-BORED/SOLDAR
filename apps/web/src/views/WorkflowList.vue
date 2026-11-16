<template>
  <div class="page">
    <div class="page-head">
      <h1 class="page-title">Workflows</h1>
      <button
        v-if="!creating"
        class="btn btn-primary"
        type="button"
        @click="creating = true"
      >
        New workflow
      </button>
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

    <ul v-if="store.loading" class="workflow-list" aria-label="Loading workflows">
      <li v-for="i in 3" :key="i" class="workflow-row skeleton-row" aria-hidden="true">
        <span class="skeleton skeleton-name"></span>
        <span class="skeleton skeleton-meta"></span>
      </li>
    </ul>

    <div v-else-if="store.list.length === 0 && !store.error" class="empty-state">
      <p class="empty-state-title">No workflows yet.</p>
      <p class="empty-state-text">
        A workflow is a row of steps that run on their own. Make one, drag
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
            <span v-if="lastRun(workflow.id)" class="workflow-row-run" :class="`run-${lastRun(workflow.id)!.status}`">
              Last run: {{ lastRun(workflow.id)!.status }}
            </span>
          </span>
        </div>
        <label class="workflow-row-active" @click.stop>
          <input
            type="checkbox"
            :checked="workflow.active"
            @change="toggleActive(workflow.id, ($event.target as HTMLInputElement).checked)"
          />
          Active
        </label>
        <button
          class="btn btn-icon"
          type="button"
          title="Delete this workflow"
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
import { useWorkflowsStore } from '../stores/workflows.js';
import { useExecutionsStore } from '../stores/executions.js';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import type { ExecutionRecord } from '../api.js';

const router = useRouter();
const store = useWorkflowsStore();
const executionsStore = useExecutionsStore();

const creating = ref(false);
const creatingBusy = ref(false);
const newName = ref('');
const nameInput = ref<HTMLInputElement | null>(null);
const deleting = ref<{ id: string; name: string } | null>(null);

const deleteMessage = computed(() =>
  deleting.value
    ? `"${deleting.value.name}" will be gone for good. Its past runs stay in the Runs list.`
    : '',
);

function lastRun(workflowId: string): ExecutionRecord | undefined {
  return executionsStore.history.find((e) => e.workflowId === workflowId);
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

async function toggleActive(id: string, active: boolean): Promise<void> {
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
