import { test, expect } from '@playwright/test';

test.describe('NTLM Auth — Use Current Auth Context', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      const group = {
        id: 'group-1',
        type: 'group',
        name: 'Internal API',
        children: ['req-ntlm'],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      const ntlmRequest = {
        id: 'req-ntlm',
        type: 'request',
        name: 'GET /internal',
        method: 'GET',
        url: 'https://internal.example.com/api',
        headers: [],
        parameters: [],
        body: { type: 'none' },
        auth: { type: 'none' },
        settings: { followRedirect: true, timeout: 30000, cookiesEnabled: true },
        scripts: {},
        children: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      (window as any).api = {
        collectionList: async () => ({
          nodes: [group, ntlmRequest],
        }),
        envList: async () => [
          { id: 'env-base', name: 'Base Environment', variables: {} },
        ],
        collectionCreate: async () => null,
        collectionDelete: async () => {},
        collectionUpdate: async (_id: string, payload: unknown) => {
          (window as any).__lastCollectionUpdate = { id: _id, payload };
          return null;
        },
        collectionDuplicate: async () => null,
        envSwitch: async () => {},
        sendRequest: async () => null,
        requestCancel: async () => {},
        onConsoleLog: () => {},
      };
    });

    await page.goto('/');
    await page.getByText('GET /internal').first().click();
    await page.getByRole('button', { name: 'Auth' }).click();
  });

  test('NTLM auth type can be selected', async ({ page }) => {
    await page.locator('select').nth(1).selectOption('ntlm');

    // Should show NTLM-specific fields
    await expect(page.getByText('Use current Windows auth context')).toBeVisible();
  });

  test('Use current auth context checkbox is checked by default', async ({ page }) => {
    await page.locator('select').nth(1).selectOption('ntlm');

    const checkbox = page.getByLabel('Use current Windows auth context');
    await expect(checkbox).toBeChecked();
  });

  test('manual credential fields are hidden when checkbox is checked', async ({ page }) => {
    await page.locator('select').nth(1).selectOption('ntlm');

    // Checkbox should be checked by default
    const checkbox = page.getByLabel('Use current Windows auth context');
    await expect(checkbox).toBeChecked();

    // Manual credential fields should be hidden
    await expect(page.getByPlaceholder('Username')).toBeHidden();
    await expect(page.getByPlaceholder('Domain (optional)')).toBeHidden();
    await expect(page.getByPlaceholder('Workstation (optional)')).toBeHidden();
    await expect(page.getByPlaceholder('Password')).toBeHidden();
  });

  test('manual credential fields appear when checkbox is unchecked', async ({ page }) => {
    await page.locator('select').nth(1).selectOption('ntlm');

    // Uncheck the checkbox
    const checkbox = page.getByLabel('Use current Windows auth context');
    await checkbox.click();
    await expect(checkbox).not.toBeChecked();

    // Manual credential fields should now be visible
    await expect(page.getByPlaceholder('Username')).toBeVisible();
    await expect(page.getByPlaceholder('Domain (optional)')).toBeVisible();
    await expect(page.getByPlaceholder('Workstation (optional)')).toBeVisible();
    await expect(page.getByPlaceholder('Password')).toBeVisible();
  });

  test('re-checking the checkbox hides manual credential fields', async ({ page }) => {
    await page.locator('select').nth(1).selectOption('ntlm');

    // Uncheck
    const checkbox = page.getByLabel('Use current Windows auth context');
    await checkbox.click();
    await expect(page.getByPlaceholder('Username')).toBeVisible();

    // Re-check
    await checkbox.click();
    await expect(checkbox).toBeChecked();
    await expect(page.getByPlaceholder('Username')).toBeHidden();
    await expect(page.getByPlaceholder('Password')).toBeHidden();
  });

  test('auth payload has useCurrentAuthContext true when checked', async ({ page }) => {
    await page.locator('select').nth(1).selectOption('ntlm');

    // Checkbox should be checked by default — wait for update to propagate
    await page.waitForTimeout(100);

    const authPayload = await page.evaluate(() => (window as any).__lastCollectionUpdate?.payload?.auth);
    expect(authPayload.type).toBe('ntlm');
    expect(authPayload.ntlm.useCurrentAuthContext).toBe(true);
    expect(authPayload.ntlm.username).toBeUndefined();
    expect(authPayload.ntlm.password).toBeUndefined();
  });

  test('auth payload has credentials when checkbox is unchecked and fields filled', async ({ page }) => {
    await page.locator('select').nth(1).selectOption('ntlm');

    // Uncheck
    const checkbox = page.getByLabel('Use current Windows auth context');
    await checkbox.click();
    await expect(checkbox).not.toBeChecked();

    // Fill credentials
    await page.getByPlaceholder('Username').fill('domain\\svc-account');
    await page.getByPlaceholder('Domain (optional)').fill('CORP');
    await page.getByPlaceholder('Workstation (optional)').fill('WORKSTATION01');
    await page.getByPlaceholder('Password').fill('super-secret');

    const authPayload = await page.evaluate(() => (window as any).__lastCollectionUpdate?.payload?.auth);
    expect(authPayload.type).toBe('ntlm');
    expect(authPayload.ntlm.useCurrentAuthContext).toBe(false);
    expect(authPayload.ntlm.username).toBe('domain\\svc-account');
    expect(authPayload.ntlm.domain).toBe('CORP');
    expect(authPayload.ntlm.workstation).toBe('WORKSTATION01');
  });

  test('toggling auth type away from NTLM and back preserves none auth', async ({ page }) => {
    await page.locator('select').nth(1).selectOption('ntlm');

    // Verify checkbox is checked by default
    await expect(page.getByLabel('Use current Windows auth context')).toBeChecked();

    // Switch to basic
    await page.locator('select').nth(1).selectOption('basic');
    await expect(page.getByPlaceholder('Username')).toBeVisible();
    await expect(page.getByLabel('Use current Windows auth context')).toBeHidden();

    // Switch back to NTLM
    await page.locator('select').nth(1).selectOption('ntlm');
    await expect(page.getByLabel('Use current Windows auth context')).toBeVisible();
  });
});
