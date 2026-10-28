import { describe, expect, it } from 'vitest';

import { call, joinedPlayer, listDocs, myRosterEntries, newTrip, ok, readDoc, refused, signUp } from './helpers';

// HTTP-level joinTournament and what joining unlocks.
describe('joinTournament over HTTP', { timeout: 60_000 }, () => {
  it('rejects a call with no sign-in token', async () => {
    const res = await call(null, 'joinTournament', { inviteCode: 'ABC123' });
    expect(res.http).toBe(401);
    expect(res.error?.status).toBe('UNAUTHENTICATED');
  });

  it('joins by invite code, and joining twice neither duplicates nor moves joinedAt', async () => {
    const trip = await newTrip();
    const player = await signUp('joiner');

    const first = await ok(player, 'joinTournament', { inviteCode: trip.inviteCode });
    expect(first).toMatchObject({ tournamentId: trip.tournamentId, name: 'HTTP Cup', alreadyMember: false });
    const entry = `tournaments/${trip.tournamentId}/players/${player.uid}`;
    const joinedAt = (await readDoc(player, entry)).data?.joinedAt;
    expect(joinedAt).toBeDefined();

    const again = await ok(player, 'joinTournament', { inviteCode: trip.inviteCode });
    expect(again.alreadyMember).toBe(true);
    expect((await readDoc(player, entry)).data?.joinedAt).toBe(joinedAt);

    const roster = await listDocs(trip.organizer, `tournaments/${trip.tournamentId}/players`);
    expect(roster.docs.map((d) => d.id).sort()).toEqual([trip.organizer.uid, player.uid].sort());
  });

  it('accepts the code in lower case with stray spaces', async () => {
    const trip = await newTrip();
    const player = await signUp('sloppy');
    const result = await ok(player, 'joinTournament', { inviteCode: ` ${trip.inviteCode.toLowerCase()} ` });
    expect(result.tournamentId).toBe(trip.tournamentId);
  });

  it('refuses a wrong, malformed or missing code with the same answer, and does not join', async () => {
    const trip = await newTrip();
    const player = await signUp('guesser');
    const wrong = await refused(player, 'joinTournament', { inviteCode: 'NOPE9999' }, 'NOT_FOUND');
    expect(await refused(player, 'joinTournament', { inviteCode: 'bad/code' }, 'NOT_FOUND')).toBe(wrong);
    await refused(player, 'joinTournament', {}, 'INVALID_ARGUMENT');
    await refused(player, 'joinTournament', { inviteCode: '   ' }, 'INVALID_ARGUMENT');
    expect((await readDoc(player, `tournaments/${trip.tournamentId}/players/${player.uid}`)).http).toBe(403);
  });

  it('gives a new member the roster, the invite code and their tournament list, but not strangers', async () => {
    const trip = await newTrip();
    const member = await joinedPlayer(trip);
    const stranger = await signUp('outsider');
    const base = `tournaments/${trip.tournamentId}`;

    expect((await readDoc(member, base)).http).toBe(200);
    expect((await listDocs(member, `${base}/players`)).docs).toHaveLength(2);
    expect((await readDoc(member, `${base}/private/settings`)).data?.inviteCode).toBe(trip.inviteCode);
    expect((await myRosterEntries(member, member.uid)).paths).toContain(`${base}/players/${member.uid}`);

    expect((await readDoc(stranger, base)).http).toBe(403);
    expect((await readDoc(stranger, `${base}/private/settings`)).http).toBe(403);
  });

  it('shows a member the other players\' public profiles but no email addresses', async () => {
    const trip = await newTrip();
    const member = await joinedPlayer(trip, 'friend');
    expect((await readDoc(member, `players/${trip.organizer.uid}`)).data?.displayName).toBe('Organizer');
    expect((await readDoc(member, `players/${trip.organizer.uid}/private/profile`)).http).toBe(403);
  });
});
