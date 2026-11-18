<template>
  <div class="page">
    <div class="page-head">
      <h1 class="page-title">Runs</h1>
      <label v-if="store.history.length > 0" class="runs-filter">
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

    <div v-else>
      <div class="runs-stats" aria-label="Run totals">
        <span>{{ stats.total }} {{ stats.total === 1 ? 'run' : 'runs' }}</span>
        <span class="run-success">{{ stats.success }} good</span>
        <span class="run-error">{{ stats.errors }} failed</span>
        <span v-if="stats.running > 0" class="run-running">{{ stats.running }} running</span>
        <span v-if="stats.averageMs !== null">Average {{ formatDuration(stats.averageMs) }}</span>
        <span v-if="stats.total > 0">{{ stats.successRate }}% good</span>
      </div>

      <div class="runs-layout" :class="{ 'no-detail': !store.detail }">
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
            <button
              class="btn btn-icon"
              type="button"
              title="Delete this run"
              aria-label="Delete this run"
              @click.stop="askDelete(run.id, run.workflowName)"
            >
              X
            </button>
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
            v-if="detailWorkflowExists"
            :to="{ name: 'editor', params: { id: store.detail.execution.workflowId } }"
            class="btn btn-secondary"
          >
            Open this workflow
          </RouterLink>
        </div>
      </div>

      <button
        v-if="store.hasMore"
        class="btn btn-secondary runs-more"
        type="button"
        :disabled="store.loading"
        @click="loadMore"
      >
        {{ store.loading ? 'Loading...' : 'Load more runs' }}
      </button>
    </div>

    <ConfirmDialog
      v-if="deleting"
      title="Delete this run?"
      :message="deleteMessage"
      confirm-label="Delete it"
      @confirm="confirmDelete"
      @cancel="deleting = null"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { useExecutionsStore } from '../stores/executions.js';
import { useWorkflowsStore } from '../stores/workflows.js';
import ExecutionPanel from '../components/ExecutionPanel.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import { stepFromRecord } from '../steps.js';
import { useTickingNow } from '../useNow.js';
import type { ExecutionRecord } from '../api.js';
import type { RunState } from '../types.js';

const store = useExecutionsStore();
const workflowsStore = useWorkflowsStore();
const filterWorkflowId = ref('');
const deleting = ref<{ id: string; name: string } | null>(null);

const deleteMessage = computed(() =>
  deleting.value
    ? `The run of "${deleting.value.name}" and what its nodes did will be gone for good.`
    : '',
);

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
  return {
    status: execution.status === 'running' ? 'running' : execution.status,
    executionId: execution.id,
    steps: steps.map(stepFromRecord),
    startedAt: execution.startedAt,
    finishedAt: execution.finishedAt,
    error: execution.error,
  };
});

// The "Open this workflow" link only makes sense while the workflow still
// exists; orphan runs (from before runs were deleted with their workflow)
// hide it instead of landing on an error page.
const detailWorkflowExists = computed(() => {
  if (!store.detail) return false;
  return workflowsStore.list.some(
    (w) => w.id === store.detail!.execution.workflowId,
  );
});

const stats = computed(() => {
  const total = store.history.length;
  const success = store.history.filter((r) => r.status === 'success').length;
  const errors = store.history.filter((r) => r.status === 'error').length;
  const running = store.history.filter((r) => r.status === 'running').length;
  const finished = store.history.filter((r) => r.finishedAt !== null);
  const averageMs =
    finished.length > 0
      ? Math.round(
          finished.reduce((sum, r) => sum + (r.finishedAt! - r.startedAt), 0) /
            finished.length,
        )
      : null;
  return {
    total,
    success,
    errors,
    running,
    averageMs,
    successRate: total > 0 ? Math.round((success / total) * 100) : 0,
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

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

// Running durations tick: the clock runs while anything in the list is
// still going, and stops when every run has landed.
const anyRunning = computed(
  () =>
    store.history.some((r) => r.status === 'running') ||
    store.detail?.execution.status === 'running',
);
const now = useTickingNow(anyRunning);

function runDuration(run: ExecutionRecord): string {
  const end = run.finishedAt ?? now.value;
  return formatDuration(end - run.startedAt);
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

async function loadMore(): Promise<void> {
  await store.loadMore(filterWorkflowId.value || undefined);
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
    store.error = err instanceof Error ? err.message : 'Could not delete that run.';
  }
}

// Auto-refresh while a run is going: the list and the open detail re-read
// every 2 seconds until nothing is running any more.
let refreshTimer: ReturnType<typeof setInterval> | null = null;

function stopRefreshing(): void {
  if (refreshTimer !== null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

function startRefreshing(): void {
  stopRefreshing();
  refreshTimer = setInterval(() => {
    void store.loadHistory(filterWorkflowId.value || undefined);
    if (store.detail) void store.loadDetail(store.detail.execution.id);
  }, 2000);
}

watch(anyRunning, (running) => {
  if (running) startRefreshing();
  else stopRefreshing();
});

onMounted(() => {
  void reload();
});

onUnmounted(() => {
  stopRefreshing();
});
</script>
