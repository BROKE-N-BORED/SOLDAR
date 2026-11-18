// What every route module needs: the database, the run service, the logger,
// and the log file path (for the debug-log endpoint). The update service
// and the restart callback are optional: only the real server (index.ts)
// wires them in, so a test server without them answers 503 on the update
// routes instead of pretending.

import type { NodeDefinition, Storage, WorkflowStore } from '@soldar/engine';
import type { Logger } from '../logger.js';
import type { RunService } from '../run-service.js';
import type { UpdateService } from '../update.js';

export interface RouteContext {
  storage: Storage & WorkflowStore;
  runs: RunService;
  logger: Logger;
  logPath: string;
  /** Every built-in node, so saving can check node types and wire outputs. */
  definitions: NodeDefinition[];
  update?: UpdateService;
  onRestartRequested?: () => void;
  /**
   * Called when the UI asks the server to stop (POST /api/shutdown).
   * Only the real server wires it in; without it the route answers 503.
   */
  onShutdownRequested?: () => void;
}
