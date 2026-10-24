import { getApps, initializeApp } from 'firebase-admin/app';
import { Firestore, getFirestore } from 'firebase-admin/firestore';

// Admin SDK handle. Admin access bypasses security rules, which is the point: every write goes
// through a function that does its own authorization. Initialized lazily so tests can inject
// their own Firestore instead.
export function getDb(): Firestore {
  if (getApps().length === 0) {
    initializeApp();
  }
  return getFirestore();
}
