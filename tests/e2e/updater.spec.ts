import { expect, test } from '@playwright/test';
import { installMockApi, createMockGroup, createMockRequest } from './fixtures/mockApi';
import type { UpdateStatus } from '../../src/shared/types';

const currentVersion = '0.2.2';
const latestVersion = '0.3.0';

const statuses: Record<string, UpdateStatus> = {
  unsupported: { kind: 'unsupported', currentVersion },
  'no-update': { kind: 'no-update', currentVersion, latestVersion: currentVersion },
  available: { kind: 'available', currentVersion, latestVersion },
  downloading: {
    kind: 'downloading', currentVersion, latestVersion,
    progress: { bytesPerSecond: 1024, percent: 42, total: 1000, transferred: 420 },
  },
  downloaded: { kind: 'downloaded', currentVersion, latestVersion },
  error: { kind: 'error', currentVersion, stage: 'download', message: 'Asset unavailable', retryable: true },
};

function installUpdaterMock(page: Parameters<typeof installMockApi>[0], status: UpdateStatus) {
  return installMockApi(page, {
    nodes: [createMockGroup({ id: 'group-1', name: 'Workspace', children: ['request-1'] }), createMockRequest({ id: 'request-1', name: 'GET /health' })],
    updateStatus: status,
    updateCheckResult: status,
    updateApplyResult: status,
  });
}

test.describe('Updater status bar', () => {
  for (const [name, status] of Object.entries(statuses)) {
    test(`${name} state is visible without live update services`, async ({ page }) => {
      await installUpdaterMock(page, status);
      await page.goto('/');

      await expect(page.getByText(`Restiprocity v${currentVersion}`)).toBeVisible();
      await expect(page.getByText('SQLite Ready')).toBeVisible();

      if (name === 'unsupported') {
        await expect(page.getByText(/Update|Checking|Downloading|up to date/i)).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Restart to update' })).toHaveCount(0);
        return;
      }

      if (name === 'no-update') await expect(page.getByText(`You’re up to date (v${currentVersion})`)).toBeVisible();
      if (name === 'available') await expect(page.getByText(`Update v${latestVersion} available · downloading automatically`)).toBeVisible();
      if (name === 'downloading') await expect(page.getByText(`Downloading v${latestVersion} · 42%`)).toBeVisible();
      if (name === 'downloaded') {
        await expect(page.getByText(`Update v${latestVersion} ready · UAC may show “Unknown publisher”`)).toBeVisible();
        await expect(page.getByRole('button', { name: 'Restart to update' })).toBeVisible();
      } else {
        await expect(page.getByRole('button', { name: 'Restart to update' })).toHaveCount(0);
      }
      if (name === 'error') await expect(page.getByText('Update download failed: Asset unavailable')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Download' })).toHaveCount(0);
    });
  }
});

test('downloaded state applies only through restart action', async ({ page }) => {
  const downloaded = statuses.downloaded;
  const applied = { kind: 'installing', currentVersion, latestVersion } as UpdateStatus;
  await installMockApi(page, {
    nodes: [createMockRequest({ id: 'request-1', name: 'GET /health' })],
    updateStatus: downloaded,
    updateApplyResult: applied,
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Restart to update' }).click();
  await expect(page.getByText('Installing update…')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__mockApi.updateApplyAttempts)).toBe(1);
});
