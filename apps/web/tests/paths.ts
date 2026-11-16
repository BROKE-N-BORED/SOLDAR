import os from 'node:os';
import path from 'node:path';

// Where the end-to-end server keeps its database. Shared by the Playwright
// config (which hands it to the server) and tests/clean-e2e-data.mjs
// (which wipes it before each run). Kept here so the two never drift apart.
//
// It lives in the OS temp dir, not in the repo: the database is throwaway
// test state, and keeping it out of the tree means a test run never leaves
// anything behind in the checkout.
export const e2eDataDir = path.join(os.tmpdir(), 'soldar-e2e-data');
