<template>
  <div class="app">
    <AppMenu />
    <main class="app-main">
      <RouterView />
    </main>
    <nav class="tab-bar" aria-label="Main">
      <RouterLink to="/" class="tab-bar-link">Workflows</RouterLink>
      <RouterLink to="/executions" class="tab-bar-link">Runs</RouterLink>
      <RouterLink to="/help" class="tab-bar-link">How to use</RouterLink>
    </nav>
    <UpdateDialog v-if="updates.dialogOpen" />
  </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { RouterLink, RouterView } from 'vue-router';
import AppMenu from './components/AppMenu.vue';
import UpdateDialog from './components/UpdateDialog.vue';
import { useUpdatesStore } from './stores/updates.js';

const updates = useUpdatesStore();

// The silent startup check already ran on the server; this just reads the
// result. The dialog only opens when an update is actually waiting.
onMounted(() => {
  void updates.load();
});
</script>
