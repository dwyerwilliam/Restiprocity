import { spawnSync } from 'node:child_process';
import { test as base, expect } from '@playwright/test';
import { _electron, type ElectronApplication } from 'playwright';

export { expect };

/** A healthy app exits in well under a second once asked to quit. */
const QUIT_TIMEOUT_MS = 20_000;
/** How long each diagnostic probe may take before it counts as unanswered. */
const PROBE_TIMEOUT_MS = 3_000;

const TIMED_OUT = Symbol('timed out');

async function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<typeof TIMED_OUT>(resolve => { timer = setTimeout(() => resolve(TIMED_OUT), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

async function probe(label: string, run: () => Promise<unknown>): Promise<string> {
  try {
    const result = await within(run(), PROBE_TIMEOUT_MS);
    return `${label}: ${result === TIMED_OUT ? `no answer within ${PROBE_TIMEOUT_MS / 1000} s` : JSON.stringify(result)}`;
  } catch (error) {
    return `${label}: ${(error as Error).message.split('\n')[0]}`;
  }
}

/** What each process of the app is doing, from the OS (Linux and macOS only). */
function processStates(pid: number): string {
  if (process.platform === 'win32') return '';
  const listed = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat=,wchan:32=,args='], { encoding: 'utf-8' });
  if (listed.status !== 0) return '';
  // The app's own process group (Playwright makes it the leader) and anything it started directly.
  const rows = listed.stdout.split('\n').filter(line => {
    const [own, parent, group] = line.trim().split(/\s+/);
    return [own, parent, group].includes(String(pid));
  });
  return rows.map(line => line.trim().slice(0, 240)).join('\n');
}

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  // Playwright starts Electron as the leader of its own process group, so this reaches its helpers too.
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
}

/**
 * Closes an app a test launched. Playwright's `close()` asks the main process to quit and then waits for the
 * process to exit with no time limit, so an app that never exits holds the test until its timeout and then the
 * worker teardown for another full timeout, which fails the run even when a retry passes. This waits a bounded
 * time; if the app has not exited it records what the app was doing, kills it, and throws with that record.
 */
export async function closeApp(app: ElectronApplication): Promise<void> {
  const child = app.process();
  const output: string[] = [];
  const keep = (chunk: Buffer) => { output.push(...chunk.toString('utf-8').split('\n').filter(Boolean)); output.splice(0, Math.max(0, output.length - 30)); };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  const closing = app.close();
  try {
    if (await within(closing, QUIT_TIMEOUT_MS) !== TIMED_OUT) return;
  } finally {
    child.stdout?.off('data', keep);
    child.stderr?.off('data', keep);
  }

  // Playwright drops its main-process connection once `app.quit()` has run, so an error here means the quit was
  // delivered and the process stayed; no answer means the main process is blocked.
  const report = [
    `The app (pid ${child.pid}) did not exit within ${QUIT_TIMEOUT_MS / 1000} s of being asked to quit.`,
    await probe('main process', () => app.evaluate(({ app: electronApp, BrowserWindow, webContents }) => ({
      windows: BrowserWindow.getAllWindows().map(window => ({ destroyed: window.isDestroyed(), visible: window.isVisible() })),
      contents: webContents.getAllWebContents().map(contents => ({
        type: contents.getType(), url: contents.getURL().slice(-60), crashed: contents.isCrashed(), loading: contents.isLoading(),
      })),
      ready: electronApp.isReady(),
    }))),
    ...await Promise.all(app.windows().map((page, index) => probe(`window ${index} script`, () => page.evaluate(() => document.readyState)))),
  ];
  const states = child.pid ? processStates(child.pid) : '';
  if (states) report.push('processes (pid ppid pgid stat wchan args):', states);
  if (output.length) report.push('app output after the quit request:', ...output);

  if (child.pid) killTree(child.pid);
  await within(closing.catch(() => {}), 5_000);
  const message = report.join('\n');
  // Also printed, because a caller in a `finally` block may swallow the error.
  console.error(message);
  throw new Error(message);
}

/** Apps launched by the current test that have not exited yet. */
const running = new Set<ElectronApplication>();

/** `_electron.launch`, remembered so the test's teardown can close whatever the test leaves running. */
export async function launchApp(options: Parameters<typeof _electron.launch>[0]): Promise<ElectronApplication> {
  const app = await _electron.launch(options);
  running.add(app);
  app.once('close', () => running.delete(app));
  return app;
}

/**
 * The native suites' `test`. After each test (including one that timed out while an app call was hanging) it
 * closes any app the test left running, through `closeApp`, so a stuck app is killed and reported instead of
 * holding the worker teardown.
 */
export const test = base.extend<{ closeLeftoverApps: void }>({
  closeLeftoverApps: [async ({}, use) => {
    await use();
    const left = [...running];
    running.clear();
    const results = await Promise.allSettled(left.map(app => closeApp(app)));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
  }, { auto: true }],
});
