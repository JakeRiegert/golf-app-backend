import { FieldValue, Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';

import { AssignedBy, cleanHandicap } from './assignment';
import { readActiveTournament, requireTournamentId } from './authz';
import { getDb } from './firestore';
import { callable, UsageTracker } from './usage';

export interface SetMyHandicapInput {
  tournamentId?: string;
  // null = clear my handicap.
  handicap?: number | null;
}

export interface MyHandicap {
  playerId: string;
  handicap: number | null;
  handicapSetBy: AssignedBy;
}

// Player: set my own handicap, but only before an admin has started the tournament. Handicap
// feeds the bets and scoring, so once play begins only the organizer or co-admin can change it
// (assignTournamentPlayer, which works at any time). This is the tournament-wide default;
// per-round adjustments will be admin-only overrides on each Round.
export async function setMyHandicap(
  db: Firestore,
  uid: string,
  input: SetMyHandicapInput,
  usage: UsageTracker,
): Promise<MyHandicap> {
  const tournamentId = requireTournamentId(input.tournamentId);
  if (input.handicap === undefined) {
    throw new HttpsError('invalid-argument', 'handicap is required (use null to clear it)');
  }
  const handicap = cleanHandicap(input.handicap);

  usage.forTournament(tournamentId);
  const tournamentRef = db.collection('tournaments').doc(tournamentId);
  const memberRef = tournamentRef.collection('players').doc(uid);

  return db.runTransaction(async (tx) => {
    const tournament = await readActiveTournament(tx, tournamentRef, usage);
    const member = await tx.get(memberRef);
    usage.read();
    if (!member.exists) {
      throw new HttpsError('permission-denied', 'Join this tournament before setting a handicap');
    }
    if (tournament.startedAt) {
      throw new HttpsError(
        'permission-denied',
        'The tournament has started. Ask the organizer if your handicap needs changing.',
      );
    }

    const handicapSetBy: AssignedBy = handicap === null ? null : 'player';
    tx.update(memberRef, { handicap, handicapSetBy, updatedAt: FieldValue.serverTimestamp() });
    usage.wrote();
    return { playerId: uid, handicap, handicapSetBy };
  });
}

export const setMyHandicapCallable = callable<SetMyHandicapInput, MyHandicap>(
  'setMyHandicap',
  async (request, usage, uid) => setMyHandicap(getDb(), uid, request.data ?? {}, usage),
);
