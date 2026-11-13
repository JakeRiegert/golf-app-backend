import { FieldValue, Firestore, Timestamp } from 'firebase-admin/firestore';
import * as logger from 'firebase-functions/logger';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';

import { getDb } from './firestore';
import { planRoundStart } from './roundStart';
import { ROUND_STATUS } from './rounds';
import {
  CLOCK_SKEW_ALLOWANCE_MS,
  Decision,
  decideSubmission,
  DecisionContext,
  pickupValue,
  REJECTION_REASONS,
  SubmissionFields,
} from './scoreRules';
import { runWithUsage, UsageTracker } from './usage';

// The score inbox (docs/rounds-data-model.md, sections 2.3 and 10). A phone writes a submission under
//   tournaments/{tid}/rounds/{rid}/submissions/{playerId}_{hole}_{clientTime}
// through Firestore's offline queue. This function runs when one is created, checks it against the round, and
// either writes the official entry
//   tournaments/{tid}/rounds/{rid}/scores/{same id}
// or marks the submission rejected with a reason the phone shows. A score is never dropped silently: every
// submission ends up with an `outcome` ('accepted', 'accepted_late' or 'rejected'), `reasonCode` and `reason`
// (plain words), and `processedAt`.
//
// Safe to run twice for the same submission (the platform delivers at least once): a submission that already has
// an outcome is left alone, and the official entry has the same id, so a retry cannot make a second one. Racing
// entries for the same player and hole are kept side by side; the current score is the one with the latest
// `clientTime` (the cards step reads it that way, ties broken by id).
//
// A phone clock running more than five minutes ahead is pulled back to the server's clock on the official entry
// (the original is kept as `clientTimeRaw`), so one wrong clock cannot win every later race.

export interface ProcessResult {
  // 'gone' / 'already' mean nothing was done; otherwise the decision that was recorded.
  result: 'gone' | 'already' | 'recorded';
  decision?: Decision;
  startedRound?: boolean;
}

const FIELD_NAMES = ['playerId', 'hole', 'strokes', 'kind', 'groupId', 'enteredBy', 'clientTime'] as const;

// The security rule only lets well-formed submissions in, but this function must not trust that: a malformed
// one (written by an admin tool, or from before a rule change) is rejected rather than crashing the trigger.
function readFields(data: FirebaseFirestore.DocumentData | undefined): SubmissionFields | null {
  if (!data) return null;
  for (const name of FIELD_NAMES) if (data[name] === undefined) return null;
  const { playerId, hole, strokes, kind, groupId, enteredBy, clientTime } = data;
  if (typeof playerId !== 'string' || typeof groupId !== 'string' || typeof enteredBy !== 'string') return null;
  if (!Number.isInteger(hole) || !Number.isInteger(strokes) || !Number.isInteger(clientTime)) return null;
  if (kind !== 'played' && kind !== 'pickup') return null;
  return { playerId, hole, strokes, kind, groupId, enteredBy, clientTime };
}

