// Run after every deploy (deploy-gcp.yml does; `npm run post-deploy` does it by hand):
//   1. Makes every callable function publicly invokable (allUsers + Cloud Run Invoker). The deploy does not set this,
//      and without it the browser's CORS preflight is refused before our code runs. Callables still check sign-in
//      themselves. Idempotent, so it covers brand-new functions without anyone having to remember.
//   2. Probes every callable anonymously and expects 401 (our sign-in check). 403 means the invoker grant is missing
//      or has not propagated yet (retried for a while); anything else is a failure.
// Event-triggered functions (such as onSubmissionCreated) stay private on purpose and are skipped.
//
// Needs: the Firebase CLI (via npx), gcloud, and credentials that may set Cloud Run IAM (the deployer account).
// Environment: POST_DEPLOY_PROJECT (default golf-live-scoring-app-510200), GCLOUD (path to gcloud, default "gcloud").
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const functionsDir = fileURLToPath(new URL('..', import.meta.url)); // works from any working directory
const project = process.env.POST_DEPLOY_PROJECT ?? 'golf-live-scoring-app-510200';
const gcloud = process.env.GCLOUD ?? 'gcloud';
const win = process.platform === 'win32';

function run(cmd, args) {
  // Windows needs a shell to run .cmd shims; the arguments here are fixed or come from our own deploy listing.
  return execFileSync(cmd, args, { encoding: 'utf8', shell: win, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 50 * 1024 * 1024 });
}

const listing = JSON.parse(
  run('npx', ['--prefix', functionsDir, 'firebase', 'functions:list', '--project', project, '--json']),
);
const callables = (listing.result ?? []).filter((fn) => fn.callableTrigger || fn.httpsTrigger);
if (callables.length === 0) {
  console.error('No callable functions found in the listing; refusing to report success.');
  process.exit(1);
}

let failed = 0;
for (const fn of callables) {
  const service = fn.runServiceId ?? fn.id.toLowerCase();
  try {
    run(gcloud, [
      'run', 'services', 'add-iam-policy-binding', service,
      `--region=${fn.region}`, '--member=allUsers', '--role=roles/run.invoker', `--project=${project}`, '--quiet',
    ]);
  } catch (err) {
    console.error(`FAIL ${fn.id}: could not grant public access: ${String(err.stderr ?? err.message).trim().split('\n').pop()}`);
    failed++;
    continue;
  }

  let status = 0;
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const res = await fetch(fn.uri, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"data":{}}' });
      status = res.status;
    } catch {
      status = 0;
    }
    if (status === 401) break;
    await new Promise((resolve) => setTimeout(resolve, 10_000)); // IAM changes take a little while to spread
  }
  if (status === 401) {
    console.log(`ok   ${fn.id} (anonymous call refused with 401)`);
  } else {
    console.error(`FAIL ${fn.id}: an anonymous call returned ${status}, expected 401`);
    failed++;
  }
}

console.log(`\n${callables.length - failed} of ${callables.length} callable functions public and refusing anonymous callers.`);
process.exit(failed === 0 ? 0 : 1);
