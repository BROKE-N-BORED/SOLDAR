import { expect, test } from '@playwright/test';

// End-to-end proof of Phase 2: build a workflow in the browser, run it,
// watch the nodes go green. Runs against the production build (see
// playwright.config.ts); run `pnpm build` from the repo root first.

test('build a workflow in the browser and run it green', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Workflows' })).toBeVisible();

  // Make a workflow.
  await page.getByRole('button', { name: 'New workflow' }).click();
  await page.getByLabel('Name your workflow').fill('Playwright flow');
  await page.getByRole('button', { name: 'Make it' }).click();
  await expect(page.locator('.editor-name')).toHaveValue('Playwright flow');

  // Add three nodes by clicking the palette.
  await page.locator('.palette-item', { hasText: 'Manual Trigger' }).click();
  await page.locator('.palette-item', { hasText: 'Set' }).click();
  await page.locator('.palette-item', { hasText: 'Code' }).click();
  await expect(page.locator('.soldar-node')).toHaveCount(3);

  // Connect them: drag each source handle onto the next node's target handle.
  const nodes = page.locator('.vue-flow__node');
  const sourceOf = (i: number) =>
    nodes.nth(i).locator('.vue-flow__handle.source').first();
  const targetOf = (i: number) =>
    nodes.nth(i).locator('.vue-flow__handle.target').first();
  await sourceOf(0).dragTo(targetOf(1));
  await sourceOf(1).dragTo(targetOf(2));
  await expect(page.locator('.vue-flow__edge')).toHaveCount(2);

  // Set a value on the Set node.
  await page.locator('.soldar-node', { hasText: 'Set' }).click();
  await expect(page.locator('.settings-title')).toHaveText('Set');
  await page.getByRole('button', { name: 'Add a row' }).click();
  await page.getByLabel('Field name').fill('greeting');
  await page.getByLabel('Field value').fill('hello from the browser');

  // Run it. Run saves first, so no separate save is needed.
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.locator('.soldar-node.status-success')).toHaveCount(3, {
    timeout: 30000,
  });
  await expect(page.locator('.run-panel-status')).toHaveText('Finished, all good');

  // The Set node's output carries the value we typed.
  const setStep = page.locator('.run-step', { hasText: 'Set' });
  await setStep.locator('.run-step-head').click();
  await expect(setStep).toContainText('hello from the browser');
});

test('a finished run shows up in the Runs list', async ({ page }) => {
  // Build + run a small workflow through the API, then check the UI.
  const created = await page.request.post('/api/workflows', {
    data: { name: 'Runs page flow' },
  });
  expect(created.ok()).toBeTruthy();
  const { workflow } = (await created.json()) as {
    workflow: { id: string };
  };
  const saved = await page.request.put(`/api/workflows/${workflow.id}`, {
    data: {
      id: workflow.id,
      name: 'Runs page flow',
      active: false,
      nodes: [
        {
          id: 'n_trigger',
          type: 'manual-trigger',
          name: 'Manual Trigger',
          position: [100, 100],
          parameters: {},
        },
        {
          id: 'n_set',
          type: 'set',
          name: 'Set',
          position: [400, 100],
          parameters: { values: [{ name: 'x', value: 1 }] },
        },
      ],
      connections: [{ from: 'n_trigger', to: 'n_set', output: 'main' }],
    },
  });
  expect(saved.ok()).toBeTruthy();
  const run = await page.request.post(`/api/workflows/${workflow.id}/run`);
  expect(run.ok()).toBeTruthy();
  const { executionId } = (await run.json()) as { executionId: string };
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`/api/executions/${executionId}`);
        const body = (await res.json()) as {
          execution: { status: string };
        };
        return body.execution.status;
      },
      { timeout: 30000 },
    )
    .toBe('success');

  await page.goto('/executions');
  const row = page.locator('.runs-row', { hasText: 'Runs page flow' });
  await expect(row).toBeVisible();
  await expect(row.locator('.runs-row-status')).toHaveText('success');
  await row.click();
  await expect(page.locator('.run-panel-status')).toHaveText('Finished, all good');
});

test('leaving the editor with unsaved changes asks first', async ({ page }) => {
  const created = await page.request.post('/api/workflows', {
    data: { name: 'Guard flow' },
  });
  expect(created.ok()).toBeTruthy();
  const { workflow } = (await created.json()) as {
    workflow: { id: string };
  };
  await page.goto(`/workflows/${workflow.id}`);
  await expect(page.locator('.editor-name')).toHaveValue('Guard flow');

  // Make an unsaved change.
  await page.locator('.palette-item', { hasText: 'Set' }).click();
  await expect(page.locator('.editor-dirty')).toBeVisible();

  // Try to leave: the dialog appears, and staying keeps the editor open.
  await page.getByRole('link', { name: 'Runs' }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('button', { name: 'Keep editing' }).click();
  await expect(page).toHaveURL(new RegExp(`/workflows/${workflow.id}`));
  await expect(page.locator('.editor-dirty')).toBeVisible();

  // Try again and leave: the navigation goes through.
  await page.getByRole('link', { name: 'Runs' }).click();
  await expect(page.getByRole('alertdialog')).toBeVisible();
  await page.getByRole('button', { name: 'Leave without saving' }).click();
  await expect(page).toHaveURL(/\/executions$/);
});

test('reloading with unsaved changes shows the browser prompt', async ({ page }) => {
  const created = await page.request.post('/api/workflows', {
    data: { name: 'Reload guard flow' },
  });
  expect(created.ok()).toBeTruthy();
  const { workflow } = (await created.json()) as {
    workflow: { id: string };
  };
  await page.goto(`/workflows/${workflow.id}`);
  await expect(page.locator('.editor-name')).toHaveValue('Reload guard flow');

  // Make an unsaved change (the click is also the user gesture browsers
  // want before they show the beforeunload prompt).
  await page.locator('.palette-item', { hasText: 'Set' }).click();
  await expect(page.locator('.editor-dirty')).toBeVisible();

  // Reload: the browser prompt must appear. Accept it so the reload goes
  // through; the unsaved node is gone afterwards, as expected.
  let sawPrompt = false;
  page.on('dialog', (dialog) => {
    expect(dialog.type()).toBe('beforeunload');
    sawPrompt = true;
    void dialog.accept();
  });
  await page.reload();
  expect(sawPrompt).toBe(true);
  await expect(page.locator('.editor-name')).toHaveValue('Reload guard flow');
  await expect(page.locator('.editor-dirty')).toHaveCount(0);
});
