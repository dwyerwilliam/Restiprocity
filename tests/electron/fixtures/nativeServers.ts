import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type NativeObservation = { path: string; cookie?: string; authorization?: string; host?: string };

export interface NativeFixture {
  readonly port: number;
  readonly observations: NativeObservation[];
  readonly close: () => Promise<void>;
}

function handler(observations: NativeObservation[]) {
  return (request: http.IncomingMessage, response: http.ServerResponse) => {
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    const entry: NativeObservation = {
      path: request.url ?? '/',
      cookie: request.headers.cookie,
      authorization: request.headers.authorization,
      host: request.headers.host,
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

export async function startHttpsFixture(): Promise<NativeFixture & { cleanupCertificate: () => Promise<void> }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-tls-'));
  const pfxPath = path.join(directory, 'fixture.pfx');
  const password = 'restiprocity-test-password';
  const script = `$c=New-SelfSignedCertificate -DnsName 'api.restiprocity.test','tls.restiprocity.test' -CertStoreLocation 'Cert:\\CurrentUser\\My'; Export-PfxCertificate -Cert $c -FilePath '${pfxPath.replaceAll("'", "''")}' -Password (ConvertTo-SecureString '${password}' -AsPlainText -Force); Write-Output $c.Thumbprint`;
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  const thumbprint = stdout.trim().split(/\r?\n/).at(-1)?.trim();
  if (!thumbprint) throw new Error('TLS fixture certificate was not created');
  const observations: NativeObservation[] = [];
  const server = https.createServer({ pfx: await fs.readFile(pfxPath), passphrase: password }, handler(observations));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTPS fixture did not expose a port');
  const cleanupCertificate = async () => {
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Remove-Item -Path 'Cert:\\CurrentUser\\My\\${thumbprint}' -Force -ErrorAction SilentlyContinue`]).catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  };
  return { port: address.port, observations, close: () => closeServer(server), cleanupCertificate };
}

async function closeServer(server: http.Server | https.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
