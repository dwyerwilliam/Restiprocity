import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export type NativeObservation = { path: string; cookie?: string; authorization?: string; host?: string; bodyLength?: number; bodySha256?: string };

export interface NativeFixture {
  readonly port: number;
  readonly observations: NativeObservation[];
  readonly close: () => Promise<void>;
}

function handler(observations: NativeObservation[]) {
  return async (request: http.IncomingMessage, response: http.ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    const entry: NativeObservation = {
      path: request.url ?? '/',
      cookie: request.headers.cookie,
      authorization: request.headers.authorization,
      host: request.headers.host,
      ...(body.length ? { bodyLength: body.length, bodySha256: createHash('sha256').update(body).digest('hex') } : {}),
    };
    observations.push(entry);

    if (request.url === '/set') {
      response.setHeader('Set-Cookie', [
        'session=private-one; Path=/; HttpOnly; Max-Age=3600',
        'session=private-two; Path=/nested; Expires=Wed, 21 Oct 2037 07:28:00 GMT',
        'secure-only=secret; Path=/; Secure',
        'domain-cookie=domain-value; Domain=.restiprocity.test; Path=/',
        'deleted=gone; Path=/; Max-Age=0',
      ]);
      response.end('set response without cookie values');
      return;
    }
    if (request.url === '/login') {
      response.statusCode = 401;
      response.setHeader('WWW-Authenticate', 'Basic realm="restiprocity-test"');
      response.setHeader('Set-Cookie', 'login-observed=received; Path=/; HttpOnly');
      response.end('login challenge');
      return;
    }
    if (request.url === '/redirect') {
      response.statusCode = 302;
      response.setHeader('Location', '/echo');
      response.setHeader('Set-Cookie', 'redirect-cookie=redirected; Path=/');
      response.end();
      return;
    }
    if (request.url === '/echo') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ receivedCookie: request.headers.cookie ?? null, receivedAuthorization: request.headers.authorization ?? null }));
      return;
    }
    response.end('identity fixture');
  };
}

export async function startHttpFixture(): Promise<NativeFixture> {
  const observations: NativeObservation[] = [];
  const server = http.createServer(handler(observations));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTP fixture did not expose a port');
  return { port: address.port, observations, close: () => closeServer(server) };
}

/** A fixed, test-only self-signed pair (see tls/README.md): the same on every system, so nothing is generated or needs a host tool. */
export async function startHttpsFixture(): Promise<NativeFixture> {
  const [key, cert] = await Promise.all([
    fs.readFile(path.join(__dirname, 'tls', 'restiprocity-test.key.pem')),
    fs.readFile(path.join(__dirname, 'tls', 'restiprocity-test.cert.pem')),
  ]);
  const observations: NativeObservation[] = [];
  const server = https.createServer({ key, cert }, handler(observations));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTPS fixture did not expose a port');
  return { port: address.port, observations, close: () => closeServer(server) };
}
async function closeServer(server: http.Server | https.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
