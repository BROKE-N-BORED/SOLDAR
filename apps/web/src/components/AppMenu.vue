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
      <span class="status-text">{{ statusText }}</span>
    </div>
    <button
      v-if="!stopping"
      class="btn btn-secondary btn-small menu-stop"
      type="button"
      title="Stop the Soldar server"
      @click="askingStop = true"
    >
      Stop Soldar
    </button>
    <ConfirmDialog
      v-if="askingStop"
      title="Stop Soldar?"
      message="The server stops and this page stops working. Start Soldar again from its launcher when you want it back."
      confirm-label="Stop it"
      cancel-label="Keep running"
      @confirm="confirmStop"
      @cancel="askingStop = false"
    />
  </header>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { api } from '../api.js';
import ConfirmDialog from './ConfirmDialog.vue';

const connected = ref(false);
const stopping = ref(false);
const askingStop = ref(false);
let timer: ReturnType<typeof setInterval> | null = null;

const statusText = computed(() => {
  if (stopping.value) return 'Stopping...';
  return connected.value ? 'Connected' : 'No server';
});

const statusTitle = computed(() =>
  stopping.value
    ? 'Soldar is stopping. You can close this tab.'
    : connected.value
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

async function confirmStop(): Promise<void> {
  askingStop.value = false;
  stopping.value = true;
  connected.value = false;
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  try {
    await api.shutdownServer();
  } catch {
    // The server may close before the reply lands; stopping anyway.
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
