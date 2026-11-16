// What every route module needs: the database, the run service, the logger,
// and the log file path (for the debug-log endpoint).

import type { Storage, WorkflowStore } from '@soldar/engine';
import type { Logger } from '../logger.js';
import type { RunService } from '../run-service.js';

export interface RouteContext {
  storage: Storage & WorkflowStore;
  runs: RunService;
  logger: Logger;
  logPath: string;
}
