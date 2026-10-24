# Deploying to Google Cloud

Nothing has been deployed yet: everything so far runs in the local emulators. This is the order to
go live in. Steps 1 and 2 are yours (they need your Google account and card); the rest are commands.

Project: `golf-live-scoring-app-510200`. Region: `us-central1` (Firestore's region is permanent).

## 1. Upgrade to the Blaze plan (needed for Cloud Functions)

Firebase console > the project > Usage and billing > Modify plan > Blaze, and link a billing
account. Rules and indexes deploy on the free plan, but Cloud Functions will not.

## 2. Set a budget alert before anything else

Budgets alert; they do not cap spend. Console route (no tooling needed): Google Cloud console >
Billing > Budgets and alerts > Create budget, scoped to this project, amount 10 USD, alert
thresholds at 10%, 50% and 100% (that is roughly 1, 5 and 10 dollars), emailed to you.

Command-line route, once `gcloud` is installed (`winget install Google.CloudSDK`, then
`gcloud auth login`):

```bash
BILLING_ACCOUNT=XXXXXX-XXXXXX-XXXXXX   # gcloud billing accounts list
gcloud billing budgets create --billing-account="$BILLING_ACCOUNT" \
  --display-name="golf-live-scoring-app monthly" --budget-amount=10USD \
  --filter-projects=projects/golf-live-scoring-app-510200 \
  --threshold-rule=percent=0.1 --threshold-rule=percent=0.5 --threshold-rule=percent=1.0
```

## 3. First deploy, by hand

Run from the repo root. Deploy the data layer first, then the functions:

```bash
npx --prefix functions firebase deploy --only firestore --project golf-live-scoring-app-510200
npx --prefix functions firebase deploy --only functions --project golf-live-scoring-app-510200
```

The `functions` predeploy step builds the TypeScript first. Check afterwards:

```bash
npx --prefix functions firebase functions:list --project golf-live-scoring-app-510200
```

Expect 11 functions in `us-central1`. Then point the client at the real project (build without
`--dart-define=USE_EMULATORS=true`) and sign in; the profile screen should create your profile.

Rollback: rules and indexes keep a history in the console (Firestore > Rules > history); a function
is removed with `firebase functions:delete <name>`.

## 4. Let GitHub deploy without a stored key (Workload Identity Federation)

Lesson carried over from the AWS setup: trust the numeric repository and owner IDs, never the
repository name, because a name can be re-registered by someone else after a rename or deletion.
IDs for this repo: owner `41297707`, `golf-app-backend` `1389607136`.

```bash
PROJECT=golf-live-scoring-app-510200
PROJECT_NUMBER=$(gcloud projects describe $PROJECT --format='value(projectNumber)')

gcloud iam workload-identity-pools create github --project=$PROJECT --location=global \
  --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc github-actions --project=$PROJECT \
  --location=global --workload-identity-pool=github \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id" \
  --attribute-condition="assertion.repository_owner_id=='41297707' && assertion.repository_id=='1389607136'"

gcloud iam service-accounts create github-deployer --project=$PROJECT \
  --display-name="GitHub Actions deployer"

# Broad to start (Firebase Admin covers functions, rules and indexes); tighten later.
for ROLE in roles/firebase.admin roles/iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding $PROJECT \
    --member="serviceAccount:github-deployer@$PROJECT.iam.gserviceaccount.com" --role=$ROLE
done

gcloud iam service-accounts add-iam-policy-binding \
  github-deployer@$PROJECT.iam.gserviceaccount.com --project=$PROJECT \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository_id/1389607136"

echo "WIF_PROVIDER=projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/github-actions"
```

Then in GitHub (backend repo) > Settings > Secrets and variables > Actions > Variables, add
`GCP_PROJECT_ID`, `WIF_PROVIDER` and `WIF_SERVICE_ACCOUNT`
(`github-deployer@golf-live-scoring-app-510200.iam.gserviceaccount.com`), and run the "Deploy to
Google Cloud" workflow from the Actions tab.

Not yet verified end to end: these commands and the workflow were written but not run, because the
account setup above comes first. Expect to adjust role names if a deploy reports a missing permission.

## 5. After it is live

Dashboards, alert policies and the usage-metering client (plan Phase 5 and the Observability section)
are built against real traffic, so they come after the first deploy.
