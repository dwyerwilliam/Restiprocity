import { EventEmitter } from 'events';
import { expect, test } from '@playwright/test';
import { RequestEngine } from '../../src/main/engine/requestEngine';
import { RequestFailureError } from '../../src/main/engine/requestErrors';
import type { NetRequestAdapter } from '../../src/main/engine/requestRuntimeAdapters';
import type { Request } from '../../src/shared/types';

class FakeClientRequest extends EventEmitter {
  abortCalls = 0;

  constructor(private readonly onAbort: (request: FakeClientRequest) => void) {
    super();
  }

  setHeader(): void {}

  end(): this {
    return this;
  }

  abort(): void {
    this.abortCalls += 1;
    this.onAbort(this);
  }

  followRedirect(): void {}
}

function makeNtlmRequest(timeout: number): Request {
  const now = Date.now();

  return {
    id: 'req-ntlm-error',
    name: 'NTLM error request',
    method: 'GET',
    url: 'https://ntlm.example.test/resource',
    headers: [],
    parameters: [],
    body: { type: 'none' },
    auth: { type: 'ntlm', ntlm: { useCurrentAuthContext: true } },
    settings: { followRedirect: true, timeout, cookiesEnabled: true },
    scripts: {},
    createdAt: now,
    updatedAt: now,
  };
}

async function executeWithClientRequest(clientRequest: FakeClientRequest, timeout = 5): Promise<RequestFailureError> {
  const session = {
    allowNTLMCredentialsForDomains: () => {},
  };
  const collectionStore = {
    getActiveEnvironmentId: () => null,
  };

  try {
    const netRequest: NetRequestAdapter = () => clientRequest;
    const engine = new RequestEngine(session as never, collectionStore as never, { netRequest });
    await engine.execute({ request: makeNtlmRequest(timeout) });
  } catch (error) {
    if (error instanceof RequestFailureError) {
      return error;
    }
    throw error;
  }

  throw new Error('Expected the request to fail');
}

test.describe('RequestEngine net.request failure settlement', () => {
  test('preserves a meaningful native error emitted as the timeout abort races', async () => {
    const nativeError = Object.assign(new Error('NTLM authentication failed in native transport'), {
      code: 'ERR_FAILED',
    });
    const clientRequest = new FakeClientRequest((request) => {
      if (request.abortCalls === 1) {
        setImmediate(() => request.emit('error', nativeError));
      }
    });

    const failure = await executeWithClientRequest(clientRequest);

    expect(failure.requestError).toMatchObject({
      kind: 'transport',
      rawMessage: 'NTLM authentication failed in native transport',
      code: 'ERR_FAILED',
    });
    expect(clientRequest.abortCalls).toBe(1);
  });

  test('keeps timeout classification when abort only emits an abort-induced error', async () => {
    const abortError = Object.assign(new Error('net::ERR_ABORTED'), {
      name: 'AbortError',
      code: 'ERR_ABORTED',
    });
    const clientRequest = new FakeClientRequest((request) => {
      if (request.abortCalls === 1) {
        setImmediate(() => request.emit('error', abortError));
      }
    });

    const failure = await executeWithClientRequest(clientRequest);

    expect(failure.requestError).toMatchObject({
      kind: 'timeout',
      rawMessage: 'Request timed out after 5ms',
      code: null,
    });
    expect(clientRequest.abortCalls).toBe(1);
  });

  test('keeps timeout classification when abort emits no native error', async () => {
    const clientRequest = new FakeClientRequest(() => {});

    const failure = await executeWithClientRequest(clientRequest);

    expect(failure.requestError).toMatchObject({
      kind: 'timeout',
      rawMessage: 'Request timed out after 5ms',
      code: null,
    });
    expect(clientRequest.abortCalls).toBe(1);
  });
});
