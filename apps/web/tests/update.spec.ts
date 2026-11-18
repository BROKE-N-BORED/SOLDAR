// The update dialog, tested with stubbed API answers: the e2e server
// never phones GitHub (SOLDAR_NO_UPDATE_CHECK=1 in the Playwright
// config), so these tests stand in the server's answers instead.
import { expect, test } from '@playwright/test';

const baseStatus = {
  current: '0.3.0',
  state: 'current',
  latest: '0.3.0',
  url: 'https://github.com/BROKE-N-BORED/SOLDAR/releases',
  installable: false,
  stagedVersion: null,
  checking: false,
  downloading: false,
};

test('no dialog when Soldar is up to date', async ({ page }) => {
  await page.route('**/api/update/status', (route) =>
    route.fulfill({ json: baseStatus }),
  );
  await page.goto('/');
  await page.waitForTimeout(1500);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
});

test('a newer release shows the dialog, and Not now closes it', async ({ page }) => {
  await page.route('**/api/update/status', (route) =>
    route.fulfill({
      json: { ...baseStatus, state: 'newer', latest: '0.4.0', installable: true },
    }),
  );
  await page.goto('/');
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Soldar 0.4.0 is out');
  await expect(dialog).toContainText('You have 0.3.0');
  await dialog.getByRole('button', { name: 'Not now' }).click();
  await expect(dialog).toHaveCount(0);
  // It does not nag again this session.
  await page.waitForTimeout(1000);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
});

test('a newer release with no checksum offers the release page, not an install', async ({ page }) => {
  await page.route('**/api/update/status', (route) =>
    route.fulfill({
      json: {
        ...baseStatus,
        state: 'newer',
        latest: '0.4.0',
        installable: false,
        url: 'https://github.com/BROKE-N-BORED/SOLDAR/releases/tag/v0.4.0',
      },
    }),
  );
  await page.goto('/');
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('no checksum published');
  await expect(dialog.getByRole('button', { name: 'Update now' })).toHaveCount(0);
  await expect(dialog.getByRole('link', { name: 'Open the release page' })).toHaveAttribute(
    'href',
    'https://github.com/BROKE-N-BORED/SOLDAR/releases/tag/v0.4.0',
  );
});

test('Update now downloads and asks about restarting', async ({ page }) => {
  let downloaded = false;
  await page.route('**/api/update/status', (route) =>
    route.fulfill({
      json: downloaded
        ? { ...baseStatus, state: 'newer', latest: '0.4.0', installable: true, stagedVersion: '0.4.0' }
        : { ...baseStatus, state: 'newer', latest: '0.4.0', installable: true },
    }),
  );
  await page.route('**/api/update/download', (route) => {
    downloaded = true;
    return route.fulfill({
      json: { ...baseStatus, state: 'newer', latest: '0.4.0', installable: true, stagedVersion: '0.4.0' },
    });
  });
  await page.goto('/');
  const dialog = page.getByRole('alertdialog');
  await dialog.getByRole('button', { name: 'Update now' }).click();
  await expect(dialog).toContainText('Update ready');
  await expect(dialog).toContainText('Soldar 0.4.0 is downloaded and checked');
  await expect(dialog.getByRole('button', { name: 'Restart now' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Later' })).toBeVisible();
});

test('a staged update opens the restart dialog on load', async ({ page }) => {
  await page.route('**/api/update/status', (route) =>
    route.fulfill({
      json: { ...baseStatus, state: 'newer', latest: '0.4.0', installable: true, stagedVersion: '0.4.0' },
    }),
  );
  await page.goto('/');
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Update ready');
  await dialog.getByRole('button', { name: 'Later' }).click();
  await expect(dialog).toHaveCount(0);
});

test('the Help page shows the version and checks on demand', async ({ page }) => {
  await page.route('**/api/update/status', (route) =>
    route.fulfill({ json: baseStatus }),
  );
  await page.route('**/api/update/check', (route) =>
    route.fulfill({ json: baseStatus }),
  );
  await page.goto('/help');
  await expect(page.getByText('You are running Soldar 0.3.0.')).toBeVisible();
  await page.getByRole('button', { name: 'Check for updates' }).click();
  await expect(page.getByRole('status')).toContainText('You have the newest version.');
});
