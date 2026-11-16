<template>
  <div class="app">
    <AppMenu />
    <main class="app-main">
      <RouterView />
    </main>
  </div>
</template>

<script setup lang="ts">
import { RouterView } from 'vue-router';
import AppMenu from './components/AppMenu.vue';
</script>
