import { initializeApp } from 'firebase-admin/app';
import { Firestore, getFirestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { upsertProfile } from '../src/players';
import { UsageTracker } from '../src/usage';

// Needs the Firestore emulator: run via `npm run test:emulated` (it sets
// FIRESTORE_EMULATOR_HOST, which the Admin SDK picks up automatically).

let db: Firestore;

beforeAll(() => {
  db = getFirestore(initializeApp({ projectId: 'demo-golf-players' }, 'players-test'));
});

beforeEach(async () => {
  await db.recursiveDelete(db.collection('players'));
});

const google = { email: 'jake@example.com', name: 'Jake Riegert', picture: 'https://example.com/jake.png' };
const emailOnly = { email: 'riegert.6@osu.edu' };

async function profileOf(uid: string) {
  return (await db.collection('players').doc(uid).get()).data();
}
async function privateOf(uid: string) {
  return (await db.collection('players').doc(uid).collection('private').doc('profile').get()).data();
}

describe('upsertProfile', () => {
  it('seeds name and photo from the sign-in provider on first call, and stores email privately', async () => {
    const usage = new UsageTracker();
    const result = await upsertProfile(db, 'u1', google, {}, usage);

    expect(result).toEqual({ id: 'u1', displayName: 'Jake Riegert', avatarUrl: 'https://example.com/jake.png' });

    const pub = await profileOf('u1');
    expect(pub).toMatchObject({ displayName: 'Jake Riegert', avatarUrl: 'https://example.com/jake.png' });
    expect(pub?.createdAt).toBeDefined();
    expect(pub?.updatedAt).toBeDefined();
    expect(pub).not.toHaveProperty('email'); // email must never be on the public document

    expect(await privateOf('u1')).toMatchObject({ email: 'jake@example.com' });
    expect(usage.docsRead).toBe(1);
    expect(usage.docsWritten).toBe(2);
  });

  it('leaves name null for an email/password user with no provider name', async () => {
    const result = await upsertProfile(db, 'u2', emailOnly, {}, new UsageTracker());
    expect(result).toEqual({ id: 'u2', displayName: null, avatarUrl: null });
    expect(await privateOf('u2')).toMatchObject({ email: 'riegert.6@osu.edu' });
  });

  it('keeps createdAt and the existing name on a repeat call, and refreshes updatedAt', async () => {
    await upsertProfile(db, 'u3', google, { displayName: 'Custom Name' }, new UsageTracker());
    const first = await profileOf('u3');

    const second = await upsertProfile(db, 'u3', google, {}, new UsageTracker());
    const after = await profileOf('u3');

    expect(second.displayName).toBe('Custom Name'); // not reset to the Google name
    expect(after?.createdAt.isEqual(first?.createdAt)).toBe(true);
    expect(after?.updatedAt.toMillis()).toBeGreaterThanOrEqual(first?.updatedAt.toMillis());
  });

  it('lets an explicit displayName override and trims it', async () => {
    const result = await upsertProfile(db, 'u4', google, { displayName: '  Birdie Boss  ' }, new UsageTracker());
    expect(result.displayName).toBe('Birdie Boss');
    expect((await profileOf('u4'))?.displayName).toBe('Birdie Boss');
  });

  it('rejects bad input without writing anything', async () => {
    const bad = [
      { displayName: '' },
      { displayName: '   ' },
      { displayName: 'x'.repeat(51) },
      { displayName: 42 as unknown as string },
      { avatarUrl: 'http://example.com/a.png' },
      { avatarUrl: 'javascript:alert(1)' },
    ];
    for (const input of bad) {
      await expect(upsertProfile(db, 'u5', google, input, new UsageTracker())).rejects.toBeInstanceOf(HttpsError);
    }
    expect(await profileOf('u5')).toBeUndefined();
  });
});
