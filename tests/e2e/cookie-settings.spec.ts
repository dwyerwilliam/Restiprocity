import { expect, test } from '@playwright/test';
import { createMockRequest, installMockApi } from './fixtures/mockApi';

const unrelatedSettings = {
  followRedirect: false,
  timeout: 12345,
  allowInsecureCertificates: true,
  userAgent: 'Cookie setting test',
  proxy: { host: 'proxy.example.test', port: 8080 },
};

test('cookie jar setting persists across switches and reload and controls the send payload', async ({ page }, testInfo) => {
  const request = createMockRequest({
    id: 'cookie-settings-request', name: 'Cookie settings',
    settings: { ...unrelatedSettings, cookiesEnabled: true },
    headers: [{ key: 'Cookie', value: 'authored=explicit', enabled: true }],
  });
  const other = createMockRequest({ id: 'other-request', name: 'Other request' });
  await installMockApi(page, { nodes: [request, other], persistCollection: true });
  await page.goto('/');
  await page.getByTestId('sidebar').getByText(request.name, { exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const toggle = page.getByRole('checkbox', { name: 'Use session cookie jar', exact: true });
  await expect(toggle).toBeChecked();
  await page.getByRole('checkbox', { name: 'Allow insecure certificates', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(toggle).toBeFocused();
  await page.keyboard.press('Space');
  await expect(toggle).not.toBeChecked();
  await expect.poll(() => page.evaluate(() => window.api.collectionExport('cookie-settings-request'))).toMatchObject({
    settings: { ...unrelatedSettings, cookiesEnabled: false },
  });
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const payload: unknown = Reflect.get(window, '__lastSendRequest');
    return payload;
  })).toMatchObject({ request: { settings: { ...unrelatedSettings, cookiesEnabled: false }, headers: request.headers } });
  const disabledPayload: unknown = await page.evaluate(() => Reflect.get(window, '__lastSendRequest'));
  await page.getByTestId('sidebar').getByText(other.name, { exact: true }).click();
  await expect(toggle).toBeChecked();
  await page.getByTestId('sidebar').getByText(request.name, { exact: true }).click();
  await expect(toggle).not.toBeChecked();
  await page.reload();
  await page.getByTestId('sidebar').getByText(request.name, { exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(toggle).not.toBeChecked();
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(toggle).toBeChecked();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const payload: unknown = Reflect.get(window, '__lastSendRequest');
    return payload;
  })).toMatchObject({ request: { settings: { ...unrelatedSettings, cookiesEnabled: true }, headers: request.headers } });
  await testInfo.attach('cookie-setting-payloads', {
    body: JSON.stringify({ disabledPayload, enabledPayload: await page.evaluate(() => Reflect.get(window, '__lastSendRequest')) }),
    contentType: 'application/json',
  });
  if (process.env.EVIDENCE_DIR) await page.screenshot({ path: `${process.env.EVIDENCE_DIR}/task-12-settings.png` });
});

test('cookie jar setting defaults enabled for old requests missing the flag', async ({ page }) => {
  const request = createMockRequest({ id: 'legacy-cookie-request', name: 'Legacy cookie settings' });
  await installMockApi(page, { nodes: [request] });
  await page.addInitScript(() => {
    const originalList = window.api.collectionList;
    window.api.collectionList = async () => {
      const result = await originalList();
      for (const node of result.nodes) {
        if ('settings' in node && typeof node.settings === 'object' && node.settings !== null) {
          Reflect.deleteProperty(node.settings, 'cookiesEnabled');
        }
      }
      return result;
    };
  });
  await page.goto('/');
  await page.getByTestId('sidebar').getByText(request.name, { exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByTestId('request-cookies-enabled')).toBeChecked();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const payload: unknown = Reflect.get(window, '__lastSendRequest');
    return payload;
  })).toMatchObject({ request: { settings: { cookiesEnabled: true } } });
});
