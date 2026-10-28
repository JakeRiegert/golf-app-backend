#!/usr/bin/env node
// Run only the tests a change can affect (see affected.mjs for how that is decided).
//
//   npm run test:changed                       working-tree changes vs HEAD
//   npm run test:changed -- --base <ref>       changes between <ref> and HEAD (what CI passes)
//
// Everything runs inside one Firestore emulator session. When something shared changed (or the
// base is unknown) it falls back to the full suite, so selection can only ever save time.
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const functionsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const passthrough = process.argv.slice(2);

const info = JSON.parse(
  execFileSync(process.execPath, [resolve(functionsDir, 'scripts/affected.mjs'), ...passthrough], {
    cwd: functionsDir,
    encoding: 'utf8',
  }),
);

const run = (command) => {
  console.log(`\n> ${command}\n`);
  const result = spawnSync(command, { cwd: functionsDir, shell: true, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

console.log(
  `Affected functions: ${info.functions.length ? info.functions.join(', ') : 'none'}` +
    (info.all ? ' (everything: ' + info.reason.join('; ') + ')' : ''),
);

if (info.all) {
  run('npm test');
  run('npm run test:emulated');
  run('npm run test:http');
} else if (info.changed.length === 0 && info.httpTests.length === 0) {
  console.log('No source, test or rules changes: nothing to run.');
} else {
  if (info.changed.length > 0) {
    run(
      'npx firebase emulators:exec --config ../firebase.test.json --only firestore --project demo-golf-rules ' +
        `"vitest related --run --passWithNoTests ${info.changed.join(' ')}"`,
    );
  }
  if (info.httpTests.length > 0) {
    // The Functions emulator runs the compiled code in lib/, so build first.
    run('npm run build');
    run(
      'npx firebase emulators:exec --config ../firebase.test.json --only auth,functions,firestore --project demo-golf-http ' +
        `"vitest run ${info.httpTests.join(' ')}"`,
    );
  }
}
