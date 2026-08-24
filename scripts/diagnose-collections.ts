/**
 * Restiprocity collection diagnostics.
 *
 * Usage: npx tsx scripts/diagnose-collections.ts <userData-dir-or-collections-dir>
 *
 * Read-only against your real data. Phase 2 copies the folder to a temp
 * directory and runs the real CollectionStore.moveRequest() on the copy
 * to print the exact error a drag-drop would swallow.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CollectionStore } from '../src/main/stores/collectionStore';

interface NodeInfo {
  file: string;
  stem: string;
  kind: 'request' | 'group';
  raw: Record<string, unknown> | null;
}

interface Issue {
  level: 'ERROR' | 'WARN' | 'INFO';
  where: string;
  message: string;
  fix?: string;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function label(info: NodeInfo): string {
  const name = asString(info.raw?.name) ?? '(unnamed)';
  const id = asString(info.raw?.id) ?? '(no id)';
  return `${name} [id=${id}] in ${path.basename(info.file)}`;
}

function resolveCollectionsDir(input: string): string {
  const resolved = path.resolve(input);
  if (!fs.existsSync(resolved)) {
    console.error(`Path does not exist: ${resolved}`);
    process.exit(1);
  }
  const nested = path.join(resolved, 'collections');
  if (fs.existsSync(nested)) return nested;
  if (fs.readdirSync(resolved).some((n) => n.endsWith('.req.json') || n.endsWith('.grp.json'))) {
    return resolved;
  }
  console.error(`No collections data found at ${resolved} (expected *.req.json / *.grp.json or a collections/ subdir).`);
  process.exit(1);
  return resolved;
}

async function main(): Promise<void> {
  const input = process.argv[2];
  if (!input) {
    console.log('Usage: npx tsx scripts/diagnose-collections.ts <userData-dir-or-collections-dir>');
    console.log('  Windows userData: %APPDATA%\\Restiprocity');
    console.log('  macOS userData:   ~/Library/Application Support/Restiprocity');
    process.exit(1);
  }

  const collectionsDir = resolveCollectionsDir(input);
  console.log(`\nCollections dir: ${collectionsDir}\n`);

  const entries = fs.readdirSync(collectionsDir);
  const requests: NodeInfo[] = [];
  const groups: NodeInfo[] = [];
  for (const name of entries) {
    const file = path.join(collectionsDir, name);
    if (name.endsWith('.req.json')) {
      requests.push({ file, stem: name.slice(0, -'.req.json'.length), kind: 'request', raw: readJson(file) as Record<string, unknown> | null });
    } else if (name.endsWith('.grp.json')) {
      groups.push({ file, stem: name.slice(0, -'.grp.json'.length), kind: 'group', raw: readJson(file) as Record<string, unknown> | null });
    }
  }

  const issues: Issue[] = [];
  const reqById = new Map<string, NodeInfo>();
  const grpById = new Map<string, NodeInfo>();
  const childIds = new Set<string>();
  const idOwners = new Map<string, NodeInfo[]>();

  for (const info of [...requests, ...groups]) {
    if (info.raw === null) {
      issues.push({ level: 'ERROR', where: path.basename(info.file), message: 'File exists but is not valid JSON. The app will ignore it.', fix: 'Restore from backup or delete the file after exporting anything you need.' });
      continue;
    }
    const id = asString(info.raw.id);
    if (!id) {
      issues.push({ level: 'ERROR', where: path.basename(info.file), message: 'Missing internal "id" field. Every operation is keyed by this id, so this node will be broken.', fix: 'Set "id" to the filename stem (without extension) or rename the file to match the id.' });
      continue;
    }
    if (id !== info.stem) {
      issues.push({
        level: 'ERROR',
        where: path.basename(info.file),
        message: `Filename stem "${info.stem}" does not match internal id "${id}". The tree shows this node (file walk) but get/update/move look up ${id}${info.kind === 'request' ? '.req.json' : '.grp.json'}, which does not exist - every operation on this node fails silently.`,
        fix: `Rename the file to ${id}${info.kind === 'request' ? '.req.json' : '.grp.json'} (or rewrite the internal id to "${info.stem}" and fix all references).`,
      });
    }
    idOwners.set(id, [...(idOwners.get(id) ?? []), info]);
    if (info.kind === 'request') reqById.set(id, info);
    else grpById.set(id, info);
  }

  for (const [id, owners] of idOwners) {
    if (owners.length > 1) {
      issues.push({ level: 'ERROR', where: owners.map((o) => path.basename(o.file)).join(', '), message: `Duplicate id "${id}" across ${owners.length} files. Lookups become ambiguous.`, fix: 'Give each node a unique id and update all references.' });
    }
  }

  for (const info of groups) {
    if (info.raw === null) continue;
    const id = asString(info.raw.id);
    const children = info.raw.children;
    if (!Array.isArray(children)) {
      issues.push({ level: 'ERROR', where: path.basename(info.file), message: `"children" is ${children === undefined ? 'missing' : `a ${typeof children}`}, not an array. Dropping a request onto this folder throws after the source has already been updated, orphaning the request.`, fix: 'Replace "children" with [] (or the correct array of child ids).' });
      continue;
    }
    const seen = new Set<string>();
    for (const child of children) {
      if (typeof child !== 'string') {
        issues.push({ level: 'ERROR', where: path.basename(info.file), message: `"children" contains a non-string entry: ${JSON.stringify(child)}.`, fix: 'Remove the invalid entry from "children".' });
        continue;
      }
      childIds.add(child);
      if (seen.has(child)) issues.push({ level: 'WARN', where: path.basename(info.file), message: `"children" lists "${child}" more than once.`, fix: 'De-duplicate "children".' });
      seen.add(child);
      if (child === id) issues.push({ level: 'ERROR', where: path.basename(info.file), message: 'Group lists itself as a child (cycle).', fix: `Remove "${id}" from its own "children".` });
      const childReq = reqById.get(child);
      const childGrp = grpById.get(child);
      if (!childReq && !childGrp) {
        issues.push({ level: 'ERROR', where: path.basename(info.file), message: `"children" references "${child}", but no request or group has that id. This is a dangling reference.`, fix: `Remove "${child}" from "children" (or restore the missing node file).` });
        continue;
      }
      const back = asString((childReq ?? childGrp)!.raw?.parentId);
      if (back !== id) {
        issues.push({
          level: 'WARN',
          where: path.basename(info.file),
          message: `Child "${child}" exists but its parentId is ${JSON.stringify(back)} instead of "${id}" (back-link mismatch).`,
          fix: `Set the child's "parentId" to "${id}".`,
        });
      }
    }
  }

  for (const info of requests) {
    if (info.raw === null) continue;
    const id = asString(info.raw.id);
    const parentId = asString(info.raw.parentId);
    if (!parentId) continue;
    const group = grpById.get(parentId);
    if (!group) {
      issues.push({ level: 'ERROR', where: path.basename(info.file), message: `parentId "${parentId}" does not match any group. The request is orphaned and renders at root.`, fix: `Clear "parentId" (move to root) or restore the missing group, or point it at an existing group id and add "${id}" to that group's "children".` });
      continue;
    }
    const children = group.raw?.children;
    if (!Array.isArray(children) || !children.includes(id)) {
      issues.push({ level: 'ERROR', where: `${path.basename(info.file)} + ${path.basename(group.file)}`, message: `Stale parentId: request claims to be in "${asString(group.raw?.name) ?? parentId}", but that group's "children" does not list "${id}". The tree renders this at root, AND dropping it onto this same folder is rejected ("requires a different target parent").`, fix: `Either add "${id}" to the group's "children", or clear the request's "parentId" and re-drag it into the folder you want.` });
    }
  }

  const rootOrderFile = path.join(collectionsDir, '.root-order.json');
  if (fs.existsSync(rootOrderFile)) {
    const order = readJson(rootOrderFile);
    if (!Array.isArray(order)) {
      issues.push({ level: 'WARN', where: '.root-order.json', message: 'File is not an array; the app falls back to file order.', fix: 'Replace with [] or the ordered root id list.' });
    } else {
      for (const id of order) {
        if (typeof id !== 'string' || (!reqById.has(id) && !grpById.has(id))) {
          issues.push({ level: 'INFO', where: '.root-order.json', message: `Stale entry ${JSON.stringify(id)} (no node has this id). Harmless, but noise.`, fix: 'Remove the stale entry.' });
        }
      }
    }
  }

  console.log('─'.repeat(72));
  console.log('PHASE 1 — Static consistency report');
  console.log('─'.repeat(72));
  console.log(`${requests.length} request file(s), ${groups.length} group file(s)\n`);
  if (issues.length === 0) {
    console.log('No consistency issues found. The data looks healthy; the failure is likely behavioral. See Phase 2.');
  }
  const order = { ERROR: 0, WARN: 1, INFO: 2 };
  for (const issue of issues.sort((a, b) => order[a.level] - order[b.level])) {
    console.log(`[${issue.level}] ${issue.where}`);
    console.log(`  ${issue.message}`);
    if (issue.fix) console.log(`  FIX: ${issue.fix}`);
    console.log('');
  }

  await phase2(collectionsDir, requests, groups);
}

async function phase2(collectionsDir: string, requests: NodeInfo[], groups: NodeInfo[]): Promise<void> {
  const rootRequests = requests.filter((r) => {
    const id = asString(r.raw?.id);
    return id !== undefined && !groups.some((g) => Array.isArray(g.raw?.children) && (g.raw!.children as string[]).includes(id));
  });
  const targetGroups = groups.filter((g) => asString(g.raw?.id) !== undefined);

  console.log('─'.repeat(72));
  console.log('PHASE 2 — Simulating drag-drop moves on a TEMP COPY (real CollectionStore.moveRequest)');
  console.log('─'.repeat(72));
  if (rootRequests.length === 0 || targetGroups.length === 0) {
    console.log('Skipped: no root requests or no groups to simulate against.\n');
    return;
  }
  console.log(`Simulating ${rootRequests.length} root request(s) into ${targetGroups.length} group(s).\n`);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'restiprocity-diag-'));
  const results: Array<{ req: NodeInfo; grp: NodeInfo; ok: boolean; detail: string }> = [];
  try {
    for (const req of rootRequests) {
      for (const grp of targetGroups) {
        const attemptDir = path.join(tempRoot, `${req.stem}__TO__${grp.stem}`);
        const userData = path.join(attemptDir, 'userData');
        fs.mkdirSync(path.join(userData, 'collections'), { recursive: true });
        fs.cpSync(collectionsDir, path.join(userData, 'collections'), { recursive: true });
        const store = new CollectionStore(userData);
        const reqId = asString(req.raw?.id)!;
        const grpId = asString(grp.raw?.id)!;
        try {
          await store.moveRequest({ requestId: reqId, targetParentId: grpId, targetIndex: 0 });
          results.push({ req, grp, ok: true, detail: 'moved OK' });
        } catch (err) {
          results.push({ req, grp, ok: false, detail: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  let line = 0;
  for (const req of rootRequests) {
    for (const grp of targetGroups) {
      const r = results[line++]!;
      const mark = r.ok ? '[ OK ]' : '[FAIL]';
      console.log(`${mark} ${label(req)} → ${label(grp)}`);
      if (!r.ok) console.log(`     exact error: ${r.detail}`);
    }
  }
  console.log('');
  const failures = results.filter((r) => !r.ok);
  if (failures.length === 0) {
    console.log('All simulated moves succeeded on the temp copy.');
  } else {
    console.log(`${failures.length} of ${results.length} simulated moves failed. The "exact error" lines above are what the app swallows during drag-drop.`);
  }
}

void main();
