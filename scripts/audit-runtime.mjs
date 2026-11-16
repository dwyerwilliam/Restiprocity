// Reports published advisories for Electron, the runtime every user gets.
// `npm audit --omit=dev` cannot see it: Electron is a development dependency in package.json, because
// electron-builder packs it into the app instead of npm installing it for the user.
// usage: node scripts/audit-runtime.mjs    (exit 1 when a high or critical advisory is open)
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installed = JSON.parse(readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf-8')).packages?.['node_modules/electron']?.version ?? 'unknown';

// `npm audit` exits non-zero whenever anything is reported, so the exit code says nothing here; the JSON does.
const audit = spawnSync('npm', ['audit', '--json'], { cwd: repoRoot, encoding: 'utf-8', shell: true, maxBuffer: 64 * 1024 * 1024 });
let report;
try {
  report = JSON.parse(audit.stdout);
} catch {
  console.error('npm audit did not return a report:');
  console.error((audit.stderr || audit.stdout || '').slice(0, 2000));
  process.exit(2);
}
if (report.error) {
  console.error(`npm audit failed: ${report.error.summary ?? report.error.code ?? JSON.stringify(report.error).slice(0, 500)}`);
  process.exit(2);
}

const entry = report.vulnerabilities?.electron;
const advisories = (entry?.via ?? []).filter(item => typeof item === 'object' && item !== null);
if (advisories.length === 0) {
  console.log(`Electron ${installed}: no published advisories.`);
  process.exit(0);
}

const rank = { critical: 0, high: 1, moderate: 2, low: 3, info: 4 };
advisories.sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9));
console.log(`Electron ${installed}: ${advisories.length} published advisories.`);
for (const advisory of advisories) {
  console.log(`  ${String(advisory.severity).padEnd(8)} affects ${String(advisory.range).padEnd(12)} ${advisory.title}  ${advisory.url}`);
}
const fix = entry.fixAvailable && typeof entry.fixAvailable === 'object'
  ? `electron ${entry.fixAvailable.version}${entry.fixAvailable.isSemVerMajor ? ' (a new major version)' : ''}`
  : 'no fixed version reported';
console.log(`Fixed by: ${fix}.`);

const serious = advisories.filter(advisory => advisory.severity === 'high' || advisory.severity === 'critical');
if (serious.length > 0) {
  // Shown on the run's summary page when this runs in GitHub Actions.
  if (process.env.GITHUB_ACTIONS) {
    console.log(`::warning title=Electron ${installed} has ${serious.length} high or critical advisories::The app ships this runtime. Fixed by ${fix}.`);
  }
  process.exit(1);
}
