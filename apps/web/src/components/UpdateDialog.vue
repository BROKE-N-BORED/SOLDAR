<template>
  <div class="dialog-backdrop" @click.self="onBackdrop">
    <div class="dialog" role="alertdialog" aria-label="Soldar update">
      <template v-if="step === 'available' && status !== null">
        <h2 class="dialog-title">Soldar {{ status.latest }} is out</h2>
        <p class="dialog-message">
          You have {{ status.current }}. Update now, or keep this version.
        </p>
        <div class="dialog-actions">
          <button
            ref="safeButton"
            class="btn btn-secondary"
            type="button"
            @click="close"
          >
            Not now
          </button>
          <button class="btn btn-primary" type="button" @click="startDownload">
            Update now
          </button>
        </div>
      </template>

      <template v-else-if="step === 'not-installable' && status !== null">
        <h2 class="dialog-title">Soldar {{ status.latest }} is out</h2>
        <p class="dialog-message">
          You have {{ status.current }}. This release has no checksum
          published, so Soldar will not install it on its own. You can get
          it from the release page instead.
        </p>
        <div class="dialog-actions">
          <button
            ref="safeButton"
            class="btn btn-secondary"
            type="button"
            @click="close"
          >
            Close
          </button>
          <a
            class="btn btn-primary"
            :href="status.url ?? undefined"
            target="_blank"
            rel="noreferrer"
          >
            Open the release page
          </a>
        </div>
      </template>

      <template v-else-if="step === 'downloading' && status !== null">
        <h2 class="dialog-title">Downloading Soldar {{ status.latest }}...</h2>
        <p class="dialog-message">
          The download is checked against its published checksum before
          anything is installed. You can close this and keep working; the
          download carries on.
        </p>
        <div class="dialog-actions">
          <button class="btn btn-secondary" type="button" @click="close">
            Close
          </button>
        </div>
      </template>

      <template v-else-if="step === 'ready'">
        <h2 class="dialog-title">Update ready</h2>
        <p class="dialog-message">
          Soldar {{ stagedVersion }} is downloaded and checked. Restart now
          to finish the update, or leave it and it will finish the next
          time Soldar starts.
        </p>
        <div class="dialog-actions">
          <button
            ref="safeButton"
            class="btn btn-secondary"
            type="button"
            @click="close"
          >
            Later
          </button>
          <button class="btn btn-primary" type="button" @click="restartNow">
            Restart now
          </button>
        </div>
      </template>

      <template v-else-if="step === 'restarting'">
        <h2 class="dialog-title">Restarting Soldar...</h2>
        <p class="dialog-message">
          Soldar is restarting with the update. This page comes back on its
          own when the new version is running.
        </p>
      </template>

      <template v-else-if="step === 'error'">
        <h2 class="dialog-title">The update could not finish</h2>
        <p class="dialog-message">{{ errorMessage }}</p>
        <div class="dialog-actions">
          <button
            ref="safeButton"
            class="btn btn-secondary"
            type="button"
            @click="close"
          >
            Close
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api } from '../api.js';
import { useUpdatesStore } from '../stores/updates.js';

type Step = 'available' | 'not-installable' | 'downloading' | 'ready' | 'restarting' | 'error';

const store = useUpdatesStore();
const status = computed(() => store.status);
const stagedVersion = computed(
  () => store.status?.stagedVersion ?? store.status?.latest ?? '',
);

const step = ref<Step>('available');
const errorMessage = ref('');
const safeButton = ref<HTMLButtonElement | null>(null);
let pollTimer: ReturnType<typeof setInterval> | null = null;

function close(): void {
  store.closeDialog();
}

function onBackdrop(): void {
  // The restart is already running; closing would leave the user on a
  // page whose server is going away.
  if (step.value === 'restarting') return;
  close();
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') onBackdrop();
}

async function startDownload(): Promise<void> {
  step.value = 'downloading';
  try {
    await api.downloadUpdate();
    await store.refresh();
    step.value = 'ready';
  } catch (err) {
    errorMessage.value =
      err instanceof Error ? err.message : 'The update could not be downloaded.';
    step.value = 'error';
  }
}

async function restartNow(): Promise<void> {
  step.value = 'restarting';
  try {
    await api.restartForUpdate();
  } catch (err) {
    errorMessage.value =
      err instanceof Error ? err.message : 'Soldar could not restart for the update.';
    step.value = 'error';
    return;
  }
  // The server goes away while the update installs, then comes back on
  // the new version. Poll until it answers with the new version, then
  // reload into it. Four minutes is ample for a rebuild on a slow PC.
  const startedAt = Date.now();
  const target = stagedVersion.value;
  pollTimer = setInterval(() => {
    void (async () => {
      if (Date.now() - startedAt > 4 * 60 * 1000) {
        if (pollTimer !== null) clearInterval(pollTimer);
        errorMessage.value =
          'Soldar did not come back on its own. Start it again from the desktop icon.';
        step.value = 'error';
        return;
      }
      try {
        const health = await api.health();
        if (health.version === target || health.version !== status.value?.current) {
          if (pollTimer !== null) clearInterval(pollTimer);
          window.location.reload();
        }
      } catch {
        // The server is down mid-update; keep waiting.
      }
    })();
  }, 3000);
}

onMounted(() => {
  if (store.dialogStart === 'ready') {
    step.value = 'ready';
  } else if (store.status !== null && !store.status.installable) {
    step.value = 'not-installable';
  } else {
    step.value = 'available';
  }
  safeButton.value?.focus();
  window.addEventListener('keydown', onKey);
});

onUnmounted(() => {
  if (pollTimer !== null) clearInterval(pollTimer);
  window.removeEventListener('keydown', onKey);
});
</script>
