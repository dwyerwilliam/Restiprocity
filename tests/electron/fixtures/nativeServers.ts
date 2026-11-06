import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const execFileAsync = promisify(execFile);

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

export async function startHttpsFixture(): Promise<NativeFixture & { cleanupCertificate: () => Promise<void> }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'restiprocity-tls-'));
  const pfxPath = path.join(directory, 'fixture.pfx');
  const password = 'restiprocity-test-password';
  // Generate directly into the temporary file. This avoids certificate-store
  // permissions, which are unavailable in some Windows test hosts.
  const directScript = [
    "$rsa=[System.Security.Cryptography.RSA]::Create(2048);",
    "$req=[System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=api.restiprocity.test',$rsa,[System.Security.Cryptography.HashAlgorithmName]::SHA256,[System.Security.Cryptography.RSASignaturePadding]::Pkcs1);",
    "$san=[System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new(); $san.AddDnsName('api.restiprocity.test'); $san.AddDnsName('tls.restiprocity.test'); $req.CertificateExtensions.Add($san.Build());",
    "$cert=$req.CreateSelfSigned([datetime]::UtcNow.AddMinutes(-1),[datetime]::UtcNow.AddDays(1)); [IO.File]::WriteAllBytes('PATH_PLACEHOLDER',$cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx,'PASSWORD_PLACEHOLDER'))",
  ].join(' ').replace('PATH_PLACEHOLDER', pfxPath.replaceAll("'", "''")).replace('PASSWORD_PLACEHOLDER', password);
  let created = false;
  for (const shell of ['pwsh.exe', 'powershell.exe']) {
    try {
      await execFileAsync(shell, ['-NoProfile', '-NonInteractive', '-Command', directScript]);
      if (await fs.stat(pfxPath).catch(() => null)) { created = true; break; }
    } catch {
      // Try the next installed PowerShell implementation.
    }
  }
  if (!created) {
    await fs.rm(directory, { recursive: true, force: true });
    throw new Error('TLS fixture certificate was not created; PowerShell/.NET certificate generation is unavailable.');
  }
  const observations: NativeObservation[] = [];
  const server = https.createServer({ pfx: await fs.readFile(pfxPath), passphrase: password }, handler(observations));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('HTTPS fixture did not expose a port');
  const cleanupCertificate = async () => {
    await fs.rm(directory, { recursive: true, force: true });
  };
  return { port: address.port, observations, close: () => closeServer(server), cleanupCertificate };
}
async function closeServer(server: http.Server | https.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
