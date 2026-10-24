import { initializeApp } from 'firebase-admin/app';
import { Firestore, getFirestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createTournament, generateInviteCode } from '../src/tournaments';
import { UsageTracker } from '../src/usage';

// Needs the Firestore emulator: run via `npm run test:emulated`.

let db: Firestore;

beforeAll(() => {
  db = getFirestore(initializeApp({ projectId: 'demo-golf-tournaments' }, 'tournaments-test'));
});

beforeEach(async () => {
  await db.recursiveDelete(db.collection('tournaments'));
  await db.recursiveDelete(db.collection('inviteCodes'));
});

async function rejection(promise: Promise<unknown>): Promise<HttpsError> {
  try {
    await promise;
  } catch (err) {
    return err as HttpsError;
  }
  throw new Error('expected the call to be rejected');
}

describe('generateInviteCode', () => {
  it('is 8 characters from the unambiguous alphabet', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateInviteCode()).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    }
  });
});

describe('createTournament', () => {
  it('creates the tournament, organizer roster entry, private invite code and lookup together', async () => {
    const usage = new UsageTracker();
    const result = await createTournament(
      db,
      'org1',
      { name: '  Pebble Trip  ', startDate: '2026-11-14', endDate: '2026-11-16' },
      usage,
    );

    expect(result).toMatchObject({
      name: 'Pebble Trip',
      startDate: '2026-11-14',
      endDate: '2026-11-16',
      visibility: 'private',
    });
    expect(result.inviteCode).toMatch(/^[A-Z2-9]{8}$/);
    expect(result.inviteCode).not.toBe(result.id);

    const tRef = db.collection('tournaments').doc(result.id);
    const tournament = (await tRef.get()).data();
    expect(tournament).toMatchObject({
      name: 'Pebble Trip',
      organizerId: 'org1',
      coAdminId: null,
      visibility: 'private',
      status: 'active',
      wagerPotAmount: null,
    });
    expect(tournament?.createdAt).toBeDefined();
    expect(tournament).not.toHaveProperty('inviteCode'); // spectators can read this document

    const roster = (await tRef.collection('players').doc('org1').get()).data();
    expect(roster).toMatchObject({ playerId: 'org1', teamId: null, handicap: null });
    expect(roster?.joinedAt).toBeDefined();

    expect((await tRef.collection('private').doc('settings').get()).data()).toMatchObject({
      inviteCode: result.inviteCode,
    });
    expect((await db.collection('inviteCodes').doc(result.inviteCode).get()).data()).toMatchObject({
      tournamentId: result.id,
    });

    expect(usage.tournamentId).toBe(result.id);
    expect(usage.docsWritten).toBe(4);
  });

  it('allows dates to be omitted and visibility to be public', async () => {
    const result = await createTournament(db, 'org1', { name: 'Open Day', visibility: 'public' }, new UsageTracker());
    expect(result).toMatchObject({ startDate: null, endDate: null, visibility: 'public' });
    expect((await db.collection('tournaments').doc(result.id).get()).data()).toMatchObject({
      startDate: null,
      endDate: null,
      visibility: 'public',
    });
  });

  it('gives two tournaments different ids and invite codes', async () => {
    const a = await createTournament(db, 'org1', { name: 'A' }, new UsageTracker());
    const b = await createTournament(db, 'org1', { name: 'B' }, new UsageTracker());
    expect(a.id).not.toBe(b.id);
    expect(a.inviteCode).not.toBe(b.inviteCode);
  });

  it('retries with a fresh code when the first one is already taken, leaving no partial writes', async () => {
    await db.collection('inviteCodes').doc('TAKEN234').set({ tournamentId: 'other' });
    const codes = ['TAKEN234', 'FRESH567'];
    const result = await createTournament(db, 'org1', { name: 'Retry' }, new UsageTracker(), () => codes.shift()!);

    expect(result.inviteCode).toBe('FRESH567');
    expect((await db.collection('inviteCodes').doc('TAKEN234').get()).data()).toEqual({ tournamentId: 'other' });
    expect((await db.collection('tournaments').get()).size).toBe(1);
  });

  it('gives up with no partial writes if every code collides', async () => {
    await db.collection('inviteCodes').doc('TAKEN234').set({ tournamentId: 'other' });
    await expect(
      createTournament(db, 'org1', { name: 'Stuck' }, new UsageTracker(), () => 'TAKEN234'),
    ).rejects.toBeDefined();
    expect((await db.collection('tournaments').get()).size).toBe(0);
  });

  it.each([
    ['missing name', {}, 'name'],
    ['blank name', { name: '   ' }, 'name'],
    ['non-string name', { name: 5 }, 'name'],
    ['over-long name', { name: 'x'.repeat(101) }, 'name'],
    ['malformed date', { name: 'T', startDate: '14/11/2026' }, 'startDate'],
    ['impossible date', { name: 'T', endDate: '2026-02-30' }, 'endDate'],
    ['end before start', { name: 'T', startDate: '2026-11-16', endDate: '2026-11-14' }, 'endDate'],
    ['unknown visibility', { name: 'T', visibility: 'friends' }, 'visibility'],
  ])('rejects %s without writing anything', async (_label, input, mention) => {
    const err = await rejection(createTournament(db, 'org1', input as never, new UsageTracker()));
    expect(err.code).toBe('invalid-argument');
    expect(err.message).toContain(mention);
    expect((await db.collection('tournaments').get()).size).toBe(0);
    expect((await db.collection('inviteCodes').get()).size).toBe(0);
  });
});
