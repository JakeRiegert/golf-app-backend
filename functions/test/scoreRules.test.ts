import { describe, expect, it } from 'vitest';

import { DEFAULT_SCORING, Scoring } from '../src/roundRules';
import { DecisionContext, decideSubmission, maxScoreFor, MAX_STROKES, pickupValue, REJECTION_REASONS } from '../src/scoreRules';

const par = (n: number) => ({ par: n, strokeIndex: 1, yards: null });
const course = { name: 'C', tees: null, rating: null, slope: null, holes: Array.from({ length: 18 }, (_, i) => par(i % 3 === 0 ? 3 : i % 3 === 1 ? 4 : 5)) };

function ctx(over: Partial<DecisionContext> & { submission?: Partial<DecisionContext['submission']> } = {}): DecisionContext {
  return {
    submission: { playerId: 'p1', hole: 2, strokes: 5, kind: 'played', groupId: 'g1', enteredBy: 'p2', clientTime: 1000, ...over.submission },
    tournament: { suspended: false, organizerId: 'org', coAdminId: 'co', ...over.tournament },
    round: over.round === undefined
      ? { status: 'live', firstHole: 1, holesPlanned: 18, skippedHoles: [], course, scoring: DEFAULT_SCORING, reviewStartedAtMs: null }
      : over.round,
    group: over.group === undefined ? { playerIds: ['p1', 'p2'] } : over.group,
    player: over.player === undefined ? { withdrawn: false } : over.player,
  };
}
const round = (over: Record<string, unknown>) => ({ ...ctx().round!, ...over });

describe('maxScoreFor', () => {
  const scoring = (mode: Scoring['maxScore']['mode'], value: number | null = null): Scoring => ({ ...DEFAULT_SCORING, maxScore: { mode, value } });
  it('double par, double bogey and a fixed value, capped at the app-wide bound', () => {
    expect(maxScoreFor(scoring('doublePar'), 4)).toBe(8);
    expect(maxScoreFor(scoring('doubleBogey'), 4)).toBe(6);
    expect(maxScoreFor(scoring('fixed', 7), 4)).toBe(7);
    expect(maxScoreFor(scoring('doublePar'), 12)).toBe(MAX_STROKES);
  });
  it('with no course, only the fixed value or the app-wide bound applies', () => {
    expect(maxScoreFor(scoring('doublePar'), null)).toBe(MAX_STROKES);
    expect(maxScoreFor(scoring('fixed', 9), null)).toBe(9);
  });
});

describe('pickupValue', () => {
  const scoring = (mode: Scoring['maxScore']['mode'], value: number | null = null): Scoring => ({ ...DEFAULT_SCORING, maxScore: { mode, value } });
  it('is the round maximum for the hole', () => {
    expect(pickupValue(scoring('doublePar'), 4)).toBe(8);
    expect(pickupValue(scoring('doublePar'), 5)).toBe(10);
    expect(pickupValue(scoring('doubleBogey'), 3)).toBe(5);
    expect(pickupValue(scoring('fixed', 7), 4)).toBe(7);
    expect(pickupValue(scoring('fixed', 7), null)).toBe(7);
  });
  it('is unknown when there is no par to apply the maximum to', () => {
    expect(pickupValue(scoring('doublePar'), null)).toBeNull();
    expect(pickupValue(scoring('doubleBogey'), null)).toBeNull();
  });
});

