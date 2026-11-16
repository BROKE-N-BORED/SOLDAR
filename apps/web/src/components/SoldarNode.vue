<template>
  <div class="soldar-node" :class="[`status-${data.status}`, { selected }]">
    <Handle
      v-if="data.inputs > 0"
      type="target"
      :position="Position.Left"
      class="soldar-handle"
    />
    <div class="soldar-node-body">
      <span class="soldar-node-light" :class="`light-${data.status}`" aria-hidden="true"></span>
      <span class="soldar-node-label">{{ data.label }}</span>
      <span class="soldar-node-type">{{ data.displayName }}</span>
    </div>
    <Handle
      v-for="(output, index) in data.outputs"
      :key="output"
      type="source"
      :position="Position.Right"
      :id="output"
      class="soldar-handle"
      :style="{ top: handleTop(index, data.outputs.length) }"
      :title="output === 'main' ? '' : output"
    />
    <span
      v-if="data.outputs.length > 1"
      class="soldar-node-branches"
      aria-hidden="true"
    >
      <span v-for="output in data.outputs" :key="output">{{ output }}</span>
    </span>
  </div>
</template>

<script setup lang="ts">
import { Handle, Position, type NodeProps } from '@vue-flow/core';
import type { SoldarNodeData } from '../types.js';

defineProps<NodeProps<SoldarNodeData>>();

// Spread several output handles down the right edge so they never overlap.
function handleTop(index: number, total: number): string {
  if (total <= 1) return '50%';
  return `${((index + 1) / (total + 1)) * 100}%`;
}
</script>
