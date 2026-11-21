import { expect, test } from '@playwright/test';

// End-to-end proof of the v0.3.0 web wave: the IF condition builder,
// settings validation blocking Save, run cancel, node-delete confirm,
// Save and leave, run-just-this-node, duplicate/export/import, per-run
// delete, and the workflow settings section. Runs against the production
// build (see playwright.config.ts); run `pnpm build` first.

async function createWorkflow(
  page: import('@playwright/test').Page,
  name: string,
): Promise<string> {
  const created = await page.request.post('/api/workflows', { data: { name } });
  expect(created.ok()).toBeTruthy();
  const { workflow } = (await created.json()) as { workflow: { id: string } };
  return workflow.id;
}

async function saveWorkflow(
  page: import('@playwright/test').Page,
  id: string,
  body: unknown,
): Promise<void> {
  const saved = await page.request.put(`/api/workflows/${id}`, { data: body });
  expect(saved.ok()).toBeTruthy();
}

test('the IF condition builder adds a condition that branches a run', async ({ page }) => {
  const id = await createWorkflow(page, 'IF builder flow');
  await saveWorkflow(page, id, {
    id,
    name: 'IF builder flow',
    active: false,
    nodes: [
      { id: 'n_trigger', type: 'manual-trigger', name: 'Start', position: [100, 100], parameters: {} },
      {
        id: 'n_age',
        type: 'set',
        name: 'Add age',
        position: [350, 100],
        parameters: { values: [{ name: 'age', value: 40 }] },
      },
      {
        id: 'n_if',
        type: 'if',
        name: 'Check age',
        position: [600, 100],
        parameters: { conditions: [], combine: 'all' },
      },
      {
        id: 'n_old',
        type: 'set',
        name: 'Old',
        position: [850, 60],
        parameters: { values: [{ name: 'group', value: 'old' }] },
      },
      {
        id: 'n_young',
        type: 'set',
        name: 'Young',
        position: [850, 200],
        parameters: { values: [{ name: 'group', value: 'young' }] },
      },
    ],
    connections: [
      { from: 'n_trigger', to: 'n_age', output: 'main' },
      { from: 'n_age', to: 'n_if', output: 'main' },
      { from: 'n_if', to: 'n_old', output: 'true' },
      { from: 'n_if', to: 'n_young', output: 'false' },
    ],
  });

  await page.goto(`/workflows/${id}`);
  await expect(page.locator('.editor-name')).toHaveValue('IF builder flow');
  await page.locator('.soldar-node', { hasText: 'Check age' }).click();
  await expect(page.locator('.settings-title')).toHaveText('IF');

  // No raw JSON textarea: the builder is what shows.
  await expect(page.locator('.condition-builder')).toBeVisible();
  await expect(page.locator('.condition-builder')).toContainText(
    'An IF node needs at least one condition',
  );
  await page.getByRole('button', { name: 'Add a condition' }).click();
  await page.getByLabel('Left side').fill('{{ $json.age }}');
  await page.getByLabel('Operator').selectOption('greaterThan');
  await page.getByLabel('Right side').fill('30');

  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.locator('.run-panel-status')).toHaveText('Finished, all good', {
    timeout: 30000,
  });
  // Age 40 is more than 30, so the true branch ran and the false one skipped.
  const oldStep = page.locator('.run-step', { hasText: 'Old' });
  await expect(oldStep.locator('.run-step-dot')).toHaveClass(/dot-success/);
  const youngStep = page.locator('.run-step', { hasText: 'Young' });
  await expect(youngStep.locator('.run-step-dot')).toHaveClass(/dot-skipped/);
});

test('an empty required field blocks Save until it is filled', async ({ page }) => {
  const id = await createWorkflow(page, 'Required flow');
  await page.goto(`/workflows/${id}`);
  await expect(page.locator('.editor-name')).toHaveValue('Required flow');

  await page.locator('.palette-item', { hasText: 'HTTP Request' }).click();
  await expect(page.locator('.settings-title')).toHaveText('HTTP Request');
  await expect(page.locator('.field-error').first()).toContainText('This is required');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeDisabled();

  await page.getByLabel('URL').fill('https://example.com');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
});

test('a duplicate node name warns and blocks Save', async ({ page }) => {
  const id = await createWorkflow(page, 'Duplicate name flow');
  await page.goto(`/workflows/${id}`);
  await page.locator('.palette-item', { hasText: 'Set' }).click();
  await page.locator('.palette-item', { hasText: 'Set' }).click();
  await expect(page.locator('.soldar-node')).toHaveCount(2);

  // The second Set is selected (adding selects it); rename it to match.
  await page.getByLabel('Name', { exact: true }).fill('Set');
  await expect(page.locator('.field-error').first()).toContainText(
    'Another node is already called "Set"',
  );
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
});

