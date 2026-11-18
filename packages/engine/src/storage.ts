// SQLite storage for executions, via better-sqlite3 + Drizzle ORM.
// The database file lives outside the repo (default ./soldar.db, covered by
// .gitignore's *.db rule) and is created on first use.

import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { asc, desc, eq } from 'drizzle-orm';
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
  /** Deletes the workflow and every run (plus steps) that belongs to it. */
  deleteWorkflow(id: string): void;
  listExecutions(workflowId?: string, limit?: number, offset?: number): ExecutionRecord[];
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
  /** Deletes one run and all of its steps. */
  deleteExecution(id: string): void;
  /**
   * Runs still marked `running` after a crash or restart are not running
   * any more: mark them failed with an "interrupted" message. Returns how
   * many were fixed.
   */
  markStaleRunningInterrupted(): number;
  /**
   * Keep only the newest `keepPerWorkflow` runs of each workflow (default
   * 200) and delete the rest with their steps. Returns how many runs were
   * removed.
   */
  pruneExecutions(keepPerWorkflow?: number): number;
  close(): void;
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Row validation — a stored row is checked before it is trusted, never cast
// blindly. A corrupt row throws a plain error naming the table and the id
// instead of crashing something downstream with a confusing message.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reqString(row: Record<string, unknown>, field: string, what: string): string {
  const value = row[field];
  if (typeof value !== 'string') {
    throw new Error(`Stored ${what} is damaged: "${field}" is not text.`);
  }
  return value;
}

function reqNumber(row: Record<string, unknown>, field: string, what: string): number {
  const value = row[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Stored ${what} is damaged: "${field}" is not a number.`);
  }
  return value;
}

function optNumber(row: Record<string, unknown>, field: string, what: string): number | null {
  const value = row[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Stored ${what} is damaged: "${field}" is not a number.`);
  }
  return value;
}

function optString(row: Record<string, unknown>, field: string, what: string): string | null {
  const value = row[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new Error(`Stored ${what} is damaged: "${field}" is not text.`);
  }
  return value;
}

function asExecutionRecord(row: unknown): ExecutionRecord {
  if (!isRecord(row)) throw new Error('Stored run is damaged: not a record.');
  const status = reqString(row, 'status', 'run');
  if (status !== 'running' && status !== 'success' && status !== 'error') {
    throw new Error(`Stored run is damaged: unknown status "${status}".`);
  }
  return {
    id: reqString(row, 'id', 'run'),
    workflowId: reqString(row, 'workflowId', 'run'),
    workflowName: reqString(row, 'workflowName', 'run'),
    status,
    trigger: reqString(row, 'trigger', 'run'),
    startedAt: reqNumber(row, 'startedAt', 'run'),
    finishedAt: optNumber(row, 'finishedAt', 'run'),
    error: optString(row, 'error', 'run'),
  };
}

function asStepRecord(row: unknown): StepRecord {
  if (!isRecord(row)) throw new Error('Stored run step is damaged: not a record.');
  const status = reqString(row, 'status', 'run step');
  if (status !== 'success' && status !== 'error' && status !== 'skipped') {
    throw new Error(`Stored run step is damaged: unknown status "${status}".`);
  }
  return {
    id: reqString(row, 'id', 'run step'),
    executionId: reqString(row, 'executionId', 'run step'),
    nodeId: reqString(row, 'nodeId', 'run step'),
    nodeName: reqString(row, 'nodeName', 'run step'),
    nodeType: reqString(row, 'nodeType', 'run step'),
    status,
    inputJson: reqString(row, 'inputJson', 'run step'),
    outputJson: reqString(row, 'outputJson', 'run step'),
    error: optString(row, 'error', 'run step'),
    startedAt: reqNumber(row, 'startedAt', 'run step'),
    finishedAt: reqNumber(row, 'finishedAt', 'run step'),
  };
}

function asWorkflowRecord(row: unknown): WorkflowRecord {
  if (!isRecord(row)) throw new Error('Stored workflow is damaged: not a record.');
  const active = row['active'];
  if (typeof active !== 'boolean') {
    throw new Error('Stored workflow is damaged: "active" is not true or false.');
  }
  return {
    id: reqString(row, 'id', 'workflow'),
    name: reqString(row, 'name', 'workflow'),
    active,
    dataJson: reqString(row, 'dataJson', 'workflow'),
    createdAt: reqNumber(row, 'createdAt', 'workflow'),
    updatedAt: reqNumber(row, 'updatedAt', 'workflow'),
  };
}

// ---------------------------------------------------------------------------
// Migrations — versioned, in order, one transaction each. A database made
// by an older Soldar has the v1 tables but no migrations table, so v1 runs
// as a no-op (CREATE TABLE IF NOT EXISTS) and v2 adds the indexes.
// ---------------------------------------------------------------------------

