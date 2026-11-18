// A ticking clock for durations that must move while a run is going.
// `Date.now()` inside a computed only re-evaluates when its other inputs
// change, so a running duration freezes; this ref ticks instead.

import { onUnmounted, ref, watch, type Ref } from 'vue';

/** A ref holding the current time, ticking every `intervalMs` while
 *  `active` is true. Stops ticking (and stops the timer) when inactive. */
export function useTickingNow(active: Ref<boolean>, intervalMs = 250): Ref<number> {
  const now = ref(Date.now());
  let timer: ReturnType<typeof setInterval> | null = null;

  const stop = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
  const start = (): void => {
    stop();
    now.value = Date.now();
    timer = setInterval(() => {
      now.value = Date.now();
    }, intervalMs);
  };

  watch(active, (value) => (value ? start() : stop()), { immediate: true });
  onUnmounted(stop);
  return now;
}
