// Minimal rotating file logger. Every Soldar run writes timestamped lines to
// soldar.log; when the file passes 1 MB it rotates to soldar.log.1 (one
// backup kept). Logging must never crash the server, so every write is
// guarded. The log is available in the app via GET /api/debug-log.

import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs';

const MAX_BYTES = 1024 * 1024;

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export function createLogger(filePath: string): Logger {
  const write = (level: string, message: string): void => {
    const line = `${new Date().toISOString()} [${level}] ${message}\n`;
    try {
      if (existsSync(filePath) && statSync(filePath).size > MAX_BYTES) {
        renameSync(filePath, `${filePath}.1`);
      }
      appendFileSync(filePath, line);
    } catch {
      // Logging must never crash the server.
    }
  };
  return {
    info: (message) => write('INFO', message),
    warn: (message) => write('WARN', message),
    error: (message) => write('ERROR', message),
  };
}