test('the Active toggle turns a workflow on and off', async ({ page }) => {
  const id = await createWorkflow(page, 'Active flow');
  await page.goto(`/workflows/${id}`);
  const toggle = page.locator('.editor-active input[type="checkbox"]');
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(toggle).toBeChecked();

  await page.goto('/');
  const rowToggle = page
    .locator('.workflow-row', { hasText: 'Active flow' })
    .locator('input[type="checkbox"]');
  await expect(rowToggle).toBeEnabled();
  await expect(rowToggle).toBeChecked();
  await rowToggle.uncheck();
  await expect(rowToggle).not.toBeChecked();
});

test('Stop ends a running run', async ({ page }) => {
  const id = await createWorkflow(page, 'Stop flow');
  await saveWorkflow(page, id, {
    id,
    name: 'Stop flow',
    active: false,
    nodes: [
      { id: 'n_trigger', type: 'manual-trigger', name: 'Start', position: [100, 100], parameters: {} },
      {
        id: 'n_code',
        type: 'code',
        name: 'Slow step',
        position: [350, 100],
        parameters: {
          code: 'let x = 0; for (let i = 0; i < 200000000; i++) x += i; return items;',
        },
      },
    ],
    connections: [{ from: 'n_trigger', to: 'n_code', output: 'main' }],
  });
  await page.goto(`/workflows/${id}`);
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  // Exact: the menu also has a "Stop Soldar" button.
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.locator('.run-panel-error').first()).toContainText('Run stopped.', {
    timeout: 30000,
  });
  await expect(page.locator('.run-panel-status')).toHaveText('Finished, with an error');
});

test('deleting a node asks first', async ({ page }) => {
  const id = await createWorkflow(page, 'Delete node flow');
  await page.goto(`/workflows/${id}`);
  await page.locator('.palette-item', { hasText: 'Set' }).click();
  await expect(page.locator('.soldar-node')).toHaveCount(1);

  // Delete key: cancel keeps the node.
  await page.keyboard.press('Delete');
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await expect(page.getByRole('alertdialog')).toContainText('Delete this node?');
  await page.getByRole('button', { name: 'Keep it' }).click();
  await expect(page.locator('.soldar-node')).toHaveCount(1);

  // Delete key again: confirm removes it.
  await page.keyboard.press('Delete');
  await page.getByRole('button', { name: 'Delete it' }).click();
  await expect(page.locator('.soldar-node')).toHaveCount(0);
});

test('Save and leave saves, then leaves', async ({ page }) => {
  const id = await createWorkflow(page, 'Save and leave flow');
  await page.goto(`/workflows/${id}`);
  await page.locator('.palette-item', { hasText: 'Set' }).click();
  await expect(page.locator('.editor-dirty')).toBeVisible();

  await page.getByRole('link', { name: 'Runs' }).first().click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('button', { name: 'Save and leave' }).click();
  await expect(page).toHaveURL(/\/executions$/);

  // The node survived: the save went through before leaving.
  await page.goto(`/workflows/${id}`);
  await expect(page.locator('.soldar-node')).toHaveCount(1);
  await expect(page.locator('.editor-dirty')).toHaveCount(0);
});

test('Run just this node runs one node only', async ({ page }) => {
  const id = await createWorkflow(page, 'Single node flow');
  await saveWorkflow(page, id, {
    id,
    name: 'Single node flow',
    active: false,
    nodes: [
      { id: 'n_trigger', type: 'manual-trigger', name: 'Start', position: [100, 100], parameters: {} },
      {
        id: 'n_set',
        type: 'set',
        name: 'Greet',
        position: [350, 100],
        parameters: { values: [{ name: 'greeting', value: 'just me' }] },
      },
    ],
    connections: [{ from: 'n_trigger', to: 'n_set', output: 'main' }],
  });
  await page.goto(`/workflows/${id}`);
  await page.locator('.soldar-node', { hasText: 'Greet' }).click();
  await page.getByRole('button', { name: 'Run just this node' }).click();
  await expect(page.locator('.run-panel-status')).toHaveText('Finished, all good', {
    timeout: 30000,
  });
  await expect(page.locator('.run-step')).toHaveCount(1);
  await expect(page.locator('.run-step', { hasText: 'Greet' })).toBeVisible();
});

