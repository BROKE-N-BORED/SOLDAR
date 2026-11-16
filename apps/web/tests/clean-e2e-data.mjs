// Wipes the end-to-end database before a test run, so tests never see
// each other's workflows. Runs from the `test:e2e` script, before
// Playwright starts — NOT as a Playwright globalSetup, because a wipe
// inside the Playwright lifecycle can land after the server has started
// and delete the database out from under it (writes then fail with a 500).
//
// The path must match tests/paths.ts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

fs.rmSync(path.join(os.tmpdir(), 'soldar-e2e-data'), {
  recursive: true,
  force: true,
});
