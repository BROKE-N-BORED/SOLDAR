// Update state: the last check result, and whether the update dialog is
// open. App.vue loads the status once at startup; the Help page runs a
// manual check through here. The dialog only ever opens for a newer
// release (or a staged update waiting for a restart) — up to date and
// failed checks stay silent, exactly as the standing rule says.

import { defineStore } from 'pinia';
import { api, type UpdateStatus } from '../api.js';

export type DialogStart = 'available' | 'ready';

export const useUpdatesStore = defineStore('updates', {
  state: () => ({
    status: null as UpdateStatus | null,
    dialogOpen: false,
    dialogStart: 'available' as DialogStart,
    // The user said "Not now" / "Later" this page session. The dialog
    // does not nag again until the next launch.
    dismissed: false,
    loaded: false,
  }),
  actions: {
    // Load the status, waiting for the server's startup check to settle
    // first (it runs in the background; the page can load before it
    // finishes). Polls every 2 s for up to 30 s, then gives up quietly.
    async load(): Promise<void> {
      if (this.loaded) return;
      this.loaded = true;
      for (let attempt = 0; attempt < 15; attempt += 1) {
        try {
          this.status = await api.getUpdateStatus();
        } catch {
          // The server is unreachable; the menu already says "No server".
          return;
        }
        if (this.status.state !== 'checking') break;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      this.maybeOpen();
    },

    // A fresh check, for the manual button. Returns a plain result line
    // for the Help page to show; opens the dialog when an update is out.
    async checkNow(): Promise<string> {
      try {
        this.status = await api.checkForUpdate();
      } catch (err) {
        return err instanceof Error ? err.message : 'The update check could not run.';
      }
      if (this.status.state === 'newer' && this.status.latest !== null) {
        this.dismissed = false;
        this.maybeOpen();
        return `Soldar ${this.status.latest} is out.`;
      }
      if (this.status.state === 'current') {
        return 'You have the newest version.';
      }
      return this.status.reason ?? 'The update check could not run.';
    },

    // Refresh the status without opening anything (the dialog calls this
    // after a download finishes, so the staged version is known).
    async refresh(): Promise<void> {
      try {
        this.status = await api.getUpdateStatus();
      } catch {
        // Keep the last known status.
      }
    },

    maybeOpen(): void {
      if (this.dismissed || this.dialogOpen || this.status === null) return;
      if (this.status.stagedVersion !== null) {
        this.dialogStart = 'ready';
        this.dialogOpen = true;
        return;
      }
      if (this.status.state === 'newer') {
        this.dialogStart = 'available';
        this.dialogOpen = true;
      }
    },

    closeDialog(): void {
      this.dialogOpen = false;
      this.dismissed = true;
    },
  },
});
