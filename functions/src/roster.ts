import { FieldValue, Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';

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
    if (count.data().count >= maxRosterSize) {
      throw new HttpsError('resource-exhausted', `This tournament is full (${maxRosterSize} players)`);
    }

    tx.create(memberRef, { playerId: uid, teamId: null, teamAssignedBy: null, handicap: null, joinedAt: FieldValue.serverTimestamp() });
    usage.wrote();
    return { ...result, alreadyMember: false };
  });
}

export const joinTournamentCallable = callable<JoinTournamentInput, JoinedTournament>(
  'joinTournament',
  async (request, usage, uid) => joinTournament(getDb(), uid, request.data ?? {}, usage),
);
