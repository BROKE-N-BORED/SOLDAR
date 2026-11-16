<template>
  <div class="page">
    <div class="page-head">
      <h1 class="page-title">Runs</h1>
      <label class="runs-filter">
        <span class="runs-filter-label">Workflow</span>
        <select
          class="field-input"
          :value="filterWorkflowId"
          @change="onFilterChange(($event.target as HTMLSelectElement).value)"
        >
          <option value="">All workflows</option>
          <option
            v-for="workflow in workflowsStore.list"
            :key="workflow.id"
            :value="workflow.id"
          >
            {{ workflow.name }}
          </option>
        </select>
      </label>
    </div>

    <p v-if="store.error" class="page-error" role="alert">
      {{ store.error }}
      <button class="btn btn-secondary btn-small" type="button" @click="reload">
        Try again
      </button>
    </p>

    <div v-if="store.loading && store.history.length === 0" class="runs-loading">
      <p>Loading runs...</p>
    </div>

    <div
      v-else-if="store.history.length === 0 && !store.error"
      class="empty-state"
    >
      <p class="empty-state-title">No runs yet.</p>
      <p class="empty-state-text">
        Runs show up here after you press Run in a workflow. Each one keeps
        what every node did, so you can see where it went right or wrong.
      </p>
      <RouterLink to="/" class="btn btn-primary">Go to workflows</RouterLink>
    </div>

    <div v-else class="runs-layout">
      <ul class="runs-list">
        <li
          v-for="run in store.history"
          :key="run.id"
          class="runs-row"
          :class="{ selected: store.detail?.execution.id === run.id }"
          @click="select(run.id)"
        >
          <span class="runs-row-dot" :class="`dot-${run.status}`" aria-hidden="true"></span>
          <span class="runs-row-main">
            <span class="runs-row-name">{{ run.workflowName }}</span>
            <span class="runs-row-meta">
              {{ formatTime(run.startedAt) }} &middot; {{ run.trigger }} &middot;
              {{ runDuration(run) }}
            </span>
          </span>
          <span class="runs-row-status" :class="`run-${run.status}`">{{ run.status }}</span>
        </li>
      </ul>

      <div v-if="store.detail" class="runs-detail">
        <ExecutionPanel
          :run="detailAsRun"
          @select-step="() => undefined"
        />
        <p v-if="store.detail.execution.error" class="run-panel-error" role="alert">
          {{ store.detail.execution.error }}
        </p>
        <RouterLink
          :to="{ name: 'editor', params: { id: store.detail.execution.workflowId } }"
          class="btn btn-secondary"
        >
          Open this workflow
        </RouterLink>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { useExecutionsStore } from '../stores/executions.js';
import { useWorkflowsStore } from '../stores/workflows.js';
import ExecutionPanel from '../components/ExecutionPanel.vue';
import type { ExecutionRecord, StepRecord } from '../api.js';
import type { RunState, StepData } from '../types.js';

const store = useExecutionsStore();
const workflowsStore = useWorkflowsStore();
const filterWorkflowId = ref('');

const detailAsRun = computed<RunState>(() => {
  if (!store.detail) {
    return {
      status: 'idle',
      executionId: null,
      steps: [],
      startedAt: null,
      finishedAt: null,
      error: null,
    };
  }
  const { execution, steps } = store.detail;
  const mapped: StepData[] = steps.map((record: StepRecord) => ({
    nodeId: record.nodeId,
    nodeName: record.nodeName,
    nodeType: record.nodeType,
    status: record.status,
    input: JSON.parse(record.inputJson) as StepData['input'],
    output: JSON.parse(record.outputJson) as StepData['output'],
    error: record.error ?? undefined,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
  }));
  return {
    status: execution.status === 'running' ? 'running' : execution.status,
    executionId: execution.id,
    steps: mapped,
    startedAt: execution.startedAt,
    finishedAt: execution.finishedAt,
    error: execution.error,
  };
});

function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function runDuration(run: ExecutionRecord): string {
  const end = run.finishedAt ?? Date.now();
  const ms = end - run.startedAt;
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

async function reload(): Promise<void> {
  await Promise.all([
    store.loadHistory(filterWorkflowId.value || undefined),
    workflowsStore.loadList(),
  ]);
}

async function onFilterChange(value: string): Promise<void> {
  filterWorkflowId.value = value;
  store.detail = null;
  await store.loadHistory(value || undefined);
}

async function select(id: string): Promise<void> {
  await store.loadDetail(id);
}

onMounted(() => {
  void reload();
});
</script>
