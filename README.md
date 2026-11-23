# golf-app-backend

Backend for the golf live-scoring app: Firebase Auth, Cloud Firestore and callable Cloud Functions (TypeScript, Node 22)
in the Google Cloud project `golf-live-scoring-app-510200` (us-central1).

(The first version ran on AWS: CDK, Lambda, AppSync, DynamoDB, Cognito. That code is kept at the git tag `aws-final`.)

## Layout

- `functions/` the Cloud Functions (`src/`), unit, emulator, HTTP and rules tests (`test/`), and helper scripts (`scripts/`)
- `firestore.rules`, `firestore.indexes.json` the database rules and indexes
- `ops/` runbooks: `DEPLOY.md` (deploying, the pipeline and its one-time setup), QA checklists and prompts

## Working on it

```bash
cd functions
npm ci
npm run build
npm test               # unit tests, no emulator
npm run test:emulated  # Firestore emulator tests
npm run test:http      # real HTTP calls with real sign-in tokens, against the Auth/Functions/Firestore emulators
```

## Deploying

Pushing to `main` is the deploy: CI runs every test, and when it passes `.github/workflows/deploy-gcp.yml` deploys what
changed, makes the callables public, checks that anonymous callers get 401, runs a smoke test, and records what is live
(the `deployed-gcp` tag). See `ops/DEPLOY.md`. The client repo (`golf-app-client`) deploys its Hosting site after this
one has finished.
