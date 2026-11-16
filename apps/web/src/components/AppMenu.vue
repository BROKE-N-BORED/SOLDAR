<template>
  <header class="menu">
    <RouterLink to="/" class="wordmark">
      <svg class="wordmark-mark" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="5" cy="12" r="2.4" />
        <circle cx="19" cy="12" r="2.4" />
        <path d="M7.5 12h3l1.6-3.2a2.4 2.4 0 0 1 4.3 1.6L16 12h.5" />
      </svg>
      <span class="wordmark-text">Soldar</span>
    </RouterLink>
    <nav class="menu-nav" aria-label="Main">
      <RouterLink to="/" class="menu-link">Workflows</RouterLink>
      <RouterLink to="/executions" class="menu-link">Runs</RouterLink>
      <RouterLink to="/help" class="menu-link">How to use</RouterLink>
    </nav>
    <div class="menu-status" :title="statusTitle">
      <span class="status-dot" :class="{ on: connected }" aria-hidden="true"></span>
      <span class="status-text">{{ connected ? 'Connected' : 'No server' }}</span>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { api } from '../api.js';

const connected = ref(false);
let timer: ReturnType<typeof setInterval> | null = null;

const statusTitle = computed(() =>
  connected.value
    ? 'The Soldar server is answering.'
    : 'The Soldar server is not answering. Is it running?',
);

async function check(): Promise<void> {
  try {
    await api.health();
    connected.value = true;
  } catch {
    connected.value = false;
  }
}

onMounted(() => {
  void check();
  timer = setInterval(() => void check(), 30000);
});

onUnmounted(() => {
  if (timer !== null) clearInterval(timer);
});
</script>