export async function processSubmission(
  db: Firestore,
  tournamentId: string,
  roundId: string,
  submissionId: string,
  usage: UsageTracker,
  nowMs: () => number = Date.now,
): Promise<ProcessResult & { submissionToEntryMs: number | null }> {
  usage.forTournament(tournamentId);
  const tournamentRef = db.collection('tournaments').doc(tournamentId);
  const roundRef = tournamentRef.collection('rounds').doc(roundId);
  const submissionRef = roundRef.collection('submissions').doc(submissionId);
  const scoreRef = roundRef.collection('scores').doc(submissionId);

  return db.runTransaction(async (tx) => {
    const subSnap = await tx.get(submissionRef);
    usage.read();
    if (!subSnap.exists) return { result: 'gone', submissionToEntryMs: null };
    const raw = subSnap.data()!;
    if (raw.outcome) return { result: 'already', submissionToEntryMs: null };

    const fields = readFields(raw);
    const now = nowMs();
    const createdMs = subSnap.createTime ? subSnap.createTime.toMillis() : null;

    // A submission this function cannot even read is rejected with the generic reason, so the phone still hears.
    if (!fields) {
      tx.update(submissionRef, {
        outcome: 'rejected',
        reasonCode: 'malformed',
        reason: 'This score could not be read. Enter it again.',
        processedAt: FieldValue.serverTimestamp(),
      });
      usage.wrote();
      return { result: 'recorded', decision: { outcome: 'rejected' }, submissionToEntryMs: createdMs === null ? null : now - createdMs };
    }

    const [tournamentSnap, roundSnap, groupSnap, playerSnap] = await Promise.all([
      tx.get(tournamentRef),
      tx.get(roundRef),
      tx.get(roundRef.collection('groups').doc(fields.groupId)),
      tx.get(tournamentRef.collection('players').doc(fields.playerId)),
    ]);
    usage.read(4);
    const tournament = tournamentSnap.data();
    const round = roundSnap.data();
    const group = groupSnap.data();
    const player = playerSnap.data();

    // Pull a clock that runs ahead back to the server's.
    const skewed = fields.clientTime > now + CLOCK_SKEW_ALLOWANCE_MS;
    const clientTime = skewed ? now : fields.clientTime;
    const submission = { ...fields, clientTime };

    const reviewStarted = round?.reviewStartedAt as Timestamp | undefined;
    const ctx: DecisionContext = {
      submission,
      tournament: {
        suspended: !tournament || tournament.status !== 'active',
        organizerId: tournament?.organizerId ?? null,
        coAdminId: tournament?.coAdminId ?? null,
      },
      round: round
        ? {
            status: round.status,
            firstHole: round.firstHole,
            holesPlanned: round.holesPlanned,
            skippedHoles: round.skippedHoles ?? [],
            course: round.course ?? null,
            scoring: round.scoring,
            reviewStartedAtMs: reviewStarted ? reviewStarted.toMillis() : null,
          }
        : null,
      group: group ? { playerIds: group.playerIds as string[] } : null,
      player: player ? { withdrawn: player.withdrawn === true } : null,
    };
    const decision = decideSubmission(ctx);

    // The first score of a round that has not started starts it (handicap snapshot included). Reads first.
    const starts = decision.outcome !== 'rejected' && round?.status === ROUND_STATUS.SCHEDULED && tournament !== undefined;
    const startPlan = starts ? await planRoundStart(tx, tournamentRef, tournament!, roundRef, round!, usage) : null;

    if (decision.outcome === 'rejected') {
      tx.update(submissionRef, {
        outcome: 'rejected',
        reasonCode: decision.reason,
        reason: REJECTION_REASONS[decision.reason!],
        processedAt: FieldValue.serverTimestamp(),
      });
      usage.wrote();
    } else {
      startPlan?.apply(fields.enteredBy, true);
      // A pickup is recorded as the round's maximum for the hole, and the phone's own number is kept beside it.
      const pickup = fields.kind === 'pickup' ? pickupValue(round!.scoring, round!.course?.holes[fields.hole - 1]?.par ?? null) : null;
      const strokes = pickup ?? fields.strokes;
      tx.set(scoreRef, {
        playerId: fields.playerId,
        hole: fields.hole,
        strokes,
        ...(strokes !== fields.strokes ? { strokesEntered: fields.strokes } : {}),
        kind: fields.kind,
        groupId: fields.groupId,
        enteredBy: fields.enteredBy,
        clientTime,
        ...(skewed ? { clientTimeRaw: fields.clientTime } : {}),
        status: decision.outcome === 'accepted_late' ? 'late' : 'accepted',
        submissionId,
        at: FieldValue.serverTimestamp(),
      });
      tx.update(submissionRef, {
        outcome: decision.outcome,
        ...(decision.outcome === 'accepted_late'
          ? { reasonCode: 'late', reason: 'Saved. It arrived after review began, so the organizer will check it.' }
          : {}),
        processedAt: FieldValue.serverTimestamp(),
      });
      usage.wrote(2);
    }
    return {
      result: 'recorded',
      decision,
      startedRound: Boolean(startPlan),
      submissionToEntryMs: createdMs === null ? null : now - createdMs,
    };
  });
}

// The trigger. At-least-once delivery is fine (see the note at the top), and `retry` makes a transient failure
// try again instead of losing the score. One structured `submission_processed` line per submission feeds the
// thresholds in docs/rounds-data-model.md section 10.
export const onSubmissionCreated = onDocumentCreated(
  { document: 'tournaments/{tournamentId}/rounds/{roundId}/submissions/{submissionId}', retry: true },
  async (event) => {
    const { tournamentId, roundId, submissionId } = event.params;
    const enteredBy = event.data?.data()?.enteredBy;
    await runWithUsage('onSubmissionCreated', typeof enteredBy === 'string' ? enteredBy : undefined, async (usage) => {
      const outcome = await processSubmission(getDb(), tournamentId, roundId, submissionId, usage);
      if (outcome.result === 'recorded') {
        logger.info('submission_processed', {
          event: 'submission_processed',
          tournamentId,
          roundId,
          outcome: outcome.decision?.outcome ?? 'rejected',
          reasonCode: outcome.decision?.reason ?? (outcome.decision?.late ? 'late' : null),
          startedRound: outcome.startedRound ?? false,
          submissionToEntryMs: outcome.submissionToEntryMs,
        });
      }
      return outcome;
    });
  },
);
