import { DocumentData, DocumentReference, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';

import { TOURNAMENT_STATUS } from './limits';
import { UsageTracker } from './usage';

export function requireTournamentId(value: unknown): string {
  // Document IDs cannot contain '/', so reject anything that is not a plain string ID up front.
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new HttpsError('invalid-argument', 'tournamentId is required');
  }
  return value;
}

// Reads the tournament inside the caller's transaction and requires the caller to be its
// organizer or co-admin. A suspended tournament is read-only for everyone (plan D9): admins
// can still see it, but every admin write is refused until it is reactivated. Returns the
// tournament data so callers do not have to read it again.
export async function assertAdmin(
  tx: Transaction,
  tournamentRef: DocumentReference,
  uid: string,
  usage: UsageTracker,
): Promise<DocumentData> {
  const snap = await tx.get(tournamentRef);
  usage.read();
  const tournament = snap.data();
  if (!tournament) {
    throw new HttpsError('not-found', 'Tournament not found');
  }
  if (tournament.organizerId !== uid && tournament.coAdminId !== uid) {
    throw new HttpsError('permission-denied', "Only this tournament's organizer or co-admin can do that");
  }
  if (tournament.status !== TOURNAMENT_STATUS.ACTIVE) {
    throw new HttpsError('failed-precondition', 'This tournament is suspended');
  }
  return tournament;
}
