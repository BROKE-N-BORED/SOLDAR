// Workflow list + node catalogue state.

import { defineStore } from 'pinia';
import { api, type NodeInfo, type WorkflowSummary } from '../api.js';

export const useWorkflowsStore = defineStore('workflows', {
  state: () => ({
    list: [] as WorkflowSummary[],
    nodes: [] as NodeInfo[],
    loading: false,
    error: '' as string,
  }),
  actions: {
    async loadList(): Promise<void> {
      this.loading = true;
      this.error = '';
      try {
        this.list = await api.listWorkflows();
      } catch (err) {
        this.error = err instanceof Error ? err.message : 'Could not load workflows.';
      } finally {
        this.loading = false;
      }
    },
    async loadNodes(): Promise<void> {
      if (this.nodes.length > 0) return;
      try {
        this.nodes = await api.listNodes();
      } catch (err) {
        this.error = err instanceof Error ? err.message : 'Could not load nodes.';
      }
    },
    async create(name?: string): Promise<string> {
      const detail = await api.createWorkflow(name);
      await this.loadList();
      return detail.id;
    },
    async duplicate(id: string): Promise<string> {
      const detail = await api.duplicateWorkflow(id);
      await this.loadList();
      return detail.id;
    },
    async remove(id: string): Promise<void> {
      await api.deleteWorkflow(id);
      await this.loadList();
    },
    async toggleActive(id: string, active: boolean): Promise<void> {
      const updated = await api.setActive(id, active);
      const row = this.list.find((w) => w.id === id);
      if (row) row.active = updated.active;
    },
    nodeInfo(type: string): NodeInfo | undefined {
      return this.nodes.find((n) => n.type === type);
    },
  },
});
