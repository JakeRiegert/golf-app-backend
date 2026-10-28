import { setGlobalOptions } from 'firebase-functions/v2';
import { defineString } from 'firebase-functions/params';

// The identity every function runs as: a least-privilege account (Firestore access and log
// writing only) instead of the project's shared default. The trailing "@" is Firebase shorthand
// for "this project's domain", so the same name resolves in dev, QA and prod. Override per
// environment with RUNTIME_SERVICE_ACCOUNT in a .env.<alias> file.
const runtimeServiceAccount = defineString('RUNTIME_SERVICE_ACCOUNT', {
  default: 'functions-runtime@',
});

// Region matches the Firestore database (us-central1; permanent). maxInstances is also a cost
// brake: it bounds how far any single function can scale out if something loops or is abused.
setGlobalOptions({
  region: 'us-central1',
  maxInstances: 10,
  serviceAccount: runtimeServiceAccount,
});
