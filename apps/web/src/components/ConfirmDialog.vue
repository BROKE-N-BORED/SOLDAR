<template>
  <div class="dialog-backdrop" @click.self="emit('cancel')">
    <div class="dialog" role="alertdialog" :aria-label="title">
      <h2 class="dialog-title">{{ title }}</h2>
      <p class="dialog-message">{{ message }}</p>
      <div class="dialog-actions">
        <button
          ref="cancelButton"
          class="btn btn-secondary"
          type="button"
          @click="emit('cancel')"
        >
          {{ cancelLabel }}
        </button>
        <button class="btn btn-danger" type="button" @click="emit('confirm')">
          {{ confirmLabel }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';

withDefaults(
  defineProps<{
    title: string;
    message: string;
    confirmLabel: string;
    cancelLabel?: string;
  }>(),
  { cancelLabel: 'Keep it' },
);

const emit = defineEmits<{
  (event: 'confirm'): void;
  (event: 'cancel'): void;
}>();

// Destructive confirmations default to No: focus starts on the safe button.
const cancelButton = ref<HTMLButtonElement | null>(null);

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('cancel');
}

onMounted(() => {
  cancelButton.value?.focus();
  window.addEventListener('keydown', onKey);
});

onUnmounted(() => {
  window.removeEventListener('keydown', onKey);
});
</script>
