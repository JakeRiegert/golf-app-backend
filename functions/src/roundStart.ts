import { DocumentData, DocumentReference, FieldValue, Firestore, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';

import { logActivity } from './activity';
import { assertAdmin, requireId, requireTournamentId } from './authz';
import { getDb } from './firestore';
import { ROUND_STATUS } from './rounds';
import { callable, UsageTracker } from './usage';

// Starting a round: scheduled -> live (docs/rounds-data-model.md, sections 2.1 and 4).
//   - takes the handicap snapshot, `playingHandicaps` { uid: handicap } from the roster at this moment, so a
//     later change to the roster handicap does not rewrite a round that is under way (an admin can still
//     override one player for a round later);
//   - stamps `startedAt` on the round, and on the tournament too if it had not been started (the first round
//     going live starts the tournament, which is also what locks teams and handicaps for players);
//   - leaves one `round_started` event (everyone is told), plus `tournament_started` when that happened.
// An organizer can start a round with startRound; if nobody does, the first score entered for a round that is
// still scheduled starts it automatically (a round must never refuse a real score because the organizer forgot).

// Reads happen here, in the caller's transaction and before any of its writes; the returned apply() does the
// writes. `auto` marks a start caused by the first score rather than by an organizer.
export async function planRoundStart(
  tx: Transaction,
  tournamentRef: DocumentReference,
  tournament: DocumentData,
  roundRef: DocumentReference,
  round: DocumentData,
  usage: UsageTracker,
): Promise<{ apply: (actorId: string, auto: boolean) => void }> {
  const roster = await tx.get(tournamentRef.collection('players'));
  usage.read(roster.size);
  const playingHandicaps: Record<string, number> = {};
  for (const entry of roster.docs) {
    const data = entry.data();
    if (data.withdrawn === true) continue;
    if (typeof data.handicap === 'number') playingHandicaps[entry.id] = data.handicap;
  }

  return {
    apply(actorId: string, auto: boolean) {
      tx.update(roundRef, {
        status: ROUND_STATUS.LIVE,
        startedAt: FieldValue.serverTimestamp(),
        playingHandicaps,
        updatedAt: FieldValue.serverTimestamp(),
      });
      usage.wrote();
      if (!tournament.startedAt) {
        tx.update(tournamentRef, { startedAt: FieldValue.serverTimestamp() });
        usage.wrote();
        logActivity(tx, tournamentRef, usage, { type: 'tournament_started', actorId, level: 'all', data: { byRound: roundRef.id } });
      }
      logActivity(tx, tournamentRef, usage, {
        type: 'round_started',
        actorId,
        level: 'all',
        data: { roundId: roundRef.id, number: round.number, auto, withHandicaps: Object.keys(playingHandicaps).length },
      });
    },
  };
}

export interface StartRoundInput {
  tournamentId?: string;
  roundId?: string;
}

export interface StartedRound {
  roundId: string;
  alreadyLive: boolean;
}

// Admin: start a round now. Idempotent on a round that is already live.
export async function startRound(db: Firestore, uid: string, input: StartRoundInput, usage: UsageTracker): Promise<StartedRound> {
  const tournamentId = requireTournamentId(input.tournamentId);
  const roundId = requireId('roundId', input.roundId);
  usage.forTournament(tournamentId);
  const tournamentRef = db.collection('tournaments').doc(tournamentId);
  const roundRef = tournamentRef.collection('rounds').doc(roundId);

  return db.runTransaction(async (tx) => {
    const tournament = await assertAdmin(tx, tournamentRef, uid, usage);
    const snap = await tx.get(roundRef);
    usage.read();
    const round = snap.data();
    if (!round) throw new HttpsError('not-found', 'Round not found in this tournament');
    if (round.status === ROUND_STATUS.LIVE) return { roundId, alreadyLive: true };
    if (round.status !== ROUND_STATUS.SCHEDULED) {
      throw new HttpsError('failed-precondition', `This round is ${round.status} and cannot be started`);
    }
    const plan = await planRoundStart(tx, tournamentRef, tournament, roundRef, round, usage);
    plan.apply(uid, false);
    return { roundId, alreadyLive: false };
  });
}

export const startRoundCallable = callable<StartRoundInput, StartedRound>('startRound', async (request, usage, uid) =>
  startRound(getDb(), uid, request.data ?? {}, usage),
);
