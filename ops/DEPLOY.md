# Deploying to Google Cloud

Status (2026-10-28): the project is live. Steps 1-3 are done and the functions are deployed by hand;
step 4 (deploying from GitHub with no stored key) is next.

Project: `golf-live-scoring-app-510200` (number `1007271383987`). Region: `us-central1` (Firestore's
region is permanent).

## 1. Blaze plan (done)

Cloud Functions needs the Blaze plan. Upgraded by Jake on 2026-10-24.

## 2. Budget alert (still to do, Jake)

Budgets alert; they do not cap spend. Console route: Google Cloud console > Billing > Budgets and
alerts > Create budget, scoped to this project, amount 10 USD, alert thresholds at 10%, 50% and 100%,
emailed to Jake. Command-line route (needs `gcloud auth login`):

```bash
BILLING_ACCOUNT=XXXXXX-XXXXXX-XXXXXX   # gcloud billing accounts list
gcloud billing budgets create --billing-account="$BILLING_ACCOUNT" \
  --display-name="golf-live-scoring-app monthly" --budget-amount=10USD \
  --filter-projects=projects/golf-live-scoring-app-510200 \
  --threshold-rule=percent=0.1 --threshold-rule=percent=0.5 --threshold-rule=percent=1.0
```

## 3. Deploying by hand (what we have used so far)

From the repo root:

```bash
npx --prefix functions firebase deploy --only firestore --project golf-live-scoring-app-510200
npx --prefix functions firebase deploy --only functions --project golf-live-scoring-app-510200
npx --prefix functions firebase functions:list --project golf-live-scoring-app-510200
```

Things the first deploys taught us (all invisible to the emulator tests):

- **Build permission.** The first functions deploy failed with "missing permission on the build
  service account". Fixed by granting `roles/cloudbuild.builds.builder` to the default Compute
  account (`1007271383987-compute@developer.gserviceaccount.com`). That grant is still needed until
  builds get their own account.
- **Public invoker.** Each function is a Cloud Run service and must allow `allUsers` the role
  `roles/run.invoker`, or the browser's CORS preflight is rejected before our code runs. The deploy
  did not set it; Jake added it in the console. The functions still check sign-in themselves (an
  anonymous call returns `401 UNAUTHENTICATED`). Redeploying an existing function keeps this
  setting; a brand-new function may need it added again.
- **Runtime identity.** Functions run as the dedicated account
  `functions-runtime@golf-live-scoring-app-510200.iam.gserviceaccount.com` (roles
  `roles/datastore.user` and `roles/logging.logWriter` only). The name comes from the
  `RUNTIME_SERVICE_ACCOUNT` setting in `functions/.env`; use a `.env.<alias>` file for another
  environment. The default Compute account has no Firestore permission on this project.
- **Check after every deploy:** anonymous probes should still return 401, and a signed-in action
  should work; read the production logs for errors.

Rollback: rules and indexes keep a history in the console (Firestore > Rules > history); a function
is removed with `firebase functions:delete <name>`, or redeploy the previous commit.

## 4. Deploy from GitHub with no stored key (Workload Identity Federation)

Lesson carried over from the AWS setup: trust the numeric repository and owner IDs, never the
repository name, because a name can be re-registered by someone else after a rename or deletion.
IDs: owner `41297707`, `golf-app-backend` `1389607136`.

One-time setup, from PowerShell after `gcloud auth login` (`winget install Google.CloudSDK` if it is
not installed):

```powershell
.\ops\setup-wif.ps1
```

The script is idempotent and prints the values to add in GitHub (repo Settings > Secrets and
variables > Actions > **Variables**): `GCP_PROJECT_ID`, `WIF_PROVIDER`, `WIF_SERVICE_ACCOUNT`, and
`FIREBASE_API_KEY` (the public web `apiKey` from `golf-app-client/lib/firebase_options.dart`, used by
the post-deploy smoke test; without it the smoke step is skipped with a warning). Re-run it after
pulling a version that adds roles (the smoke test needs `firebaseauth.admin`, `datastore.user` and
permission to sign tokens as the deployer). It
creates the pool and provider (trusting only this repository by ID), the `github-deployer` service
account, its roles, permission to act as only the runtime and build accounts, and GitHub's permission
to impersonate it.

Then run the "Deploy to Google Cloud" workflow from the Actions tab (scope `all` the first time). It
deploys only what changed since the last deploy (the `deployed-gcp` tag), then runs the smoke test
(`functions/scripts/smoke.mjs`) against the live URLs: three throwaway users, a tournament walked through
create, join, teams, Start and the feed, then cleanup. A failed smoke test fails the run and leaves the
tag where it was. `npm run smoke:emulated` runs the same script against the emulators (CI does this).
Never run it against production by hand unless you mean to: it creates and deletes real users and data.
Not yet validated by a real
run: expect to adjust a role if a deploy reports a missing permission, and tighten the broad roles
(`firebase.admin`, `run.admin`, `cloudfunctions.admin`) afterwards.

## 5. After it is live

Dashboards, alert policies and the usage-metering client (plan Phase 5 and the Observability section),
a QA environment (go-live gate in the plan), and a post-deploy smoke test step in the workflow.