const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 0,
        data_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS executions (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        workflow_name TEXT NOT NULL,
        status TEXT NOT NULL,
        trigger TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        error TEXT
      );
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
      );
    `,
  },
  {
    version: 2,
    sql: `
      CREATE INDEX IF NOT EXISTS idx_execution_steps_execution_id
        ON execution_steps (execution_id);
      CREATE INDEX IF NOT EXISTS idx_executions_workflow_id
        ON executions (workflow_id);
      CREATE INDEX IF NOT EXISTS idx_executions_started_at
        ON executions (started_at);
    `,
  },
];

function migrate(sqlite: Database.Database): void {
  sqlite.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)',
  );
  const applied = new Set(
    (
      sqlite.prepare('SELECT version FROM schema_migrations').all() as {
        version: number;
      }[]
    ).map((row) => row.version),
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    const run = sqlite.transaction(() => {
      sqlite.exec(migration.sql);
      sqlite
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(migration.version, Date.now());
    });
    run();
  }
}

/** Open (or create) the database at `dbPath` and make sure the tables exist. */
export function createStorage(dbPath: string): Storage & WorkflowStore {
  const sqlite = new Database(dbPath);
  // WAL lets readers run while a write is in flight, and the busy timeout
  // gives a CLI run a few seconds to wait out a server write instead of
  // failing at once with SQLITE_BUSY.
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  migrate(sqlite);
  const db: BetterSQLite3Database = drizzle(sqlite);

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
      return row === undefined ? undefined : asExecutionRecord(row);
    },

    listSteps(executionId) {
      // Run order: start time, with rowid breaking same-millisecond ties
      // by insertion order.
      const rows = db
        .select()
        .from(executionSteps)
        .where(eq(executionSteps.executionId, executionId))
        .orderBy(asc(executionSteps.startedAt), asc(sql`"execution_steps"."rowid"`))
        .all();
      return rows.map(asStepRecord);
    },

    deleteExecution(id) {
      db.delete(executionSteps).where(eq(executionSteps.executionId, id)).run();
      db.delete(executions).where(eq(executions.id, id)).run();
    },

    markStaleRunningInterrupted() {
      const stale = db
        .select()
        .from(executions)
        .where(eq(executions.status, 'running'))
        .all();
      for (const row of stale) {
        db.update(executions)
          .set({
            status: 'error',
            finishedAt: Date.now(),
            error: 'Interrupted: the server stopped while this run was going.',
          })
          .where(eq(executions.id, row.id))
          .run();
      }
      return stale.length;
    },

    pruneExecutions(keepPerWorkflow = 200) {
      const keep = Math.max(1, Math.floor(keepPerWorkflow));
      // Runs past the newest `keep` of their workflow, oldest first.
      const old = db.all(
        sql`SELECT id FROM executions WHERE id NOT IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (
              PARTITION BY workflow_id ORDER BY started_at DESC, rowid DESC
            ) AS rn FROM executions
          ) WHERE rn <= ${keep}
        )`,
      ) as { id: string }[];
      for (const row of old) {
        db.delete(executionSteps).where(eq(executionSteps.executionId, row.id)).run();
        db.delete(executions).where(eq(executions.id, row.id)).run();
      }
      return old.length;
    },

    listExecutions(workflowId, limit = 50, offset = 0) {
      const rows = workflowId
        ? db
            .select()
            .from(executions)
            .where(eq(executions.workflowId, workflowId))
            .orderBy(desc(executions.startedAt), desc(sql`"executions"."rowid"`))
            .limit(limit)
            .offset(offset)
            .all()
        : db
            .select()
            .from(executions)
            .orderBy(desc(executions.startedAt), desc(sql`"executions"."rowid"`))
            .limit(limit)
            .offset(offset)
            .all();
      return rows.map(asExecutionRecord);
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
      return row === undefined ? undefined : asWorkflowRecord(row);
    },

    listWorkflows() {
      // rowid breaks ties between rows stamped in the same millisecond, so
      // the order is deterministic: the later-inserted row comes first.
      const rows = db
        .select()
        .from(workflows)
        .orderBy(desc(workflows.updatedAt), desc(sql`"workflows"."rowid"`))
        .all();
      return rows.map(asWorkflowRecord);
    },

    updateWorkflow(id, data) {
      const existingRow = db
        .select()
        .from(workflows)
        .where(eq(workflows.id, id))
        .get();
      if (!existingRow) return undefined;
      const existing = asWorkflowRecord(existingRow);
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
      const existingRow = db
        .select()
        .from(workflows)
        .where(eq(workflows.id, id))
        .get();
      if (!existingRow) return undefined;
      const existing = asWorkflowRecord(existingRow);
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
      // A deleted workflow's runs go with it — otherwise the Runs view
      // fills with orphans whose workflow is gone.
      const runs = db
        .select()
        .from(executions)
        .where(eq(executions.workflowId, id))
        .all();
      for (const run of runs) {
        db.delete(executionSteps).where(eq(executionSteps.executionId, run.id)).run();
      }
      db.delete(executions).where(eq(executions.workflowId, id)).run();
      db.delete(workflows).where(eq(workflows.id, id)).run();
    },

    close() {
      sqlite.close();
    },
  };
}
