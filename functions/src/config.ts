import { setGlobalOptions } from 'firebase-functions/v2';

// Region matches the Firestore database (us-central1; permanent). maxInstances is also a cost
// brake: it bounds how far any single function can scale out if something loops or is abused.
setGlobalOptions({ region: 'us-central1', maxInstances: 10 });
