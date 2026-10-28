import { describe, expect, it } from 'vitest';

import { call, myRosterEntries, newTrip, ok, readDoc, refused, listDocs, signUp, writeDoc } from './helpers';

// HTTP-level createTournament plus who can read what it creates.
describe('createTournament over HTTP', { timeout: 60_000 }, () => {
  it('rejects a call with no sign-in token', async () => {
    const res = await call(null, 'createTournament', { name: 'Anon Cup' });
    expect(res.http).toBe(401);
    expect(res.error?.status).toBe('UNAUTHENTICATED');
  });

  it('creates a private tournament with a separate invite code, and the organizer joins their own roster', async () => {
    const trip = await newTrip({ startDate: '2026-11-14', endDate: '2026-11-16' });
    expect(trip.inviteCode).toMatch(/^[A-Z0-9]+$/);
    expect(trip.inviteCode).not.toBe(trip.tournamentId);

    const doc = await readDoc(trip.organizer, `tournaments/${trip.tournamentId}`);
    expect(doc.data).toMatchObject({
      name: 'HTTP Cup',
      organizerId: trip.organizer.uid,
      visibility: 'private',
      status: 'active',
      startDate: '2026-11-14',
      endDate: '2026-11-16',
    });
    expect((await readDoc(trip.organizer, `tournaments/${trip.tournamentId}/private/settings`)).data?.inviteCode).toBe(
      trip.inviteCode,
    );
    expect((await readDoc(trip.organizer, `tournaments/${trip.tournamentId}/players/${trip.organizer.uid}`)).http).toBe(
      200,
    );
  });

  it('rejects bad input', async () => {
    const user = await signUp('creator');
    await refused(user, 'createTournament', {}, 'INVALID_ARGUMENT');
    await refused(user, 'createTournament', { name: '   ' }, 'INVALID_ARGUMENT');
    await refused(user, 'createTournament', { name: 'x'.repeat(101) }, 'INVALID_ARGUMENT');
    await refused(user, 'createTournament', { name: 'Cup', startDate: '2026-13-45' }, 'INVALID_ARGUMENT');
    await refused(user, 'createTournament', { name: 'Cup', startDate: '2026-11-16', endDate: '2026-11-14' }, 'INVALID_ARGUMENT');
    await refused(user, 'createTournament', { name: 'Cup', visibility: 'friends' }, 'INVALID_ARGUMENT');
  });

  it('keeps a private tournament, its roster and its invite code from a stranger and from anonymous', async () => {
    const trip = await newTrip();
    const stranger = await signUp('stranger');
    const base = `tournaments/${trip.tournamentId}`;

    for (const viewer of [stranger, null]) {
      expect((await readDoc(viewer, base)).http).toBe(403);
      expect((await readDoc(viewer, `${base}/private/settings`)).http).toBe(403);
      expect((await listDocs(viewer, `${base}/players`)).http).toBe(403);
    }
  });

  it('lets a stranger spectate a public tournament, but never see the invite code or any email', async () => {
    const trip = await newTrip({ visibility: 'public' });
    const stranger = await signUp('spectator');
    const base = `tournaments/${trip.tournamentId}`;

    expect((await readDoc(stranger, base)).data).toMatchObject({ visibility: 'public' });
    const roster = await listDocs(stranger, `${base}/players`);
    expect(roster.http).toBe(200);
    expect(roster.docs.map((d) => d.id)).toEqual([trip.organizer.uid]);
    expect(JSON.stringify(roster.docs)).not.toContain('@');
    expect((await readDoc(stranger, `${base}/private/settings`)).http).toBe(403);
    expect((await readDoc(null, base)).http).toBe(403); // anonymous still sees nothing
  });

  it('never exposes the invite-code lookup collection, even to the organizer', async () => {
    const trip = await newTrip();
    expect((await readDoc(trip.organizer, `inviteCodes/${trip.inviteCode}`)).http).toBe(403);
    expect((await listDocs(trip.organizer, 'inviteCodes')).http).toBe(403);
  });

  it('refuses direct client writes to the tournament, even by the organizer', async () => {
    const trip = await newTrip();
    expect(await writeDoc(trip.organizer, `tournaments/${trip.tournamentId}`)).toBe(403);
    expect(await writeDoc(trip.organizer, `tournaments/${trip.tournamentId}/private/settings`)).toBe(403);
  });

  it('answers "my tournaments" for the player themselves and no one else', async () => {
    const trip = await newTrip();
    const stranger = await signUp('nosy');

    const mine = await myRosterEntries(trip.organizer, trip.organizer.uid);
    expect(mine.http).toBe(200);
    expect(mine.paths).toContain(`tournaments/${trip.tournamentId}/players/${trip.organizer.uid}`);

    expect((await myRosterEntries(stranger, trip.organizer.uid)).http).toBe(403);
    expect((await myRosterEntries(null, trip.organizer.uid)).http).toBe(403);
  });
});
