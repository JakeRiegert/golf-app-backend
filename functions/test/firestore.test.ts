import { deleteApp, getApps, initializeApp } from 'firebase-admin/app';
import { afterEach, describe, expect, it } from 'vitest';
import { getDb } from '../src/firestore';

// Regression: in production the Functions framework registers its own named app before our code
// runs, so a check for "no apps at all" skipped initializeApp() and getFirestore() threw
// "default app does not exist".
describe('getDb', () => {
  afterEach(async () => {
    await Promise.all(getApps().map((app) => deleteApp(app)));
  });

  it('initializes the default app when only a named app exists', () => {
    initializeApp({ projectId: 'demo-golf-unit' }, 'framework-internal');
    expect(() => getDb()).not.toThrow();
  });

  it('reuses the default app on repeat calls', () => {
    getDb();
    getDb();
    expect(getApps().filter((app) => app.name === '[DEFAULT]')).toHaveLength(1);
  });
});
