// Step JSON parsing, defensive: one corrupt step row must not break the
// whole Runs view or drop a live snapshot. A row whose JSON does not parse
// shows empty data with a plain note instead of throwing.

import type { StepRecord } from './api.js';
import type { StepData } from './types.js';

export function stepFromRecord(record: StepRecord): StepData {
  let input: StepData['input'] = [];
  let output: StepData['output'] = {};
  let error = record.error ?? undefined;
  try {
    input = JSON.parse(record.inputJson) as StepData['input'];
  } catch {
    input = [];
    error = "This step's saved input could not be read.";
  }
  try {
    output = JSON.parse(record.outputJson) as StepData['output'];
  } catch {
    output = {};
    error = error ?? "This step's saved output could not be read.";
  }
  if (!Array.isArray(input)) input = [];
  if (output === null || typeof output !== 'object' || Array.isArray(output)) {
    output = {};
  }
  return {
    nodeId: record.nodeId,
    nodeName: record.nodeName,
    nodeType: record.nodeType,
    status: record.status,
    input,
    output,
    error,
    note: record.note ?? undefined,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
  };
}
