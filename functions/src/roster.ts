import { FieldValue, Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';

import { announce, logActivity } from './activity';
import { assertAdmin, requireId, requireTournamentId } from './authz';
import { getDb } from './firestore';
import { MAX_ROSTER_SIZE, TOURNAMENT_STATUS } from './limits';
import { callable, UsageTracker } from './usage';

export interface JoinTournamentInput {
  inviteCode?: string;
}

export interface JoinedTournament {
  tournamentId: string;
  name: string;
  alreadyMember: boolean;
}

const NO_MATCH = 'No tournament matches that invite code';

// Join by invite code. Idempotent: the roster document ID is the uid, so joining twice never
// duplicates the player or moves joinedAt. Codes are matched case-insensitively and ignore
// surrounding whitespace (people type them from a card or a text message). Capacity is checked
// inside the transaction so two simultaneous joins cannot both take the last seat; someone who
// is already on the roster is always let through, even when the roster is full.
export async function joinTournament(
  db: Firestore,
  uid: string,
  input: JoinTournamentInput,
  usage: UsageTracker,
  maxRosterSize: number = MAX_ROSTER_SIZE,
): Promise<JoinedTournament> {
  if (typeof input.inviteCode !== 'string' || input.inviteCode.trim().length === 0) {
    throw new HttpsError('invalid-argument', 'inviteCode is required');
  }
  const inviteCode = input.inviteCode.trim().toUpperCase();
  // Invite codes are document IDs: reject anything that cannot be one before touching Firestore.
  if (!/^[A-Z0-9]{1,32}$/.test(inviteCode)) {
    throw new HttpsError('not-found', NO_MATCH);
  }

  const lookup = await db.collection('inviteCodes').doc(inviteCode).get();
  usage.read();
  const tournamentId = lookup.data()?.tournamentId as string | undefined;
  if (!tournamentId) {
    throw new HttpsError('not-found', NO_MATCH);
  }
  usage.forTournament(tournamentId);

  const tournamentRef = db.collection('tournaments').doc(tournamentId);
  const rosterRef = tournamentRef.collection('players');
  const memberRef = rosterRef.doc(uid);

  return db.runTransaction(async (tx) => {
    const tournamentSnap = await tx.get(tournamentRef);
    const memberSnap = await tx.get(memberRef);
    usage.read(2);
    const tournament = tournamentSnap.data();
    if (!tournament) {
      throw new HttpsError('not-found', NO_MATCH);
    }
    if (tournament.status !== TOURNAMENT_STATUS.ACTIVE) {
      throw new HttpsError('failed-precondition', 'This tournament is not accepting players right now');
    }
    const result = { tournamentId, name: tournament.name as string };
    if (memberSnap.exists) {
      return { ...result, alreadyMember: true };
    }

    const count = await tx.get(rosterRef.count());
    usage.read();
    usage.roster(count.data().count);
    if (count.data().count >= maxRosterSize) {
      throw new HttpsError('resource-exhausted', `This tournament is full (${maxRosterSize} players)`);
    }

    tx.create(memberRef, { playerId: uid, teamId: null, teamAssignedBy: null, handicap: null, handicapSetBy: null, joinedAt: FieldValue.serverTimestamp() });
    usage.wrote();
    usage.roster(count.data().count + 1);
    logActivity(tx, tournamentRef, usage, {
      type: 'player_joined',
      actorId: uid,
      targetPlayerId: uid,
      level: 'admins',
    });
    return { ...result, alreadyMember: false };
  });
}

export interface RemovePlayerInput {
  tournamentId?: string;
  playerId?: string;
}

export interface RemovedPlayer {
  tournamentId: string;
  playerId: string;
  // false: the roster entry was deleted (before the start). true: kept and marked withdrawn (after it).
  withdrawn: boolean;
}

// Admin: take a player off the roster (a wrong account joined, a no-show). Before the tournament
// starts the roster entry is simply deleted, and the person could rejoin with the code. After the
// start nothing is deleted: the entry is marked withdrawn and kept, because their team, handicap and
// (later) scores are part of the record; a withdrawn player can no longer change anything. The organizer
// cannot be removed, and nobody can remove themselves here (leaving is a different action). If the removed
// player was the co-admin, that role is cleared in the same transaction.
export async function removePlayer(
  db: Firestore,
  uid: string,
  input: RemovePlayerInput,
  usage: UsageTracker,
): Promise<RemovedPlayer> {
  const tournamentId = requireTournamentId(input.tournamentId);
  const playerId = requireId('playerId', input.playerId);
  if (playerId === uid) {
    throw new HttpsError('invalid-argument', 'You cannot remove yourself');
  }

  usage.forTournament(tournamentId);
  const tournamentRef = db.collection('tournaments').doc(tournamentId);
  const memberRef = tournamentRef.collection('players').doc(playerId);

  return db.runTransaction(async (tx) => {
    const tournament = await assertAdmin(tx, tournamentRef, uid, usage);
    if (playerId === tournament.organizerId) {
      throw new HttpsError('invalid-argument', 'The organizer cannot be removed');
    }
    const member = await tx.get(memberRef);
    usage.read();
    if (!member.exists) {
      throw new HttpsError('not-found', 'That player is not on this tournament\'s roster');
    }
    if (member.data()?.withdrawn === true) {
      return { tournamentId, playerId, withdrawn: true }; // already withdrawn: nothing to do
    }

    const started = Boolean(tournament.startedAt);
    if (started) {
      tx.update(memberRef, {
        withdrawn: true,
        withdrawnAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      tx.delete(memberRef);
    }
    usage.wrote();

    if (tournament.coAdminId === playerId) {
      tx.update(tournamentRef, { coAdminId: null });
      usage.wrote();
      logActivity(tx, tournamentRef, usage, {
        type: 'co_admin_changed',
        actorId: uid,
        targetPlayerId: playerId,
        level: 'all',
        changes: { coAdminId: { from: playerId, to: null } },
      });
    }
    logActivity(tx, tournamentRef, usage, {
      type: 'player_removed',
      actorId: uid,
      targetPlayerId: playerId,
      level: announce(started, 'admins'),
      data: { withdrawn: started },
    });
    return { tournamentId, playerId, withdrawn: started };
  });
}

export const joinTournamentCallable = callable<JoinTournamentInput, JoinedTournament>(
  'joinTournament',
  async (request, usage, uid) => joinTournament(getDb(), uid, request.data ?? {}, usage),
);

export const removePlayerCallable = callable<RemovePlayerInput, RemovedPlayer>(
  'removePlayer',
  async (request, usage, uid) => removePlayer(getDb(), uid, request.data ?? {}, usage),
);
