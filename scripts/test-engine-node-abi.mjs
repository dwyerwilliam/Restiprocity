#!/usr/bin/env node
// Runs the engine Playwright suite under a Node-ABI better-sqlite3 binding in
// strict mode (RESTIPROCITY_REQUIRE_NODE_SQLITE=1), then ALWAYS restores the
// Electron-ABI binding so the tree is app-ready afterwards.
//
// Flow:
//   1. npm run rebuild:node        (binding -> Node ABI)
//   2. npm run test:engine         (strict: any SQLite skip/failure exits non-zero)
//   3. npm run rebuild:electron    (binding -> Electron ABI; runs even on failure)
//
// Exit code: the test-suite exit code (or the rebuild:node exit code when the
// suite never ran). A failed restore is reported separately and forces a
// non-zero exit even if everything else passed.

import { spawnSync } from 'node:child_process';
import process from 'node:process';

const isWindows = process.platform === 'win32';
const npmBinary = isWindows ? 'npm.cmd' : 'npm';

function runNpm(label, args, extraEnv) {
  // Windows .cmd batch files cannot be exec'd directly (EINVAL); they need
  // cmd.exe. POSIX `npm` is a real executable and is spawned without a shell.
  const result = spawnSync(npmBinary, args, {
    stdio: 'inherit',
    shell: isWindows,
    env: { ...process.env, ...(extraEnv ?? {}) },
  });
  if (result.error) {
    console.error(`[node-abi] ${label} failed to start: ${result.error.message}`);
    return 1;
  }
  if (result.status !== 0) {
    console.error(`[node-abi] ${label} exited with code ${result.status}`);
  }
  return result.status ?? 1;
}

let primaryCode = 0;
let suiteRan = false;

try {
  const rebuildCode = runNpm('rebuild:node', ['run', 'rebuild:node']);
  if (rebuildCode !== 0) {
    primaryCode = rebuildCode;
  } else {
    suiteRan = true;
    const testCode = runNpm('test:engine (strict Node-ABI)', ['run', 'test:engine'], {
      RESTIPROCITY_REQUIRE_NODE_SQLITE: '1',
    });
    if (testCode !== 0) {
      primaryCode = testCode;
    }
  }
} finally {
  const restoreCode = runNpm('rebuild:electron (restore)', ['run', 'rebuild:electron']);
  if (restoreCode !== 0) {
    console.error(
      '[node-abi] Electron ABI restore failed; the tree is NOT in app-ready state. Run `npm run rebuild:electron` manually.',
    );
    if (primaryCode === 0) primaryCode = 2;
  }
}

if (primaryCode === 0) {
  console.log('[node-abi] OK: strict Node-ABI engine suite passed and the Electron ABI was restored.');
} else if (!suiteRan) {
  console.error('[node-abi] FAILED: rebuild:node failed before the engine suite ran.');
} else {
  console.error('[node-abi] FAILED: strict Node-ABI engine suite did not pass.');
}

process.exitCode = primaryCode;
