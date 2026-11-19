<template>
  <section class="run-panel" aria-label="Run">
    <div class="run-panel-head">
      <h2 class="run-panel-title">Run</h2>
      <span class="run-panel-status" :class="`run-${run.status}`">
        {{ statusText }}
      </span>
      <button
        class="btn btn-icon"
        type="button"
        :title="collapsed ? 'Expand run panel' : 'Collapse run panel'"
        :aria-label="collapsed ? 'Expand run panel' : 'Collapse run panel'"
        @click="collapsed = !collapsed"
      >
        {{ collapsed ? '+' : '-' }}
      </button>
    </div>

    <template v-if="!collapsed">
    <p v-if="run.status === 'idle'" class="run-panel-empty">
      Press Run to run this workflow. Each node lights up as it finishes, and
      you can click a node here to see the data that passed through it.
    </p>

    <template v-else>
      <p v-if="run.error" class="run-panel-error" role="alert">{{ run.error }}</p>
      <p
        v-if="run.singleNode && (run.status === 'success' || run.status === 'error')"
        class="run-panel-note"
      >
        This run covered just the one node. It ran on its own with one
        empty item, not on data from the nodes before it, so the result
        can differ from a full run.
      </p>
      <p v-if="durationText" class="run-panel-duration">{{ durationText }}</p>
      <ul class="run-steps">
        <li
          v-for="step in run.steps"
          :key="step.nodeId"
          class="run-step"
          :class="{ open: expandedNodeId === step.nodeId }"
        >
          <button
            class="run-step-head"
            type="button"
            :aria-expanded="expandedNodeId === step.nodeId"
            @click="toggleStep(step.nodeId)"
          >
            <span class="run-step-dot" :class="`dot-${step.status}`" aria-hidden="true"></span>
            <span class="run-step-name">{{ step.nodeName }}</span>
            <span class="run-step-time">{{ stepDuration(step) }}</span>
          </button>
          <div v-if="expandedNodeId === step.nodeId" class="run-step-data">
            <p v-if="step.error" class="run-panel-error" role="alert">{{ step.error }}</p>
            <h3 class="run-data-title">In</h3>
            <pre class="run-data">{{ pretty(step.input) }}</pre>
            <h3 class="run-data-title">Out</h3>
            <pre class="run-data">{{ pretty(step.output) }}</pre>
          </div>
        </li>
      </ul>
    </template>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { RunState, StepData } from '../types.js';
import { useTickingNow } from '../useNow.js';

const props = defineProps<{
  run: RunState;
}>();

const emit = defineEmits<{
  (event: 'select-step', nodeId: string): void;
}>();

const expandedNodeId = ref<string | null>(null);
const collapsed = ref(false);

// The clock ticks only while the run is going, so the duration moves
// instead of freezing at the moment the run started.
const isRunning = computed(() => props.run.status === 'running');
const now = useTickingNow(isRunning);

const statusText = computed(() => {
  switch (props.run.status) {
    case 'running': {
      const done = props.run.steps.length;
      return done > 0 ? `Running, ${done} done so far` : 'Running';
    }
    case 'success':
      return 'Finished, all good';
    case 'error':
      return 'Finished, with an error';
    default:
      return 'Not run yet';
  }
});

const durationText = computed(() => {
  if (props.run.startedAt === null) return '';
  const end = props.run.finishedAt ?? now.value;
  const ms = end - props.run.startedAt;
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
});

function stepDuration(step: StepData): string {
  const ms = step.finishedAt - step.startedAt;
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

const MAX_JSON_CHARS = 200000;

function pretty(value: unknown): string {
  const text = JSON.stringify(value, null, 2) ?? '';
  if (text.length <= MAX_JSON_CHARS) return text;
  return `${text.slice(0, MAX_JSON_CHARS)}\n... (output is large, showing the first part)`;
}

function toggleStep(nodeId: string): void {
  expandedNodeId.value = expandedNodeId.value === nodeId ? null : nodeId;
  emit('select-step', nodeId);
}

// When a new run starts, collapse any open step.
watch(
  () => props.run.executionId,
  () => {
    expandedNodeId.value = null;
  },
);
</script>
