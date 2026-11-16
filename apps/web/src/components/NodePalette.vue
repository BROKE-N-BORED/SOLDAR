<template>
  <aside class="palette" aria-label="Nodes">
    <h2 class="palette-title">Nodes</h2>
    <p class="palette-hint">Drag one onto the canvas, or click it to add it.</p>
    <ul class="palette-list">
      <li v-for="node in nodes" :key="node.type">
        <div
          class="palette-item"
          draggable="true"
          role="button"
          tabindex="0"
          :aria-label="`Add ${node.displayName} node`"
          @dragstart="onDragStart($event, node.type)"
          @click="emit('add-node', node.type)"
          @keydown.enter="emit('add-node', node.type)"
          @keydown.space.prevent="emit('add-node', node.type)"
        >
          <span class="palette-item-name">{{ node.displayName }}</span>
          <span class="palette-item-desc">{{ node.description }}</span>
        </div>
      </li>
    </ul>
  </aside>
</template>

<script setup lang="ts">
import type { NodeInfo } from '../api.js';

defineProps<{ nodes: NodeInfo[] }>();

const emit = defineEmits<{
  (event: 'add-node', type: string): void;
}>();

function onDragStart(event: DragEvent, type: string): void {
  if (event.dataTransfer) {
    event.dataTransfer.setData('application/soldar-node', type);
    event.dataTransfer.effectAllowed = 'copy';
  }
}
</script>
