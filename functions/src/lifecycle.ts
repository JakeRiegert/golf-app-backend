import { FieldValue, Firestore } from 'firebase-admin/firestore';

import { assertAdmin, requireTournamentId } from './authz';
import { getDb } from './firestore';
import { callable, UsageTracker } from './usage';

export interface StartTournamentInput {
  tournamentId?: string;
}

export interface StartedTournament {
  tournamentId: string;
  alreadyStarted: boolean;
}

// Admin: mark the tournament as started. This is the line after which players can no longer
// change their own handicap (setMyHandicap); admins still can. It is an explicit action rather
// than the start date because dates are optional and time-zone-fuzzy, and a player's lock
// should never flip on its own. Idempotent. Once rounds exist, the first round going live will
// start the tournament too.
export async function startTournament(
  db: Firestore,
  uid: string,
  input: StartTournamentInput,
  usage: UsageTracker,
): Promise<StartedTournament> {
  const tournamentId = requireTournamentId(input.tournamentId);
  usage.forTournament(tournamentId);
  const tournamentRef = db.collection('tournaments').doc(tournamentId);

  return db.runTransaction(async (tx) => {
    const tournament = await assertAdmin(tx, tournamentRef, uid, usage);
    if (tournament.startedAt) {
      return { tournamentId, alreadyStarted: true };
    }
    tx.update(tournamentRef, { startedAt: FieldValue.serverTimestamp() });
    usage.wrote();
    return { tournamentId, alreadyStarted: false };
  });
}

export const startTournamentCallable = callable<StartTournamentInput, StartedTournament>(
  'startTournament',
  async (request, usage, uid) => startTournament(getDb(), uid, request.data ?? {}, usage),
);
