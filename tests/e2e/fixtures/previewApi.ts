import type { Page } from '@playwright/test';
import type { RequestOperationPayload } from '../../../src/preload';
import type { Environment, Request, ResponseOperationProgressV2 } from '../../../src/shared/types';
import { installMockApi } from './mockApi';

export const previewRequest: Request = {
  id: 'preview-request',
  name: 'Dynamic Preview',
  method: 'POST',
  url: 'https://{{host}}/get/{{uuid}}/{{uuid}}/{{ timestamp }}/{{timestamp}}/{{randomInt}}/{{randomInt}}?unknown={{ missing }}&short=_.uuid&literal={{literal}}',
  headers: [{ key: 'X-Preview', value: '{{uuid}}', enabled: true }],
  parameters: [{ key: 'param-{{uuid}}', value: '{{ uuid }}/{{ timestamp }}/{{randomInt}}', enabled: true }],
  body: { type: 'raw', raw: { language: 'json', content: '{"id":"{{uuid}}","time":"{{timestamp}}"}' } },
  auth: { type: 'api_key', api_key: { key: 'auth-{{uuid}}', value: '{{uuid}}', in: 'query' } },
  settings: { followRedirect: true, timeout: 30_000, cookiesEnabled: true },
  scripts: {},
  createdAt: 1,
  updatedAt: 1,
};

export const previewEnvironments: Environment[] = [
  {
    id: 'core', name: 'Core', createdAt: 1, updatedAt: 1,
    variables: [
      { key: 'host', value: 'parent.example.test', type: 'standard' },
      { key: 'literal', value: '{{uuid}}', type: 'standard' },
      { key: 'uuid', value: 'environment-collision', type: 'standard' },
      { key: 'timestamp', value: 'environment-collision', type: 'standard' },
      { key: 'randomInt', value: 'environment-collision', type: 'standard' },
    ],
  },
  {
    id: 'preview-child', name: 'Preview Child', parentId: 'core', createdAt: 1, updatedAt: 1,
    variables: [{ key: 'host', value: 'child.example.test', type: 'standard' }],
  },
];

type PreviewHarness = {
  readonly sent: RequestOperationPayload[];
  readonly updates: { readonly id: string; readonly payload: Partial<Request> }[];
  readonly emitProgress: (progress: ResponseOperationProgressV2) => void;
};

declare global {
  interface Window {
    readonly __previewFixture: PreviewHarness;
  }
}

export async function installPreviewApi(page: Page, options: {
  readonly environments?: Environment[];
  readonly request?: Request;
  readonly sendMode?: 'immediate' | 'pending';
} = {}): Promise<void> {
  await installMockApi(page, {
    environments: options.environments ?? previewEnvironments,
    sendMode: options.sendMode ?? 'immediate',
  });
  await page.addInitScript((request: Request) => {
    const requests = new Map<string, Request>([
      [request.id, request],
      ['other-preview', {
        ...request, id: 'other-preview', name: 'Other Preview',
        url: 'https://example.test/other/{{uuid}}', parameters: [], auth: { type: 'none' }, body: { type: 'none' },
      }],
    ]);
    const sent: RequestOperationPayload[] = [];
    const updates: { id: string; payload: Partial<Request> }[] = [];
    const collectionListeners = new Set<() => void>();
    const progressListeners = new Set<(progress: ResponseOperationProgressV2) => void>();
    const sendRequest = window.api.sendRequest;
    Object.assign(window.api, {
      collectionList: async () => ({ nodes: structuredClone([...requests.values()]) }),
      collectionExport: async (id: string) => structuredClone(requests.get(id) ?? null),
      collectionUpdate: async (id: string, payload: Partial<Request>) => {
        const original = requests.get(id);
        if (!original) return null;
        const updated = { ...original, ...structuredClone(payload) };
        requests.set(id, updated);
        updates.push({ id, payload: structuredClone(payload) });
        for (const listener of collectionListeners) listener();
        return structuredClone(updated);
      },
      onCollectionChanged: (listener: () => void) => { collectionListeners.add(listener); },
      onRequestProgress: (listener: (progress: ResponseOperationProgressV2) => void) => {
        progressListeners.add(listener);
        return () => { progressListeners.delete(listener); };
      },
      sendRequest: async (payload: RequestOperationPayload) => {
        sent.push(structuredClone(payload));
        return sendRequest(payload);
      },
    });
    Object.defineProperty(window, '__previewFixture', {
      value: {
        sent, updates,
        emitProgress: (progress: ResponseOperationProgressV2) => {
          for (const listener of progressListeners) listener(progress);
        },
      },
    });
  }, options.request ?? previewRequest);
}

export async function readPreview(page: Page): Promise<URL> {
  return new URL(await page.getByTestId('request-url-preview').locator('span').innerText());
}
