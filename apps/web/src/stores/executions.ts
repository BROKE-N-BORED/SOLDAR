// Run history state.

import { defineStore } from 'pinia';
import { api, type ExecutionRecord, type StepRecord } from '../api.js';

export const useExecutionsStore = defineStore('executions', {
  state: () => ({
    history: [] as ExecutionRecord[],
    detail: null as { execution: ExecutionRecord; steps: StepRecord[] } | null,
    loading: false,
    error: '' as string,
  }),
  actions: {
    async loadHistory(workflowId?: string): Promise<void> {
      this.loading = true;
      this.error = '';
      try {
        this.history = await api.listExecutions(workflowId);
      } catch (err) {
        this.error = err instanceof Error ? err.message : 'Could not load runs.';
      } finally {
        this.loading = false;
      }
    },
    async loadDetail(id: string): Promise<void> {
      this.loading = true;
      this.error = '';
      try {
        this.detail = await api.getExecution(id);
      } catch (err) {
        this.error = err instanceof Error ? err.message : 'Could not load that run.';
      } finally {
        this.loading = false;
      }
    },
  },
});
