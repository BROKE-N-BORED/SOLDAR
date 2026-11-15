// SQLite storage for executions, via better-sqlite3 + Drizzle ORM.
// The database file lives outside the repo (default ./soldar.db, covered by
// .gitignore's *.db rule) and is created on first use.

import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { executions, executionSteps } from './schema.js';

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
export function createStorage(dbPath: string): Storage {
  const sqlite = new Database(dbPath);
  const db: BetterSQLite3Database = drizzle(sqlite);

  // Phase 1 has no migration runner; the tables are created if missing.
  // The DDL matches schema.ts exactly.
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

    close() {
      sqlite.close();
    },
  };
}