describe('decideSubmission', () => {
  it('a pickup is accepted whatever number came with it, because it is recorded as the maximum', () => {
    expect(decideSubmission(ctx({ submission: { kind: 'pickup', strokes: 3 } })).outcome).toBe('accepted');
    expect(decideSubmission(ctx({ submission: { kind: 'pickup', strokes: 20 } })).outcome).toBe('accepted');
  });
  it('a pickup with no way to know the maximum is still held to the app-wide limits, and a played score to the round maximum', () => {
    const noCourse = round({ course: null });
    expect(decideSubmission(ctx({ round: noCourse, submission: { kind: 'pickup', strokes: 12 } })).outcome).toBe('accepted');
    expect(decideSubmission(ctx({ submission: { kind: 'played', strokes: 20 } })).reason).toBe('overMax');
  });

  it('accepts an ordinary score from someone in the group', () => {
    expect(decideSubmission(ctx())).toEqual({ outcome: 'accepted' });
  });

  it('accepts a score a player enters for themselves', () => {
    expect(decideSubmission(ctx({ submission: { enteredBy: 'p1' } })).outcome).toBe('accepted');
  });

  it('rejects a round that is gone, a suspended tournament, and a cancelled round', () => {
    expect(decideSubmission(ctx({ round: null }))).toEqual({ outcome: 'rejected', reason: 'noSuchRound' });
    expect(decideSubmission(ctx({ tournament: { suspended: true, organizerId: 'org', coAdminId: null } })).reason).toBe('suspended');
    expect(decideSubmission(ctx({ round: round({ status: 'cancelled' }) })).reason).toBe('cancelled');
  });

  it('rejects a scorer who is not in the group, and a subject who is not', () => {
    expect(decideSubmission(ctx({ submission: { enteredBy: 'stranger' } })).reason).toBe('notInGroup');
    expect(decideSubmission(ctx({ submission: { playerId: 'p9' } })).reason).toBe('notInGroup');
    expect(decideSubmission(ctx({ group: null })).reason).toBe('notInGroup');
  });

  it('lets an organizer or co-admin enter any player, but the player still has to be in the group', () => {
    expect(decideSubmission(ctx({ submission: { enteredBy: 'org' } })).outcome).toBe('accepted');
    expect(decideSubmission(ctx({ submission: { enteredBy: 'co' } })).outcome).toBe('accepted');
    expect(decideSubmission(ctx({ submission: { enteredBy: 'org', playerId: 'p9' } })).reason).toBe('notInGroup');
  });

  it('rejects a withdrawn player and one with no roster entry', () => {
    expect(decideSubmission(ctx({ player: { withdrawn: true } })).reason).toBe('withdrawn');
    expect(decideSubmission(ctx({ player: null })).reason).toBe('withdrawn');
  });

  it('checks the hole against the round: front nine, back nine, and skipped holes', () => {
    expect(decideSubmission(ctx({ round: round({ holesPlanned: 9 }), submission: { hole: 10 } })).reason).toBe('outOfRange');
    expect(decideSubmission(ctx({ round: round({ holesPlanned: 9 }), submission: { hole: 9 } })).outcome).toBe('accepted');
    expect(decideSubmission(ctx({ round: round({ holesPlanned: 9, firstHole: 10 }), submission: { hole: 9 } })).reason).toBe('outOfRange');
    expect(decideSubmission(ctx({ round: round({ holesPlanned: 9, firstHole: 10 }), submission: { hole: 18 } })).outcome).toBe('accepted');
    expect(decideSubmission(ctx({ round: round({ skippedHoles: [5] }), submission: { hole: 5 } })).reason).toBe('outOfRange');
  });

  it('applies the maximum score for the hole\'s par', () => {
    // hole 2 is a par 4 in the test course: double par is 8.
    expect(decideSubmission(ctx({ submission: { strokes: 8 } })).outcome).toBe('accepted');
    expect(decideSubmission(ctx({ submission: { strokes: 9 } })).reason).toBe('overMax');
  });

  it('review: a score entered before review began is kept and flagged; one entered after is refused for players', () => {
    const inReview = round({ status: 'pending_review', reviewStartedAtMs: 5000 });
    expect(decideSubmission(ctx({ round: inReview, submission: { clientTime: 4000 } }))).toEqual({ outcome: 'accepted_late', late: true });
    expect(decideSubmission(ctx({ round: inReview, submission: { clientTime: 6000 } })).reason).toBe('inReview');
  });

  it('review: an organizer entering after review began is accepted', () => {
    const inReview = round({ status: 'pending_review', reviewStartedAtMs: 5000 });
    expect(decideSubmission(ctx({ round: inReview, submission: { clientTime: 6000, enteredBy: 'org' } })).outcome).toBe('accepted');
  });

  it('a final round refuses everyone, even the organizer, unless the phone entered it before review began', () => {
    const done = round({ status: 'finalized', reviewStartedAtMs: 5000 });
    expect(decideSubmission(ctx({ round: done, submission: { clientTime: 6000, enteredBy: 'org' } })).reason).toBe('finalized');
    expect(decideSubmission(ctx({ round: done, submission: { clientTime: 6000 } })).reason).toBe('finalized');
    expect(decideSubmission(ctx({ round: done, submission: { clientTime: 100 } })).outcome).toBe('accepted_late');
  });

  it('a scheduled round is not refused (the first score starts it)', () => {
    expect(decideSubmission(ctx({ round: round({ status: 'scheduled' }) })).outcome).toBe('accepted');
  });

  it('every reason has plain-language text', () => {
    for (const text of Object.values(REJECTION_REASONS)) expect(text.length).toBeGreaterThan(10);
  });
});
