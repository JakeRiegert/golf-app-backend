# One-time setup so GitHub Actions can deploy to Google Cloud without a stored key.
# Run from PowerShell after `gcloud auth login`:   .\ops\setup-wif.ps1
# Safe to re-run: every step checks whether it already exists first.
#
# What it creates (all in the project below):
#   1. A Workload Identity pool + GitHub provider. The provider only trusts tokens from this one
#      repository, matched by NUMERIC repository and owner IDs (names can be re-registered by
#      someone else after a rename or deletion; IDs cannot).
#   2. A service account `github-deployer` that GitHub's deploy job acts as.
#   3. Roles for it: Firebase Admin, Cloud Functions Admin, Cloud Run Admin (to keep the public
#      invoker setting), Service Usage Consumer. Broad on purpose to start; tighten later.
#   4. Permission to "act as" ONLY the two service accounts a deploy needs (the runtime account
#      functions-runtime, and the build account), not every account in the project.
#   5. Permission for GitHub's token to impersonate github-deployer, for this repository only.
param(
  [string]$Project = 'golf-live-scoring-app-510200',
  [string]$OwnerId = '41297707',     # GitHub user JakeRiegert
  [string]$RepoId  = '1389607136'    # JakeRiegert/golf-app-backend
)

function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Exists { param([scriptblock]$Check) & $Check *> $null; return ($LASTEXITCODE -eq 0) }

$number   = (gcloud projects describe $Project --format='value(projectNumber)').Trim()
$deployer = "github-deployer@$Project.iam.gserviceaccount.com"
$runtime  = "functions-runtime@$Project.iam.gserviceaccount.com"
$build    = "$number-compute@developer.gserviceaccount.com"
Write-Host "Project $Project (number $number)"

Step 'Enable the APIs Workload Identity needs'
gcloud services enable iamcredentials.googleapis.com sts.googleapis.com cloudresourcemanager.googleapis.com --project=$Project

Step 'Workload Identity pool "github"'
if (Exists { gcloud iam workload-identity-pools describe github --location=global --project=$Project }) {
  Write-Host 'already exists'
} else {
  gcloud iam workload-identity-pools create github --project=$Project --location=global --display-name='GitHub Actions'
}

Step 'Provider "github-actions" (trusts only this repository, by numeric ID)'
if (Exists { gcloud iam workload-identity-pools providers describe github-actions --workload-identity-pool=github --location=global --project=$Project }) {
  Write-Host 'already exists'
} else {
  $mapping   = 'google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id'
  $condition = "assertion.repository_owner_id=='$OwnerId' && assertion.repository_id=='$RepoId'"
  gcloud iam workload-identity-pools providers create-oidc github-actions --project=$Project --location=global `
    --workload-identity-pool=github --issuer-uri='https://token.actions.githubusercontent.com' `
    --attribute-mapping=$mapping --attribute-condition=$condition
}

Step 'Service account github-deployer'
if (Exists { gcloud iam service-accounts describe $deployer --project=$Project }) {
  Write-Host 'already exists'
} else {
  gcloud iam service-accounts create github-deployer --project=$Project --display-name='GitHub Actions deployer'
}

Step 'Project roles for github-deployer'
# firebaseauth.admin and datastore.user are for the post-deploy smoke test, which creates and deletes
# throwaway users and test data.
foreach ($role in 'roles/firebase.admin', 'roles/cloudfunctions.admin', 'roles/run.admin', 'roles/serviceusage.serviceUsageConsumer', 'roles/firebaseauth.admin', 'roles/datastore.user') {
  gcloud projects add-iam-policy-binding $Project --member="serviceAccount:$deployer" --role=$role --condition=None --quiet | Out-Null
  Write-Host "granted $role"
}

Step 'Let github-deployer act as the runtime and build accounts only'
foreach ($target in $runtime, $build) {
  gcloud iam service-accounts add-iam-policy-binding $target --project=$Project --member="serviceAccount:$deployer" --role=roles/iam.serviceAccountUser --quiet | Out-Null
  Write-Host "may act as $target"
}

Step 'Let github-deployer sign custom tokens as itself (the smoke test signs throwaway users in)'
gcloud iam service-accounts add-iam-policy-binding $deployer --project=$Project --member="serviceAccount:$deployer" --role=roles/iam.serviceAccountTokenCreator --quiet | Out-Null
Write-Host "may sign tokens as $deployer"

Step 'Let GitHub (this repository only) impersonate github-deployer'
$principal = "principalSet://iam.googleapis.com/projects/$number/locations/global/workloadIdentityPools/github/attribute.repository_id/$RepoId"
gcloud iam service-accounts add-iam-policy-binding $deployer --project=$Project --role=roles/iam.workloadIdentityUser --member=$principal --quiet | Out-Null
Write-Host "bound $principal"

Write-Host "`n=================================================================" -ForegroundColor Green
Write-Host 'Done. In GitHub, repo golf-app-backend > Settings > Secrets and variables > Actions >'
Write-Host 'Variables, add these three REPOSITORY VARIABLES (not secrets):'
Write-Host "  GCP_PROJECT_ID       $Project"
Write-Host "  WIF_PROVIDER         projects/$number/locations/global/workloadIdentityPools/github/providers/github-actions"
Write-Host "  WIF_SERVICE_ACCOUNT  $deployer"
Write-Host '  FIREBASE_API_KEY     the web apiKey from golf-app-client/lib/firebase_options.dart (public, used by the smoke test)'
