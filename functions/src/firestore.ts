import { getApps, initializeApp } from 'firebase-admin/app';
import { Firestore, getFirestore } from 'firebase-admin/firestore';

// Admin SDK handle. Admin access bypasses security rules, which is the point: every write goes
// through a function that does its own authorization. Initialized lazily so tests can inject
// their own Firestore instead. The check is for the default app specifically: the Functions
// framework can register its own named app, so "any app exists" is not the same thing.
export function getDb(): Firestore {
  if (!getApps().some((app) => app.name === '[DEFAULT]')) {
    initializeApp();
  }
  return getFirestore();
}
