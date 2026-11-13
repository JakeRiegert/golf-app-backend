import { Course, Scoring } from './roundRules';

// The checks a score submission goes through before it becomes an official score (docs/rounds-data-model.md,
// sections 2.3 and 2.3b). Pure functions: no database, so every rule is unit-tested on its own.

// The largest number of strokes any single hole can take, as far as this app is concerned. The security rule
// enforces the same bound on the phone's write; the round's own maximum (double par by default) is tighter.
export const MAX_STROKES = 20;

// A phone clock ahead of the server by more than this is treated as wrong: the entry is accepted, but its
// time is pulled back to the server's clock so one bad clock cannot make an entry win every later race.
export const CLOCK_SKEW_ALLOWANCE_MS = 5 * 60 * 1000;

export type SubmissionOutcome = 'accepted' | 'accepted_late' | 'rejected';

export const REJECTION_REASONS = {
  noSuchRound: 'This round no longer exists.',
  suspended: 'This tournament is suspended, so scores cannot be saved right now.',
  cancelled: 'This round was cancelled.',
  notInGroup: 'You are not in this player\'s group for this round. Ask the organizer to check the groups.',
  withdrawn: 'This player was removed from the tournament.',
  outOfRange: 'That hole is not part of this round.',
  overMax: 'That is more than the most this round allows on that hole. Enter the maximum instead.',
  inReview: 'The round is in review: ask the organizer to change this score.',
  finalized: 'The round is final: ask the organizer to reopen it to change a score.',
} as const;
export type RejectionReason = keyof typeof REJECTION_REASONS;

export interface SubmissionFields {
  playerId: string;
  hole: number;
  strokes: number;
  kind: 'played' | 'pickup';
  groupId: string;
  enteredBy: string;
  // Milliseconds, the phone's clock when the score was entered (already pulled back if it ran ahead).
  clientTime: number;
}

export interface DecisionContext {
  submission: SubmissionFields;
  tournament: { suspended: boolean; organizerId: string | null; coAdminId: string | null };
  round: {
    status: string;
    firstHole: number;
    holesPlanned: number;
    skippedHoles: number[];
    course: Course | null;
    scoring: Scoring;
    // When the organizer started the review; null before.
    reviewStartedAtMs: number | null;
  } | null;
  // The group named in the submission, or null if it is not one of this round's groups.
  group: { playerIds: string[] } | null;
  // The subject's roster entry, or null if there is none.
  player: { withdrawn: boolean } | null;
}

export interface Decision {
  outcome: SubmissionOutcome;
  reason?: RejectionReason;
  // Accepted while the round was already in review or final, because the phone entered it before review began.
  late?: boolean;
}

// The most strokes a hole may show in this round: the round's maximum-score setting applied to the hole's par.
// Without a course snapshot there is no par to apply it to, so only the app-wide bound holds.
export function maxScoreFor(scoring: Scoring, par: number | null): number {
  let cap = MAX_STROKES;
  if (par !== null) {
    if (scoring.maxScore.mode === 'doublePar') cap = par * 2;
    else if (scoring.maxScore.mode === 'doubleBogey') cap = par + 2;
    else if (scoring.maxScore.value !== null) cap = scoring.maxScore.value;
  } else if (scoring.maxScore.mode === 'fixed' && scoring.maxScore.value !== null) {
    cap = scoring.maxScore.value;
  }
  return Math.min(cap, MAX_STROKES);
}

// What a pickup is recorded as: the round's maximum for that hole, whatever the phone sent. A pickup is the
// app's assignment of the maximum (the player did not finish the hole), and it must stay distinguishable from
// a score the player really made, because at equal strokes a real score beats a pickup (the tiebreak in the
// scoring layer reads `kind`). Null when the maximum cannot be worked out (no course, so no par to apply
// "double par" to); the phone's own number is kept then.
export function pickupValue(scoring: Scoring, par: number | null): number | null {
  if (scoring.maxScore.mode === 'fixed') return scoring.maxScore.value === null ? null : Math.min(scoring.maxScore.value, MAX_STROKES);
  return par === null ? null : maxScoreFor(scoring, par);
}

export const isAdminUid =(tournament: DecisionContext['tournament'], uid: string): boolean =>
  tournament.organizerId === uid || tournament.coAdminId === uid;

const reject = (reason: RejectionReason): Decision => ({ outcome: 'rejected', reason });

// The order matters only for which reason a person sees when more than one applies. Rules stay the same for
// a live round or one that has not started yet (the first score starts it, which the caller handles).
export function decideSubmission(ctx: DecisionContext): Decision {
  const { submission, tournament, round, group, player } = ctx;
  if (!round) return reject('noSuchRound');
  if (tournament.suspended) return reject('suspended');
  if (round.status === 'cancelled') return reject('cancelled');

  // Nobody outside a group enters its scores, except an organizer or co-admin, who may enter any player's score
  // as long as that player is in a group of this round.
  const admin = isAdminUid(tournament, submission.enteredBy);
  const subjectInGroup = Boolean(group && group.playerIds.includes(submission.playerId));
  const scorerInGroup = Boolean(group && group.playerIds.includes(submission.enteredBy));
  if (!subjectInGroup || !(scorerInGroup || admin)) return reject('notInGroup');
  if (!player || player.withdrawn) return reject('withdrawn');

  const last = round.firstHole + round.holesPlanned - 1;
  if (submission.hole < round.firstHole || submission.hole > last || round.skippedHoles.includes(submission.hole)) {
    return reject('outOfRange');
  }
  const par = round.course?.holes[submission.hole - 1]?.par ?? null;
  // A pickup is recorded as the maximum whatever number came with it (see pickupValue), so only a played score,
  // or a pickup whose maximum cannot be worked out, is checked against the maximum.
  const pickupKnown = submission.kind === 'pickup' && pickupValue(round.scoring, par) !== null;
  if (!pickupKnown && submission.strokes > maxScoreFor(round.scoring, par)) return reject('overMax');

  if (round.status === 'pending_review' || round.status === 'finalized') {
    // A score the phone entered before review began but only managed to send afterwards is a real score: keep it
    // and flag it for the organizer. An entry made after review began is refused for players; the organizer's
    // own changes in review go through a correction (a later step), and a final round must be reopened first.
    const beganBefore = round.reviewStartedAtMs !== null && submission.clientTime < round.reviewStartedAtMs;
    if (beganBefore) return { outcome: 'accepted_late', late: true };
    if (round.status === 'finalized') return reject('finalized');
    if (!admin) return reject('inReview');
  }
  return { outcome: 'accepted' };
}
