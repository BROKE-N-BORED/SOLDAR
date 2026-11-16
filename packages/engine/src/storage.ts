// SQLite storage for executions, via better-sqlite3 + Drizzle ORM.
// The database file lives outside the repo (default ./soldar.db, covered by
// .gitignore's *.db rule) and is created on first use.

import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { desc, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { executions, executionSteps, workflows } from './schema.js';
import type { Workflow } from './types.js';

export interface ExecutionRecord {
  id: string;
  workflowId: string;
  workflowName: string;
  status: 'running' | 'success' | 'error';
  trigger: string;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
}

export interface StepRecord {
  id: string;
  executionId: string;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  status: 'success' | 'error' | 'skipped';
  inputJson: string;
  outputJson: string;
  error: string | null;
  startedAt: number;
  finishedAt: number;
}

export interface WorkflowRecord {
  id: string;
  name: string;
  active: boolean;
  /** The full workflow JSON, stringified. */
  dataJson: string;
  createdAt: number;
  updatedAt: number;
}

/** The storage surface the server needs for workflows. Kept separate from
 *  Storage so the runner's surface stays small. The name/active columns
 *  mirror the same fields inside the stored workflow JSON. */
export interface WorkflowStore {
  createWorkflow(data: Workflow): WorkflowRecord;
  getWorkflow(id: string): WorkflowRecord | undefined;
  listWorkflows(): WorkflowRecord[];
  updateWorkflow(id: string, data: Workflow): WorkflowRecord | undefined;
  setWorkflowActive(id: string, active: boolean): WorkflowRecord | undefined;
  deleteWorkflow(id: string): void;
  listExecutions(workflowId?: string, limit?: number): ExecutionRecord[];
}

/** The storage surface the runner needs. Kept small so tests can fake it. */
export interface Storage {
  createExecution(input: {
    workflowId: string;
    workflowName: string;
    trigger: string;
    startedAt: number;
  }): ExecutionRecord;
  updateExecution(
    id: string,
    patch: Partial<Pick<ExecutionRecord, 'status' | 'finishedAt' | 'error'>>,
  ): void;
  addStep(step: Omit<StepRecord, 'id'>): StepRecord;
  getExecution(id: string): ExecutionRecord | undefined;
  listSteps(executionId: string): StepRecord[];
  close(): void;
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

/** Open (or create) the database at `dbPath` and make sure the tables exist. */
export function createStorage(dbPath: string): Storage & WorkflowStore {
  const sqlite = new Database(dbPath);
  const db: BetterSQLite3Database = drizzle(sqlite);

  // No migration runner yet; the tables are created if missing.
  // The DDL matches schema.ts exactly.
  db.run(sql`
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      data_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS executions (
      id TEXT PRIMARY KEY,
      workflow_id TEXT NOT NULL,
      workflow_name TEXT NOT NULL,
      status TEXT NOT NULL,
      trigger TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      error TEXT
    )
  `);
  db.run(sql`
    CREATE TABLE IF NOT EXISTS execution_steps (
      id TEXT PRIMARY KEY,
      execution_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      node_name TEXT NOT NULL,
      node_type TEXT NOT NULL,
      status TEXT NOT NULL,
      input_json TEXT NOT NULL,
      output_json TEXT NOT NULL,
      error TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER NOT NULL
    )
  `);

  return {
    createExecution(input) {
      const record: ExecutionRecord = {
        id: newId('exec'),
        workflowId: input.workflowId,
        workflowName: input.workflowName,
        status: 'running',
        trigger: input.trigger,
        startedAt: input.startedAt,
        finishedAt: null,
        error: null,
      };
      db.insert(executions).values(record).run();
      return record;
    },

    updateExecution(id, patch) {
      db.update(executions).set(patch).where(eq(executions.id, id)).run();
    },

    addStep(step) {
      const record: StepRecord = { id: newId('step'), ...step };
      db.insert(executionSteps).values(record).run();
      return record;
    },

    getExecution(id) {
      const row = db
        .select()
        .from(executions)
        .where(eq(executions.id, id))
        .get();
      return row as ExecutionRecord | undefined;
    },

    listSteps(executionId) {
      const rows = db
        .select()
        .from(executionSteps)
        .where(eq(executionSteps.executionId, executionId))
        .all();
      return rows as StepRecord[];
    },

    listExecutions(workflowId, limit = 50) {
      const rows = workflowId
        ? db
            .select()
            .from(executions)
            .where(eq(executions.workflowId, workflowId))
            .orderBy(desc(executions.startedAt), desc(sql`"executions"."rowid"`))
            .limit(limit)
            .all()
        : db
            .select()
            .from(executions)
            .orderBy(desc(executions.startedAt), desc(sql`"executions"."rowid"`))
            .limit(limit)
            .all();
      return rows as ExecutionRecord[];
    },

    createWorkflow(data) {
      const now = Date.now();
      const record: WorkflowRecord = {
        id: data.id,
        name: data.name,
        active: data.active,
        dataJson: JSON.stringify(data),
        createdAt: now,
        updatedAt: now,
      };
      db.insert(workflows).values(record).run();
      return record;
    },

    getWorkflow(id) {
      const row = db
        .select()
        .from(workflows)
        .where(eq(workflows.id, id))
        .get();
      return row as WorkflowRecord | undefined;
    },

    listWorkflows() {
      // rowid breaks ties between rows stamped in the same millisecond, so
      // the order is deterministic: the later-inserted row comes first.
      const rows = db
        .select()
        .from(workflows)
        .orderBy(desc(workflows.updatedAt), desc(sql`"workflows"."rowid"`))
        .all();
      return rows as WorkflowRecord[];
    },

    updateWorkflow(id, data) {
      const existing = db
        .select()
        .from(workflows)
        .where(eq(workflows.id, id))
        .get() as WorkflowRecord | undefined;
      if (!existing) return undefined;
      const record: WorkflowRecord = {
        ...existing,
        name: data.name,
        active: data.active,
        dataJson: JSON.stringify(data),
        updatedAt: Date.now(),
      };
      db.update(workflows).set(record).where(eq(workflows.id, id)).run();
      return record;
    },

    setWorkflowActive(id, active) {
      const existing = db
        .select()
        .from(workflows)
        .where(eq(workflows.id, id))
        .get() as WorkflowRecord | undefined;
      if (!existing) return undefined;
      const data = JSON.parse(existing.dataJson) as Workflow;
      data.active = active;
      const record: WorkflowRecord = {
        ...existing,
        active,
        dataJson: JSON.stringify(data),
        updatedAt: Date.now(),
      };
      db.update(workflows).set(record).where(eq(workflows.id, id)).run();
      return record;
    },

    deleteWorkflow(id) {
      db.delete(workflows).where(eq(workflows.id, id)).run();
    },

    close() {
      sqlite.close();
    },
  };
}
