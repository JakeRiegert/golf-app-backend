#!/usr/bin/env node
// Which functions, and which tests, does a change touch?
//
// Every function is built from one shared source bundle, so a change can only matter to the
// functions whose code (transitively) imports the changed files. This script reads our own import
// graph: functions/src/index.ts says which module each function comes from, and each module's
// imports say what it depends on. Nothing to maintain by hand.
//
//   node scripts/affected.mjs                 files changed in the working tree vs HEAD
//   node scripts/affected.mjs --base <ref>    files changed between <ref> and HEAD (CI, deploys)
//
// Prints JSON: { all, functions, changed, tests, rules, reason }.
//   all        true when something shared changed (or the base is unknown): run and deploy everything
//   functions  the deployable function names whose code is affected (every function when all)
//   changed    changed source and test files to hand to `vitest related`
//   rules      true when firestore.rules or the indexes changed (rules tests, `deploy --only firestore`)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const functionsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(functionsDir, '..');
const srcDir = join(functionsDir, 'src');

const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });

// --- the import graph -------------------------------------------------------------------------
const modules = readdirSync(srcDir)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => f.slice(0, -3));

function importsOf(mod) {
  const text = readFileSync(join(srcDir, `${mod}.ts`), 'utf8');
  const found = new Set();
  for (const m of text.matchAll(/(?:from\s+|import\s+)['"]\.\/([\w-]+)['"]/g)) found.add(m[1]);
  return [...found].filter((name) => modules.includes(name));
}

const graph = Object.fromEntries(modules.map((m) => [m, importsOf(m)]));

function closure(mod) {
  const seen = new Set();
  const stack = [mod];
  while (stack.length) {
    const next = stack.pop();
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...(graph[next] ?? []));
  }
  return seen;
}

// index.ts: `export { fooCallable as foo, bar } from './mod'` -> function foo comes from mod.
const indexText = readFileSync(join(srcDir, 'index.ts'), 'utf8');
const functionModule = {};
for (const m of indexText.matchAll(/export\s*\{([^}]*)\}\s*from\s*['"]\.\/([\w-]+)['"]/g)) {
  for (const item of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
    const name = item.split(/\s+as\s+/).pop().trim();
    functionModule[name] = m[2];
  }
}
// What every function's container loads regardless of which function it serves: index.ts itself and
// whatever it imports for its side effects (config.ts sets the region, limits and runtime account).
const functionModules = new Set(Object.values(functionModule));
const implicitShared = new Set(['index', ...(graph.index ?? []).filter((m) => !functionModules.has(m))]);

// --- what changed -----------------------------------------------------------------------------
function changedFiles() {
  const baseIdx = process.argv.indexOf('--base');
  if (baseIdx === -1) {
    const tracked = git('diff', '--name-only', 'HEAD').split('\n');
    const untracked = git('ls-files', '--others', '--exclude-standard').split('\n');
    return { files: [...tracked, ...untracked].filter(Boolean) };
  }
  const base = process.argv[baseIdx + 1];
  if (!base || /^0+$/.test(base)) return { unknownBase: true, files: [] };
  try {
    git('rev-parse', '--verify', `${base}^{commit}`);
  } catch {
    return { unknownBase: true, files: [] };
  }
  return { files: git('diff', '--name-only', base, 'HEAD').split('\n').filter(Boolean) };
}

const { files, unknownBase } = changedFiles();
const rel = (f) => f.replaceAll('\\', '/');

const sourceChanged = new Set();
const testFiles = [];
let rules = false;
let all = false;
const reasons = [];

if (unknownBase) {
  all = true;
  reasons.push('base commit unknown, treating everything as changed');
}

for (const file of files.map(rel)) {
  const srcMatch = file.match(/^functions\/src\/([\w-]+)\.ts$/);
  if (srcMatch) {
    const mod = srcMatch[1];
    if (implicitShared.has(mod)) {
      all = true;
      reasons.push(`${file} is loaded by every function`);
    } else {
      sourceChanged.add(mod);
    }
  } else if (/^functions\/test\/.+\.test\.ts$/.test(file)) {
    if (existsSync(join(repoRoot, file))) testFiles.push(file.replace(/^functions\//, ''));
  } else if (file === 'firestore.rules' || file === 'firestore.indexes.json') {
    rules = true;
    reasons.push(`${file} changed`);
  } else if (
    /^functions\/(package(-lock)?\.json|tsconfig.*\.json|\.env.*)$/.test(file) ||
    file === 'firebase.json' ||
    file === 'firebase.test.json' ||
    file.startsWith('.github/workflows/ci.yml') ||
    file.startsWith('functions/scripts/')
  ) {
    all = true;
    reasons.push(`${file} affects the whole build`);
  }
  // Anything else (docs, ops notes, other workflows) touches no function.
}

// --- result -----------------------------------------------------------------------------------
const allFunctions = Object.keys(functionModule).sort();
const touched = (name) => [...closure(functionModule[name])].some((m) => sourceChanged.has(m));
const functions = all ? allFunctions : allFunctions.filter(touched);

// Source modules that changed, plus modules whose dependencies changed, are what tests import.
const changed = [
  ...[...sourceChanged].map((m) => `src/${m}.ts`),
  ...testFiles,
  ...(rules && !all ? ['test/rules.emulated.test.ts'] : []),
];

console.log(JSON.stringify({ all, functions, changed, rules, reason: [...new Set(reasons)] }, null, 2));
