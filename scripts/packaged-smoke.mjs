#!/usr/bin/env node
// Starts the packaged app and checks that it works:
//   - the fuses set in package.json are the ones in the packaged binary;
//   - the main process started from the ASAR and created its data folder (which needs the native SQLite module);
//   - the window loaded the bundled page from the ASAR, rendered, and its bridge answers.
//
// Playwright cannot drive a packaged build, because the build switches the Node inspector off. This talks to the
// window over Chromium's debugging port instead.
//
// Usage: node scripts/packaged-smoke.mjs [output-dir]     (default: the electron-builder output folder)

import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const packageJson = require(path.join(repoRoot, 'package.json'));
const outputDir = path.resolve(repoRoot, process.argv[2] ?? packageJson.build.directories.output);
const productName = packageJson.build.productName;

/** package.json `build.electronFuses` key → the name @electron/fuses uses for the same fuse. */
const FUSE_NAMES = {
  runAsNode: 'RunAsNode',
  enableCookieEncryption: 'EnableCookieEncryption',
  enableNodeOptionsEnvironmentVariable: 'EnableNodeOptionsEnvironmentVariable',
  enableNodeCliInspectArguments: 'EnableNodeCliInspectArguments',
  enableEmbeddedAsarIntegrityValidation: 'EnableEmbeddedAsarIntegrityValidation',
  onlyLoadAppFromAsar: 'OnlyLoadAppFromAsar',
  loadBrowserProcessSpecificV8Snapshot: 'LoadBrowserProcessSpecificV8Snapshot',
  grantFileProtocolExtraPrivileges: 'GrantFileProtocolExtraPrivileges',
};

/** How a fuse's state is stored in the binary: the characters '0' and '1'. */
const FUSE_OFF = 48;
const FUSE_ON = 49;

function fail(message) {
  throw new Error(message);
}

/** The executable to start, and the path @electron/fuses reads the fuses from (the .app bundle on macOS). */
function findPackagedApp() {
  if (process.platform === 'win32') {
    const executable = path.join(outputDir, 'win-unpacked', `${productName}.exe`);
    return { executable, fuseTarget: executable };
  }
  if (process.platform === 'darwin') {
    const bundle = ['mac-arm64', 'mac', 'mac-universal']
      .map((folder) => path.join(outputDir, folder, `${productName}.app`))
      .find((candidate) => fs.existsSync(candidate));
    if (!bundle) fail(`No ${productName}.app found under ${outputDir}.`);
    return { executable: path.join(bundle, 'Contents', 'MacOS', productName), fuseTarget: bundle };
  }
  // electron-builder names the Linux executable after the package.
  const executable = path.join(outputDir, 'linux-unpacked', packageJson.name);
  return { executable, fuseTarget: executable };
}

async function checkFuses(fuseTarget) {
  const expected = packageJson.build.electronFuses ?? {};
  // The copy electron-builder itself flips the fuses with.
  const { getCurrentFuseWire, FuseV1Options } = createRequire(require.resolve('app-builder-lib'))('@electron/fuses');
  const wire = await getCurrentFuseWire(fuseTarget);
  const report = [];
  for (const [key, name] of Object.entries(FUSE_NAMES)) {
    if (typeof expected[key] !== 'boolean') continue;
    const actual = wire[FuseV1Options[name]];
    if (actual !== (expected[key] ? FUSE_ON : FUSE_OFF)) {
      fail(`Fuse ${key} should be ${expected[key] ? 'on' : 'off'} in ${fuseTarget}, but the binary has it ${actual === FUSE_ON ? 'on' : actual === FUSE_OFF ? 'off' : `in state ${actual}`}.`);
    }
    report.push(`${key}=${expected[key] ? 'on' : 'off'}`);
  }
  return report;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** One expression evaluated in the window, over the DevTools protocol. */
function evaluateInPage(webSocketUrl, expression) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const timer = setTimeout(() => { socket.close(); reject(new Error('The window did not answer in time.')); }, 30_000);
    const finish = (settle, value) => { clearTimeout(timer); socket.close(); settle(value); };
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      if (message.error || message.result?.exceptionDetails) {
        finish(reject, new Error(`The window rejected the check: ${JSON.stringify(message.error ?? message.result.exceptionDetails.exception?.description ?? message.result.exceptionDetails.text)}`));
      } else {
        finish(resolve, message.result.result.value);
      }
    });
    socket.addEventListener('error', () => finish(reject, new Error('Could not connect to the window.')));
  });
}

