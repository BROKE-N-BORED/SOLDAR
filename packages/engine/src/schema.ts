// Drizzle schema for the Soldar SQLite database (Phase 2: executions +
// workflows. Credentials / settings tables arrive with the server in Phase 4+).

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const workflows = sqliteTable('workflows', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull().default(false),
  /** The full workflow JSON, stringified. */
  dataJson: text('data_json').notNull(),
  /** Epoch milliseconds. */
  createdAt: integer('created_at').notNull(),
  /** Epoch milliseconds. */
  updatedAt: integer('updated_at').notNull(),
});

export const executions = sqliteTable('executions', {
  id: text('id').primaryKey(),
  workflowId: text('workflow_id').notNull(),
  workflowName: text('workflow_name').notNull(),
  /** running | success | error */
  status: text('status').notNull(),
  /** manual | schedule | webhook */
  trigger: text('trigger').notNull(),
  /** Epoch milliseconds. */
  startedAt: integer('started_at').notNull(),
  /** Epoch milliseconds, null while running. */
  finishedAt: integer('finished_at'),
  /** Plain error message when status is error. */
  error: text('error'),
});

export const executionSteps = sqliteTable('execution_steps', {
  id: text('id').primaryKey(),
  executionId: text('execution_id').notNull(),
  nodeId: text('node_id').notNull(),
  nodeName: text('node_name').notNull(),
  nodeType: text('node_type').notNull(),
  /** success | error | skipped */
  status: text('status').notNull(),
  /** JSON-encoded Item[] */
  inputJson: text('input_json').notNull(),
  /** JSON-encoded NodeOutput */
  outputJson: text('output_json').notNull(),
  /** Plain error message when status is error. */
  error: text('error'),
  /** Epoch milliseconds. */
  startedAt: integer('started_at').notNull(),
  /** Epoch milliseconds. */
  finishedAt: integer('finished_at').notNull(),
});
