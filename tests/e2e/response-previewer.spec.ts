import { expect, test, type Page } from '@playwright/test';
import {
  createDownloadResponse,
  createImageResponse,
  createMockRequest,
  createResponseResult,
  createTextResponse,
  installMockApi,
} from './fixtures/mockApi';

const request = createMockRequest({
  id: 'preview-request',
  name: 'Preview states',
  url: 'https://example.test/preview',
});

async function openPreview(page: Page, responses: ReturnType<typeof createResponseResult>[]) {
  await installMockApi(page, { nodes: [request], responses });
  await page.goto('/');
  await page.getByText('Preview states').click();
}

test.describe('response previewer', () => {
  test('renders safe JSON, source previews, and honest truncation without executing markup', async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await openPreview(page, [
      createResponseResult(createTextResponse({
        id: 'complete-json-response',
        requestId: request.id,
        text: '{"safe":true}',
        format: 'json',
        parseState: 'valid',
        headers: [{ key: 'content-type', value: 'application/json', enabled: true }],
      })),
      createResponseResult(createTextResponse({
        id: 'truncated-json-response',
        requestId: request.id,
        text: '{"partial":true',
        format: 'json',
        parseState: 'unparsed',
        truncated: true,
        completeness: 'truncated',
        capturedBytes: 15,
        totalBytes: 99,
        headers: [{ key: 'content-type', value: 'application/json', enabled: true }],
      })),
      createResponseResult(createTextResponse({
        id: 'invalid-json-response',
        requestId: request.id,
        text: '{not valid json}',
        format: 'json',
        parseState: 'invalid',
        headers: [{ key: 'content-type', value: 'application/json', enabled: true }],
      })),
      createResponseResult(createTextResponse({
        id: 'over-budget-json-response',
        requestId: request.id,
        text: '{"deep":true}',
        format: 'json',
        parseState: 'over-budget',
        headers: [{ key: 'content-type', value: 'application/json', enabled: true }],
      })),
      createResponseResult(createTextResponse({
        id: 'xml-response',
        requestId: request.id,
        text: '<root><child>xml</child></root>',
        format: 'xml',
        headers: [{ key: 'content-type', value: 'application/xml', enabled: true }],
      })),
      createResponseResult(createTextResponse({
        id: 'html-response',
        requestId: request.id,
        text: '<script>window.active=true</script>',
        format: 'html',
        headers: [{ key: 'content-type', value: 'text/html', enabled: true }],
      })),
      createResponseResult(createTextResponse({
        id: 'svg-response',
        requestId: request.id,
        text: '<svg><script>window.active=true</script></svg>',
        format: 'svg',
        headers: [{ key: 'content-type', value: 'image/svg+xml', enabled: true }],
      })),
    ]);

    const sendButton = page.getByRole('button', { name: 'Send', exact: true });

    await sendButton.click();
    await expect(page.getByTestId('response-json-viewer')).toBeVisible();
    await expect(page.getByTestId('response-truncated')).toHaveCount(0);
    if (process.env.EVIDENCE_DIR) await page.screenshot({ path: `${process.env.EVIDENCE_DIR}/task-11-complete-json.png` });

    await sendButton.click();
    await expect(page.getByTestId('response-json-tree-fallback-reason')).toBeVisible();
    await expect(page.getByTestId('response-json-tree-fallback-reason')).toContainText('preview limit');
    await expect(page.getByTestId('response-truncated')).toHaveCount(0);
    await expect(page.getByTestId('response-source-preview')).toContainText('{"partial":true');
    if (process.env.EVIDENCE_DIR) await page.screenshot({ path: `${process.env.EVIDENCE_DIR}/task-11-truncated-source.png` });

    await sendButton.click();
    await expect(page.getByTestId('response-json-tree-fallback-reason')).toContainText("isn't valid JSON");
    await expect(page.getByTestId('response-source-preview')).toContainText('{not valid json}');

    await sendButton.click();
    await expect(page.getByTestId('response-json-tree-fallback-reason')).toContainText('node or 64-level nesting');
    await expect(page.getByTestId('response-source-preview')).toContainText('{"deep":true}');

    await sendButton.click();
    await expect(page.getByTestId('response-source-preview')).toContainText('<root><child>xml</child></root>');

    await sendButton.click();
    await expect(page.getByTestId('response-source-preview')).toContainText('<script>window.active=true</script>');
    await expect.poll(() => page.evaluate(() => (window as Window & { active?: boolean }).active)).toBeUndefined();

    await sendButton.click();
    await expect(page.getByTestId('response-source-preview')).toContainText('<svg><script>window.active=true</script></svg>');
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test('shows clipboard feedback for complete and truncated text previews', async ({ page }) => {
    await page.addInitScript(() => {
      const writes: string[] = [];
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text: string) => { writes.push(text); },
        },
      });
      (window as Window & { __clipboardWrites?: string[] }).__clipboardWrites = writes;
    });

    await openPreview(page, [
      createResponseResult(createTextResponse({
        id: 'complete-text-response',
        requestId: request.id,
        text: 'hello world',
        format: 'text',
        headers: [{ key: 'content-type', value: 'text/plain', enabled: true }],
      })),
      createResponseResult(createTextResponse({
        id: 'truncated-text-response',
        requestId: request.id,
        text: 'abcdefghijklmnopqrstuvwxyz',
        format: 'text',
        truncated: true,
        completeness: 'truncated',
        capturedBytes: 10,
        totalBytes: 26,
        headers: [{ key: 'content-type', value: 'text/plain', enabled: true }],
      })),
    ]);

    const sendButton = page.getByRole('button', { name: 'Send', exact: true });
    await sendButton.click();
    await expect(page.getByRole('button', { name: 'Copy body', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Copy body', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Copied');

    await sendButton.click();
    await expect(page.getByRole('button', { name: 'Copy preview', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Copy preview', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Copied');
    if (process.env.EVIDENCE_DIR) await page.screenshot({ path: `${process.env.EVIDENCE_DIR}/task-11-copy-truncation.png` });
  });

  test('reports clipboard rejection when copy fails', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async () => { throw new Error('clipboard denied'); },
        },
      });
    });

    await openPreview(page, [
      createResponseResult(createTextResponse({
        id: 'clipboard-failure-response',
        requestId: request.id,
        text: 'copy me',
        format: 'text',
        headers: [{ key: 'content-type', value: 'text/plain', enabled: true }],
      })),
    ]);

    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('button', { name: 'Copy body', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Copy failed');
  });

  test('renders validated raster, corrupt raster fallback, and download states', async ({ page }) => {
    const validImageBase64 = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas context unavailable');
      context.fillStyle = '#ff00ff';
      context.fillRect(0, 0, 1, 1);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    const validImageBytes = Uint8Array.from(Buffer.from(validImageBase64, 'base64'));

    await openPreview(page, [
      createResponseResult(createImageResponse({
        id: 'raster-response',
        requestId: request.id,
        mediaType: 'image/png',
        bytes: validImageBytes,
      })),
      createResponseResult(createImageResponse({
        id: 'corrupt-raster-response',
        requestId: request.id,
        mediaType: 'image/png',
        bytes: new Uint8Array([0, 1, 2, 3, 4, 5]),
      })),
      createResponseResult(createDownloadResponse({
        id: 'awaiting-response',
        requestId: request.id,
        mediaType: 'application/pdf',
        state: 'awaiting-destination',
        reason: 'unsupported-media-type',
        receivedBytes: 100,
        suggestedFileName: 'document.pdf',
      }), 'download'),
      createResponseResult(createDownloadResponse({
        id: 'downloading-response',
        requestId: request.id,
        mediaType: 'application/pdf',
        state: 'downloading',
        reason: 'unsupported-media-type',
        receivedBytes: 100,
        suggestedFileName: 'document.pdf',
      }), 'download'),
      createResponseResult(createDownloadResponse({
        id: 'publishing-response',
        requestId: request.id,
        mediaType: 'application/pdf',
        state: 'publishing',
        reason: 'unsupported-media-type',
        receivedBytes: 100,
        suggestedFileName: 'document.pdf',
      }), 'download'),
      createResponseResult(createDownloadResponse({
        id: 'saved-response',
        requestId: request.id,
        mediaType: 'application/pdf',
        state: 'saved',
        reason: 'unsupported-media-type',
        receivedBytes: 100,
        suggestedFileName: 'document.pdf',
      }), 'download'),
      createResponseResult(createDownloadResponse({
        id: 'cancelled-response',
        requestId: request.id,
        mediaType: 'application/pdf',
        state: 'cancelled',
        reason: 'unsupported-media-type',
        receivedBytes: 100,
        suggestedFileName: 'document.pdf',
      }), 'download'),
      createResponseResult(createDownloadResponse({
        id: 'failed-response',
        requestId: request.id,
        mediaType: 'application/pdf',
        state: 'failed',
        reason: 'unsupported-media-type',
        receivedBytes: 100,
        suggestedFileName: 'document.pdf',
        failure: { code: 'disk-full', message: 'Download failed.' },
      }), 'download'),
    ]);

    const sendButton = page.getByRole('button', { name: 'Send', exact: true });

    await sendButton.click();
    const rasterProbe = await page.evaluate(async () => {
      const result = (window as Window & { __mockApi?: { lastResult?: unknown } }).__mockApi?.lastResult as {
        response?: {
          preview?: unknown;
        };
      } | undefined;
      const preview = result?.response?.preview as {
        kind?: string;
        mediaType?: string;
        bytes?: Uint8Array;
      } | undefined;
      if (!preview || preview.kind !== 'image' || !preview.mediaType || !preview.bytes) {
        return { kind: preview?.kind ?? null, mediaType: preview?.mediaType ?? null, byteLength: 0, loaded: false };
      }
      const bytes = new Uint8Array(preview.bytes);
      let binary = '';
      const chunkSize = 0x8000;
      for (let index = 0; index < bytes.length; index += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
      }
      const source = `data:${preview.mediaType};base64,${btoa(binary)}`;
      const loaded = await new Promise<boolean>((resolve) => {
        const image = new Image();
        image.onload = () => resolve(true);
        image.onerror = () => resolve(false);
        image.src = source;
      });
      return { kind: preview.kind, mediaType: preview.mediaType, byteLength: bytes.byteLength, loaded };
    });
    expect(rasterProbe).toEqual(expect.objectContaining({ kind: 'image', mediaType: 'image/png' }));
    expect(rasterProbe.byteLength).toBeGreaterThan(0);
    expect(rasterProbe.loaded).toBe(true);
    await expect(page.getByTestId('response-image-preview')).toBeVisible();

    await sendButton.click();
    await expect(page.getByTestId('response-image-preview')).toBeVisible();
    await expect(page.getByText('Image preview unavailable.')).toBeVisible();
    await expect(page.getByTestId('download-progress')).toHaveCount(0);

    for (const state of ['awaiting-destination', 'downloading', 'publishing', 'saved', 'cancelled', 'failed'] as const) {
      await sendButton.click();
      await expect(page.getByTestId('response-image-preview')).toHaveCount(0);
      await expect(page.getByTestId('download-progress')).toContainText(state);
    }

    if (process.env.EVIDENCE_DIR) await page.screenshot({ path: `${process.env.EVIDENCE_DIR}/task-11-download-progress.png` });
  });
});
