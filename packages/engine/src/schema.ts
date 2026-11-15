// Drizzle schema for the Soldar SQLite database (Phase 1: executions only.
// workflows / credentials / settings tables arrive with the server in Phase 2+).

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