test('duplicate, export, and import a workflow from the list', async ({ page }) => {
  const id = await createWorkflow(page, 'Copy me flow');
  await saveWorkflow(page, id, {
    id,
    name: 'Copy me flow',
    active: false,
    nodes: [
      { id: 'n_trigger', type: 'manual-trigger', name: 'Start', position: [100, 100], parameters: {} },
      {
        id: 'n_set',
        type: 'set',
        name: 'Greet',
        position: [350, 100],
        parameters: { values: [{ name: 'greeting', value: 'hi' }] },
      },
    ],
    connections: [{ from: 'n_trigger', to: 'n_set', output: 'main' }],
  });

  await page.goto('/');
  // The name match must be exact: 'Copy of Copy me flow' also contains
  // the original name, so a substring match would find two rows.
  const row = page.locator('.workflow-row').filter({
    has: page.locator('.workflow-row-name', { hasText: /^Copy me flow$/ }),
  });
  await expect(row).toBeVisible();

  // Duplicate.
  await row.getByRole('button', { name: 'Duplicate' }).click();
  await expect(
    page.locator('.workflow-row-name', { hasText: 'Copy of Copy me flow' }),
  ).toBeVisible();

  // Export downloads the workflow JSON.
  const downloadPromise = page.waitForEvent('download');
  await row.getByRole('button', { name: 'Export' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('Copy-me-flow.soldar.json');
  const path = await download.path();
  const exported = JSON.parse(
    await import('node:fs/promises').then((fs) => fs.readFile(path!, 'utf-8')),
  ) as { name: string; nodes: unknown[] };
  expect(exported.name).toBe('Copy me flow');
  expect(exported.nodes).toHaveLength(2);

  // Import the same file back: a new workflow appears and opens.
  await page.setInputFiles('input[type="file"]', {
    name: 'imported.soldar.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(exported)),
  });
  await expect(page.locator('.editor-name')).toHaveValue('Copy me flow 2');
});

test('the Runs view shows totals and deletes one run', async ({ page }) => {
  const id = await createWorkflow(page, 'Runs delete flow');
  await saveWorkflow(page, id, {
    id,
    name: 'Runs delete flow',
    active: false,
    nodes: [
      { id: 'n_trigger', type: 'manual-trigger', name: 'Start', position: [100, 100], parameters: {} },
      {
        id: 'n_set',
        type: 'set',
        name: 'Greet',
        position: [350, 100],
        parameters: { values: [{ name: 'x', value: 1 }] },
      },
    ],
    connections: [{ from: 'n_trigger', to: 'n_set', output: 'main' }],
  });
  const run = await page.request.post(`/api/workflows/${id}/run`);
  expect(run.ok()).toBeTruthy();
  const { executionId } = (await run.json()) as { executionId: string };
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`/api/executions/${executionId}`);
        const body = (await res.json()) as { execution: { status: string } };
        return body.execution.status;
      },
      { timeout: 30000 },
    )
    .toBe('success');

  await page.goto('/executions');
  // The stats cover every run in the database, and the suite shares one
  // (tests run in parallel), so the expected totals come from the API.
  const all = await page.request.get('/api/executions?limit=200');
  // The list route returns a bare array, like /api/workflows.
  const executions = (await all.json()) as { status: string }[];
  const good = executions.filter((e) => e.status === 'success').length;
  await expect(page.locator('.runs-stats')).toContainText(
    `${executions.length} run${executions.length === 1 ? '' : 's'}`,
  );
  await expect(page.locator('.runs-stats')).toContainText(`${good} good`);
  const row = page.locator('.runs-row', { hasText: 'Runs delete flow' });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Delete this run' }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('button', { name: 'Delete it' }).click();
  await expect(page.locator('.runs-row', { hasText: 'Runs delete flow' })).toHaveCount(0);
});

test('the workflow settings SSRF opt-out saves and persists', async ({ page }) => {
  const id = await createWorkflow(page, 'Settings flow');
  await page.goto(`/workflows/${id}`);
  await page.getByRole('button', { name: 'Workflow settings' }).click();
  // The checkbox itself is visually hidden (a custom toggle track shows
  // instead), so the label is clicked and the state is asserted.
  await page.locator('.workflow-settings .field-toggle').click();
  await expect(
    page.locator('.workflow-settings input[type="checkbox"]'),
  ).toBeChecked();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.editor-dirty')).toHaveCount(0);

  const res = await page.request.get(`/api/workflows/${id}`);
  const body = (await res.json()) as {
    workflow: { settings?: { allowPrivateAddresses?: boolean } };
  };
  expect(body.workflow.settings?.allowPrivateAddresses).toBe(true);

  await page.reload();
  await page.getByRole('button', { name: 'Workflow settings' }).click();
  await expect(
    page.locator('.workflow-settings input[type="checkbox"]'),
  ).toBeChecked();
});

test('Help explains IF outputs and the Active switch', async ({ page }) => {
  await page.goto('/help');
  await expect(page.locator('.help')).toContainText('true output');
  await expect(page.locator('.help')).toContainText('runs on its own');
  await expect(page.locator('.help')).toContainText('$input.all()');
});
