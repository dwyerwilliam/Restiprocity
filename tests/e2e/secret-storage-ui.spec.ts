import { expect, test } from '@playwright/test';
import { createMockRequest, installMockApi } from './fixtures/mockApi';

test.describe('Secret & Confidential Storage UI', () => {
  test('displays Standard, Confidential, and Secret types in the environment editor', async ({ page }) => {
    await installMockApi(page, {
      environments: [
        {
          id: 'core',
          name: 'Core',
          variables: [
            { key: 'plainVar', value: 'my-value', type: 'standard' },
            { key: 'confVar', value: 'confidential_key', type: 'confidential' },
            { key: 'encVar', value: '••••••••', type: 'secret' },
          ],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      activeEnvironmentId: 'core',
    });

    await page.goto('/');
    await page.getByRole('button', { name: 'Edit selected environment' }).click();

    const editor = page.getByTestId('environment-editor');
    await expect(editor).toBeVisible();

    // Check type selector options for the first variable
    const typeSelect = editor.getByLabel('Variable type 1');
    await expect(typeSelect).toBeVisible();
    const options = await typeSelect.locator('option').allInnerTexts();
    expect(options).toEqual(['Standard · plain text', 'Confidential · masked, plain text on disk', 'Secret · encrypted at rest']);

    // Variable 2 is confidential: masked with password type
    const val2 = editor.getByLabel('Variable value 2');
    await expect(val2).toHaveAttribute('type', 'password');

    // Clicking "Show" reveals the confidential value
    const showBtn = editor.getByLabel('Show secret 2');
    await expect(showBtn).toBeVisible();
    await showBtn.click();

    await expect(val2).toHaveAttribute('type', 'text');
    await expect(editor.getByLabel('Hide secret 2')).toBeVisible();

    // Clicking "Hide" re-masks it
    await editor.getByLabel('Hide secret 2').click();
    await expect(val2).toHaveAttribute('type', 'password');
  });

  test('masks URL preview when referencing confidential or secret variables', async ({ page }) => {
    const req = createMockRequest({
      id: 'req-1',
      name: 'Test Request',
      url: 'https://api.example.com/items?token={{apiSecret}}',
    });

    await installMockApi(page, {
      environments: [
        {
          id: 'core',
          name: 'Core',
          variables: [
            { key: 'apiSecret', value: 'secret_token_123', type: 'confidential' },
          ],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      activeEnvironmentId: 'core',
      nodes: [req],
    });

    await page.goto('/');

    // URL preview should be masked because {{apiSecret}} is confidential
    const preview = page.getByTestId('request-url-preview');
    await expect(preview).toBeVisible();
    await expect(preview).toContainText('••••••••');
  });
});