function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  // On Windows, end the helper processes with the main one so the data folder can be removed.
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
}

async function main() {
  const { executable, fuseTarget } = findPackagedApp();
  if (!fs.existsSync(executable)) fail(`No packaged app at ${executable}. Package it first (electron-builder).`);
  console.log(`Packaged app: ${executable}`);

  const fuses = await checkFuses(fuseTarget);
  console.log(`Fuses match package.json: ${fuses.join(', ') || '(none configured)'}`);

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'restiprocity-packaged-'));
  const port = await freePort();
  const output = [];
  const environment = { ...process.env, RESTIPROCITY_TEST_USER_DATA: userData };
  // With the run-as-Node fuse off the app must start as the app even when asked to be Node.
  if (packageJson.build.electronFuses?.runAsNode === false) environment.ELECTRON_RUN_AS_NODE = '1';
  else delete environment.ELECTRON_RUN_AS_NODE;
  const switches = [`--remote-debugging-port=${port}`, '--remote-allow-origins=*'];
  // Chromium's sandbox is often unavailable where this runs on Linux (containers, CI runners that restrict
  // user namespaces). Playwright starts the unpackaged app the same way there. The check is about the package.
  if (process.platform === 'linux') switches.push('--no-sandbox');
  const child = spawn(executable, switches, { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));
  let exited = null;
  child.once('exit', (code, signal) => { exited = `exit code ${code}${signal ? `, signal ${signal}` : ''}`; });
  child.once('error', (error) => { exited = `could not start: ${error.message}`; });

  const waitFor = async (what, probe, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (exited) fail(`The packaged app stopped while waiting for ${what} (${exited}).`);
      const value = await probe().catch(() => null);
      if (value) return value;
      if (Date.now() > deadline) fail(`Timed out waiting for ${what}.`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };

  try {
    const target = await waitFor('the app window', async () => {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return targets.find((entry) => entry.type === 'page' && entry.url.startsWith('file:') && entry.url.endsWith('/dist/index.html'));
    }, 120_000);
    if (!decodeURIComponent(target.url).includes('app.asar')) fail(`The window loaded ${target.url}, which is not inside the ASAR.`);
    console.log(`Window loaded: ${target.url}`);

    const page = await waitFor('the page to render', async () => {
      const state = await evaluateInPage(target.webSocketDebuggerUrl, `(async () => ({
        title: document.title,
        rendered: document.querySelector('[data-testid="sidebar"]') !== null,
        nodeInPage: typeof require !== 'undefined' || typeof process !== 'undefined',
        collections: Array.isArray(await window.api.collectionList()),
        environments: (await window.api.envList()).map((environment) => environment.id),
      }))()`);
      return state.rendered ? state : null;
    }, 60_000);
    if (page.title !== productName) fail(`Unexpected window title: ${page.title}`);
    if (page.nodeInPage) fail('The page can reach Node.');
    if (!page.collections || !page.environments.includes('core')) fail(`The bridge did not answer as expected: ${JSON.stringify(page)}`);
    console.log('Page rendered; the bridge lists collections and the Core environment.');

    for (const file of ['environments/core.json', 'history.db']) {
      if (!fs.existsSync(path.join(userData, file))) fail(`The main process did not create ${file} in its data folder.`);
    }
    console.log('Main process created its data folder, including the history database.');
    console.log('Packaged app check passed.');
  } catch (error) {
    const tail = output.join('').trim().split(/\r?\n/).slice(-20).join('\n');
    if (tail) console.error(`--- last output from the app ---\n${tail}\n---`);
    throw error;
  } finally {
    stop(child);
    await new Promise((resolve) => (exited ? resolve() : child.once('exit', resolve)));
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}

main().catch((error) => {
  console.error(`Packaged app check FAILED: ${error.message}`);
  process.exit(1);
});
