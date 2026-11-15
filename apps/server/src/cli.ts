#!/usr/bin/env node
// Soldar CLI — Phase 1: run a workflow JSON file from the terminal.
//
//   pnpm run flow run my-workflow.json [--db path] [--json] [--trigger-data '<json>']
//
// The run is stored in SQLite (default ./soldar.db) and a summary is
// printed. Exit 0 on success, 1 on a failed run or bad input, 2 on bad usage.

import { readFile } from 'node:fs/promises';
import {
  createStorage,
  runWorkflow,
  WorkflowValidationError,
  type Item,
  type RunResult,
  type RunStepResult,
  type Workflow,
} from '@soldar/engine';
import { allNodes } from '@soldar/nodes';

const USAGE = `Soldar — run a workflow from the terminal.

Usage:
  pnpm run flow run <workflow.json> [--db <path>] [--json] [--trigger-data '<json>']

Options:
  --db <path>            SQLite database file (default: ./soldar.db)
  --json                 Print the full run result as JSON instead of a summary
  --trigger-data '<json>'  Items handed to trigger nodes: one object, or a list
                         of objects. Each object is an item's json, e.g.
                         '{"name":"Ada"}' or '[{"json":{"n":1}}]'.

Examples:
  pnpm run flow run examples/hello-workflow.json
  pnpm run flow run my-workflow.json --db ./runs.db
`;

interface RunArgs {
  file: string;
  dbPath: string;
  json: boolean;
  triggerData?: Item[];
}

function fail(message: string, code = 1): never {
  console.error(`Error: ${message}`);
  process.exitCode = code;
  throw new Error('__cli_exit__');
}

function parseTriggerData(raw: string): Item[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(`--trigger-data is not valid JSON.`);
  }
  const toItem = (entry: unknown, index: number): Item => {
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>;
      if (
        record.json !== null &&
        typeof record.json === 'object' &&
        !Array.isArray(record.json)
      ) {
        return { json: record.json as Record<string, unknown> };
      }
      return { json: record };
    }
    fail(`--trigger-data entry ${index} is not an object.`);
  };
  if (Array.isArray(parsed)) return parsed.map(toItem);
  return [toItem(parsed, 0)];
}

function parseArgs(argv: string[]): RunArgs {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    console.log(USAGE);
    process.exitCode = 0;
    throw new Error('__cli_exit__');
  }
  if (argv[0] !== 'run') {
    console.error(`Unknown command "${argv[0]}".\n`);
    console.error(USAGE);
    process.exitCode = 2;
    throw new Error('__cli_exit__');
  }
  const file = argv[1];
  if (!file || file.startsWith('--')) {
    console.error('Missing workflow file.\n');
    console.error(USAGE);
    process.exitCode = 2;
    throw new Error('__cli_exit__');
  }

  const args: RunArgs = { file, dbPath: './soldar.db', json: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      args.json = true;
    } else if (arg === '--db') {
      const value = argv[++i];
      if (!value) fail('--db needs a path.');
      args.dbPath = value;
    } else if (arg === '--trigger-data') {
      const value = argv[++i];
      if (!value) fail('--trigger-data needs a JSON value.');
      args.triggerData = parseTriggerData(value);
    } else {
      fail(`Unknown option "${arg}". See --help.`, 2);
    }
  }
  return args;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function formatCounts(step: RunStepResult): string {
  const outputs = Object.entries(step.output);
  if (outputs.length === 0) return `${step.input.length} in`;
  if (outputs.length === 1 && outputs[0][0] === 'main') {
    return `${step.input.length} in, ${outputs[0][1].length} out`;
  }
  const parts = outputs.map(([name, items]) => `${name}:${items.length}`);
  return `${step.input.length} in, ${parts.join(' ')} out`;
}

function printSummary(result: RunResult, dbPath: string): void {
  console.log(`Soldar — ${result.workflowName} (${result.workflowId})`);
  console.log(`Execution: ${result.executionId ?? '(not stored)'}`);
  for (const step of result.steps) {
    const ms = step.finishedAt - step.startedAt;
    if (step.status === 'success') {
      console.log(
        `  ✓ ${step.nodeName} (${step.nodeType}) — ${formatCounts(step)} · ${formatDuration(ms)}`,
      );
    } else if (step.status === 'skipped') {
      console.log(`  ○ ${step.nodeName} (${step.nodeType}) — skipped, no items arrived`);
    } else {
      console.log(`  ✗ ${step.nodeName} (${step.nodeType}) — ${step.error}`);
    }
  }
  if (result.status === 'success') {
    console.log(`Status: success · ${formatDuration(result.durationMs)}`);
  } else {
    console.log(`Status: error · ${formatDuration(result.durationMs)}`);
    console.log(`Failed: ${result.error}`);
  }
  console.log(`Database: ${dbPath}`);
}

async function main(): Promise<void> {
  let args: RunArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof Error && err.message === '__cli_exit__') return;
    throw err;
  }

  let raw: string;
  try {
    raw = await readFile(args.file, 'utf-8');
  } catch {
    fail(`Could not read "${args.file}".`);
  }

  let workflow: Workflow;
  try {
    workflow = JSON.parse(raw!) as Workflow;
  } catch (err) {
    fail(
      `Could not parse "${args.file}" as JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const storage = createStorage(args.dbPath);
  try {
    let result: RunResult;
    try {
      result = await runWorkflow(workflow!, allNodes, {
        storage,
        triggerData: args.triggerData,
      });
    } catch (err) {
      if (err instanceof WorkflowValidationError) {
        fail(err.message);
      }
      throw err;
    }

    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printSummary(result, args.dbPath);
    }
    process.exitCode = result.status === 'success' ? 0 : 1;
  } finally {
    storage.close();
  }
}

main().catch((err: unknown) => {
  if (err instanceof Error && err.message === '__cli_exit__') return;
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
