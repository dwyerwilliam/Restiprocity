// Builds the Linux test image and runs the chosen suites against the committed HEAD.
// usage: npm run test:linux:docker -- [suite...]
//   suites: typecheck updater native native-keyring engine e2e packaged (default: all but e2e and packaged)
//   PW_ARGS in the environment is passed to Playwright for the native and e2e suites.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const image = 'restiprocity-linux-test';
const volume = 'restiprocity-linux-work';
const nodeVersion = readFileSync(path.join(repoRoot, '.node-version'), 'utf-8').trim();

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: repoRoot, ...options });
  if (result.error) {
    console.error(`Could not run ${command}: ${result.error.message}`);
    process.exit(1);
  }
  return result.status ?? 1;
}

if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
  console.error('The Docker daemon is not reachable. Start Docker Desktop and retry.');
  process.exit(1);
}

const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf-8' }).stdout.trim();
if (dirty) {
  console.warn('Note: the container tests the committed HEAD. Uncommitted changes are not included:');
  console.warn(dirty);
}

const built = run('docker', ['build', '--quiet', '--build-arg', `NODE_VERSION=${nodeVersion}`, '-t', image, 'docker/linux-test']);
if (built !== 0) process.exit(built);

process.exit(run('docker', [
  'run', '--rm', '--init',
  // Chromium's sandbox needs user namespaces, which Docker's default seccomp profile blocks.
  '--security-opt', 'seccomp=unconfined',
  // gnome-keyring locks its memory.
  '--cap-add', 'IPC_LOCK',
  '--shm-size', '1g',
  '-e', `PW_ARGS=${process.env.PW_ARGS ?? ''}`,
  '-v', `${repoRoot}:/src:ro`,
  '-v', `${volume}:/work`,
  image,
  ...process.argv.slice(2),
]));
