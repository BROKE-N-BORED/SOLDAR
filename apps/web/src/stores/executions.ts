// Run history state.

import { defineStore } from 'pinia';
import { api, type ExecutionRecord, type StepRecord } from '../api.js';

const PAGE_SIZE = 50;

export const useExecutionsStore = defineStore('executions', {
  state: () => ({
    history: [] as ExecutionRecord[],
    detail: null as { execution: ExecutionRecord; steps: StepRecord[] } | null,
    loading: false,
    error: '' as string,
    /** True when the last page was full, so more runs may exist. */
    hasMore: false,
  }),
  actions: {
    async loadHistory(workflowId?: string): Promise<void> {
      this.loading = true;
      this.error = '';
      try {
        this.history = await api.listExecutions(workflowId, PAGE_SIZE, 0);
        this.hasMore = this.history.length === PAGE_SIZE;
      } catch (err) {
        this.error = err instanceof Error ? err.message : 'Could not load runs.';
      } finally {
        this.loading = false;
      }
    },
    async loadMore(workflowId?: string): Promise<void> {
      if (this.loading || !this.hasMore) return;
      this.loading = true;
      this.error = '';
      try {
        const page = await api.listExecutions(workflowId, PAGE_SIZE, this.history.length);
        this.history = [...this.history, ...page];
        this.hasMore = page.length === PAGE_SIZE;
      } catch (err) {
        this.error = err instanceof Error ? err.message : 'Could not load more runs.';
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
    async remove(id: string): Promise<void> {
      await api.deleteExecution(id);
      this.history = this.history.filter((run) => run.id !== id);
      if (this.detail?.execution.id === id) this.detail = null;
    },
  },
});
