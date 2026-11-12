import { describe, expect, it } from 'vitest';

import { joinedPlayer, listDocs, newTrip, ok, queryCollection, readDoc, refused, signUp, writeDoc } from './helpers';

// Groups over HTTP: set by an admin, read back by members under the security rules.

async function tripWithRound(extra: Record<string, unknown> = {}) {
  const trip = await newTrip();
  const players = [];
  for (const label of ['ann', 'bob', 'cat', 'dan', 'eve']) players.push(await joinedPlayer(trip, label));
  const round = await ok(trip.organizer, 'createRound', { tournamentId: trip.tournamentId, date: '2026-11-14', ...extra });
  return { trip, players, round };
}

const ids = (...users: { uid: string }[]) => users.map((u) => u.uid);

describe('setGroups', { timeout: 60_000 }, () => {
  it('an organizer sets uneven groups with a tee time and a shotgun start, and members read them', async () => {
    const { trip, players, round } = await tripWithRound();
    const [ann, bob, cat, dan, eve] = players;
    const result = await ok(trip.organizer, 'setGroups', {
      tournamentId: trip.tournamentId,
      roundId: round.id,
      groups: [
        { playerIds: ids(ann, bob, cat), teeTime: '2026-11-14T13:30:00-06:00' },
        { playerIds: ids(dan, eve), teeHole: 5 },
      ],
    });
    expect(result.groups.map((g: any) => [g.order, g.playerIds.length, g.teeHole])).toEqual([
      [1, 3, 1],
      [2, 2, 5],
    ]);

    const path = `tournaments/${trip.tournamentId}/rounds/${round.id}/groups`;
    const listed = await listDocs(ann, path);
    expect(listed.http).toBe(200);
    expect(listed.docs).toHaveLength(2);
    const first = listed.docs.find((d) => d.data.order === 1)!;
    expect(first.data.playerIds).toEqual(ids(ann, bob, cat));
    expect(first.data.teeTime).toBe('2026-11-14T19:30:00Z');
    expect((await readDoc(ann, `${path}/${first.id}`)).http).toBe(200);
  });

  it('a player cannot set groups, and a stranger cannot read them', async () => {
    const { trip, players, round } = await tripWithRound();
    const stranger = await signUp('stranger');
    const body = { tournamentId: trip.tournamentId, roundId: round.id, groups: [{ playerIds: ids(players[0]) }] };
    await refused(players[0], 'setGroups', body, 'PERMISSION_DENIED');
    await ok(trip.organizer, 'setGroups', body);
    expect((await listDocs(stranger, `tournaments/${trip.tournamentId}/rounds/${round.id}/groups`)).http).toBe(403);
    expect((await listDocs(null, `tournaments/${trip.tournamentId}/rounds/${round.id}/groups`)).http).toBe(403);
  });

  it('refuses someone who is not on the roster, a group over the limit, and a repeated player', async () => {
    const { trip, players, round } = await tripWithRound({ maxGroupSize: 2 });
    const outsider = await signUp('outsider');
    const base = { tournamentId: trip.tournamentId, roundId: round.id };
    await refused(trip.organizer, 'setGroups', { ...base, groups: [{ playerIds: ids(players[0], outsider) }] }, 'FAILED_PRECONDITION');
    await refused(trip.organizer, 'setGroups', { ...base, groups: [{ playerIds: ids(players[0], players[1], players[2]) }] }, 'INVALID_ARGUMENT');
    await refused(trip.organizer, 'setGroups', { ...base, groups: [{ playerIds: ids(players[0]) }, { playerIds: ids(players[0]) }] }, 'INVALID_ARGUMENT');
    await refused(trip.organizer, 'setGroups', { ...base, groups: [{ playerIds: ids(players[0]), teeTime: '2pm' }] }, 'INVALID_ARGUMENT');
    expect((await listDocs(players[0], `tournaments/${trip.tournamentId}/rounds/${round.id}/groups`)).docs).toHaveLength(0);
  });

  it('tells members when a tee time that was already published moves', async () => {
    const { trip, players, round } = await tripWithRound();
    const base = { tournamentId: trip.tournamentId, roundId: round.id };
    const first = await ok(trip.organizer, 'setGroups', {
      ...base,
      groups: [{ playerIds: ids(players[0], players[1]), teeTime: '2026-11-14T13:30:00-06:00' }],
    });
    await ok(trip.organizer, 'setGroups', {
      ...base,
      groups: [{ id: first.groups[0].id, playerIds: ids(players[0], players[1]), teeTime: '2026-11-14T14:00:00-06:00' }],
    });
    const feed = await queryCollection(players[0], `tournaments/${trip.tournamentId}`, 'activity', [['level', 'all']]);
    const moved = feed.docs.filter((d) => d.data.type === 'tee_time_changed');
    expect(moved).toHaveLength(1);
    expect(moved[0].data).toMatchObject({ category: 'essentials', level: 'all' });
  });

  it('refuses a client write to a group', async () => {
    const { trip, players, round } = await tripWithRound();
    const made = await ok(trip.organizer, 'setGroups', {
      tournamentId: trip.tournamentId,
      roundId: round.id,
      groups: [{ playerIds: ids(players[0]) }],
    });
    expect(await writeDoc(trip.organizer, `tournaments/${trip.tournamentId}/rounds/${round.id}/groups/${made.groups[0].id}`)).toBe(403);
  });
});
