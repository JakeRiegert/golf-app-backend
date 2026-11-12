import { HttpsError } from 'firebase-functions/v2/https';
import { describe, expect, it } from 'vitest';

import {
  cleanCourse,
  cleanFirstHole,
  cleanFormats,
  cleanGroups,
  cleanHolesPlanned,
  cleanMaxGroupSize,
  cleanScoring,
  cleanSkippedHoles,
  cleanSkins,
  cleanTeeTime,
  cleanTimeZone,
  courseSummary,
  playRange,
  sameValue,
  stableStringify,
} from '../src/roundRules';

// Pure checks, no emulator.

function invalid(fn: () => unknown, fragment?: string) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpsError);
    expect((err as HttpsError).code).toBe('invalid-argument');
    if (fragment) expect((err as HttpsError).message).toContain(fragment);
    return;
  }
  throw new Error('expected invalid-argument');
}

const holes = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ par: 4, strokeIndex: i + 1, yards: 350 + i }));
const course = (count = 18) => ({ name: 'Pebble Beach', tees: 'Blue', rating: 74.9, slope: 144, holes: holes(count) });

describe('holes in play', () => {
  it('allows 9 or 18 holes only', () => {
    expect(cleanHolesPlanned(18)).toBe(18);
    expect(cleanHolesPlanned(9)).toBe(9);
    for (const value of [0, 12, 27, '18', null, undefined]) invalid(() => cleanHolesPlanned(value));
  });

  it('starts a nine on hole 1 or 10, and an 18 on hole 1', () => {
    expect(cleanFirstHole(1, 9)).toBe(1);
    expect(cleanFirstHole(10, 9)).toBe(10);
    expect(cleanFirstHole(1, 18)).toBe(1);
    invalid(() => cleanFirstHole(10, 18), 'starts at hole 1');
    invalid(() => cleanFirstHole(5, 9));
  });

  it('computes the range a round plays', () => {
    expect(playRange(1, 18)).toEqual({ first: 1, last: 18 });
    expect(playRange(10, 9)).toEqual({ first: 10, last: 18 });
  });

  it('validates group size', () => {
    expect(cleanMaxGroupSize(4)).toBe(4);
    expect(cleanMaxGroupSize(1)).toBe(1);
    expect(cleanMaxGroupSize(8)).toBe(8);
    for (const value of [0, 9, 2.5, '4']) invalid(() => cleanMaxGroupSize(value));
  });

  it('sorts skipped holes, drops repeats, and keeps at least one hole in play', () => {
    expect(cleanSkippedHoles([7, 3, 3], playRange(1, 18))).toEqual([3, 7]);
    expect(cleanSkippedHoles([], playRange(1, 9))).toEqual([]);
    invalid(() => cleanSkippedHoles([19], playRange(1, 18)));
    invalid(() => cleanSkippedHoles([1], playRange(10, 9)), 'from 10 to 18');
    invalid(() => cleanSkippedHoles(Array.from({ length: 9 }, (_, i) => i + 1), playRange(1, 9)), 'stay in play');
    invalid(() => cleanSkippedHoles('3', playRange(1, 18)));
  });
});

describe('time zone and tee times', () => {
  it('accepts real zones and treats empty as none', () => {
    expect(cleanTimeZone('America/Chicago')).toBe('America/Chicago');
    expect(cleanTimeZone('UTC')).toBe('UTC');
    expect(cleanTimeZone(undefined)).toBeNull();
    expect(cleanTimeZone(null)).toBeNull();
    invalid(() => cleanTimeZone('Mars/Olympus'));
    invalid(() => cleanTimeZone(5));
  });

  it('requires an explicit offset so a tee time is an exact instant', () => {
    expect(cleanTeeTime('2026-11-14T13:30:00-06:00')?.toISOString()).toBe('2026-11-14T19:30:00.000Z');
    expect(cleanTeeTime('2026-11-14T19:30:00Z')?.toISOString()).toBe('2026-11-14T19:30:00.000Z');
    expect(cleanTeeTime('2026-11-14T19:30Z')?.toISOString()).toBe('2026-11-14T19:30:00.000Z');
    expect(cleanTeeTime(null)).toBeNull();
    expect(cleanTeeTime(undefined)).toBeNull();
    invalid(() => cleanTeeTime('2026-11-14T13:30:00'), 'time zone');
    invalid(() => cleanTeeTime('2026-11-14'));
    invalid(() => cleanTeeTime('2026-13-14T13:30:00Z'));
    invalid(() => cleanTeeTime(1731600000000));
    invalid(() => cleanTeeTime('1999-01-01T00:00:00Z'));
  });
});

describe('course snapshot', () => {
  it('accepts a full 18-hole course and normalizes it', () => {
    const cleaned = cleanCourse({ ...course(), name: '  Pebble Beach ' }, playRange(1, 18));
    expect(cleaned?.name).toBe('Pebble Beach');
    expect(cleaned?.holes).toHaveLength(18);
    expect(cleaned?.rating).toBe(74.9);
  });

  it('lets rating, slope, tees and yards be missing', () => {
    const cleaned = cleanCourse({ name: 'Muni', holes: holes(18).map(({ par, strokeIndex }) => ({ par, strokeIndex })) }, playRange(1, 18));
    expect(cleaned).toMatchObject({ tees: null, rating: null, slope: null });
    expect(cleaned?.holes[0].yards).toBeNull();
  });

  it('null clears the course', () => {
    expect(cleanCourse(null, playRange(1, 18))).toBeNull();
  });

  it('requires 9 or 18 holes and enough of them for the holes played', () => {
    invalid(() => cleanCourse({ ...course(), holes: holes(12) }, playRange(1, 9)), '9 or 18');
    invalid(() => cleanCourse(course(9), playRange(10, 9)), 'plays hole 18');
    expect(cleanCourse(course(9), playRange(1, 9))?.holes).toHaveLength(9);
    expect(cleanCourse(course(18), playRange(10, 9))?.holes).toHaveLength(18);
  });

  it('rejects a repeated or out-of-range stroke index, bad par, and unknown keys', () => {
    const repeated = holes(18);
    repeated[3].strokeIndex = 1;
    invalid(() => cleanCourse({ ...course(), holes: repeated }, playRange(1, 18)), 'used twice');
    const tooBig = holes(9);
    tooBig[0].strokeIndex = 10;
    invalid(() => cleanCourse({ ...course(9), holes: tooBig }, playRange(1, 9)), 'from 1 to 9');
    const badPar = holes(18);
    badPar[0].par = 7;
    invalid(() => cleanCourse({ ...course(), holes: badPar }, playRange(1, 18)), 'par');
    invalid(() => cleanCourse({ ...course(), color: 'green' }, playRange(1, 18)), 'course.color');
    invalid(() => cleanCourse({ ...course(), name: '' }, playRange(1, 18)));
    invalid(() => cleanCourse({ ...course(), rating: 12 }, playRange(1, 18)), 'rating');
    invalid(() => cleanCourse({ ...course(), slope: 200 }, playRange(1, 18)), 'slope');
    invalid(() => cleanCourse('Pebble', playRange(1, 18)));
  });

  it('summarizes a course so a change shows even when only hole data moved', () => {
    const a = cleanCourse(course(), playRange(1, 18));
    const edited = course();
    edited.holes[4].par = 3;
    const b = cleanCourse(edited, playRange(1, 18));
    expect(courseSummary(a)).toMatchObject({ name: 'Pebble Beach', par: 72 });
    expect(courseSummary(b)).toMatchObject({ par: 71 });
    expect(sameValue(courseSummary(a), courseSummary(b))).toBe(false);
    expect(sameValue(courseSummary(a), courseSummary(cleanCourse(course(), playRange(1, 18))))).toBe(true);
    expect(courseSummary(null)).toBeNull();
  });
});

describe('formats, scoring and skins', () => {
  it('knows stroke play and rejects unknown or repeated formats', () => {
    expect(cleanFormats([{ formatId: 'strokePlay' }])).toEqual([{ formatId: 'strokePlay', config: {} }]);
    invalid(() => cleanFormats([{ formatId: 'wolf' }]), 'formatId');
    invalid(() => cleanFormats([{ formatId: 'strokePlay' }, { formatId: 'strokePlay' }]), 'more than once');
    invalid(() => cleanFormats([]));
    invalid(() => cleanFormats('strokePlay'));
  });

  it('fills scoring defaults and checks the maximum score', () => {
    expect(cleanScoring({})).toEqual({
      handicapMode: 'net',
      maxScore: { mode: 'doublePar', value: null },
      tiebreak: null,
    });
    expect(cleanScoring({ handicapMode: 'gross', maxScore: { mode: 'fixed', value: 8 }, tiebreak: 'countback' })).toEqual({
      handicapMode: 'gross',
      maxScore: { mode: 'fixed', value: 8 },
      tiebreak: 'countback',
    });
    invalid(() => cleanScoring({ handicapMode: 'stableford' }));
    invalid(() => cleanScoring({ maxScore: { mode: 'fixed' } }), 'fixed');
    invalid(() => cleanScoring({ maxScore: { mode: 'doublePar', value: 8 } }), 'only used');
    invalid(() => cleanScoring({ tiebreak: 'coinflip' }));
    invalid(() => cleanScoring({ mulligans: true }), 'scoring.mulligans');
  });

  it('fills skins defaults and checks the amount', () => {
    expect(cleanSkins({})).toEqual({ enabled: false, mode: 'perSkin', value: null, carryover: false });
    expect(cleanSkins({ enabled: true, mode: 'potSplit', value: 20.456, carryover: true })).toEqual({
      enabled: true,
      mode: 'potSplit',
      value: 20.46,
      carryover: true,
    });
    invalid(() => cleanSkins({ value: -1 }));
    invalid(() => cleanSkins({ enabled: 'yes' }));
    invalid(() => cleanSkins({ mode: 'free' }));
  });
});

describe('groups', () => {
  const opts = { maxGroupSize: 4, firstHole: 1, range: playRange(1, 18), skippedHoles: [] as number[], maxGroups: 100 };

  it('accepts groups of different sizes and defaults the starting hole', () => {
    const groups = cleanGroups([{ playerIds: ['a', 'b', 'c', 'd'] }, { playerIds: ['e', 'f', 'g'] }, { playerIds: ['h'] }], opts);
    expect(groups.map((g) => g.playerIds.length)).toEqual([4, 3, 1]);
    expect(groups.every((g) => g.teeHole === 1 && g.teeTime === null && g.sides === null && g.id === null)).toBe(true);
  });

  it('starts a back-nine round on hole 10 by default', () => {
    const [group] = cleanGroups([{ playerIds: ['a'] }], { ...opts, firstHole: 10, range: playRange(10, 9) });
    expect(group.teeHole).toBe(10);
  });

  it('accepts a shotgun starting hole and a tee time', () => {
    const [group] = cleanGroups([{ playerIds: ['a'], teeHole: 5, teeTime: '2026-11-14T13:30:00-06:00' }], opts);
    expect(group.teeHole).toBe(5);
    expect(group.teeTime?.toISOString()).toBe('2026-11-14T19:30:00.000Z');
  });

  it('rejects too many players, repeats, empty groups and bad ids', () => {
    invalid(() => cleanGroups([{ playerIds: ['a', 'b', 'c', 'd', 'e'] }], opts), 'limit is 4');
    invalid(() => cleanGroups([{ playerIds: ['a'] }, { playerIds: ['a'] }], opts), 'more than one group');
    invalid(() => cleanGroups([{ playerIds: ['a', 'a'] }], opts), 'more than one group');
    invalid(() => cleanGroups([{ playerIds: [] }], opts), 'at least one player');
    invalid(() => cleanGroups([{ playerIds: ['a/b'] }], opts), 'not valid');
    invalid(() => cleanGroups([{ id: 'x', playerIds: ['a'] }, { id: 'x', playerIds: ['b'] }], opts), 'twice');
    invalid(() => cleanGroups('nope', opts));
    invalid(() => cleanGroups([{ playerIds: ['a'], color: 'red' } as never], opts), 'group 1.color');
  });

  it('rejects a starting hole that is out of range or out of play', () => {
    invalid(() => cleanGroups([{ playerIds: ['a'], teeHole: 19 }], opts), 'from 1 to 18');
    invalid(() => cleanGroups([{ playerIds: ['a'], teeHole: 5 }], { ...opts, skippedHoles: [5] }), 'out of play');
    invalid(() => cleanGroups([{ playerIds: ['a'], teeHole: 1 }], { ...opts, firstHole: 10, range: playRange(10, 9) }), 'from 10 to 18');
  });

  it('checks the sides: two separate non-empty sets of the group\'s own players', () => {
    const side = (...playerIds: string[]) => ({ playerIds });
    const ok = cleanGroups([{ playerIds: ['a', 'b', 'c', 'd'], sides: [side('a', 'b'), side('c', 'd')] }], opts);
    expect(ok[0].sides).toEqual([side('a', 'b'), side('c', 'd')]);
    invalid(() => cleanGroups([{ playerIds: ['a', 'b'], sides: [side('a'), side('x')] }], opts), 'not in the group');
    invalid(() => cleanGroups([{ playerIds: ['a', 'b'], sides: [side('a'), side('a')] }], opts), 'both sides');
    invalid(() => cleanGroups([{ playerIds: ['a', 'b'], sides: [side('a'), side()] }], opts), 'each side');
    invalid(() => cleanGroups([{ playerIds: ['a', 'b'], sides: [side('a')] }], opts), 'two sides');
    invalid(() => cleanGroups([{ playerIds: ['a', 'b'], sides: [['a'], ['b']] as never }], opts), 'each side must be an object');
  });

  it('limits the number of groups', () => {
    const many = Array.from({ length: 3 }, (_, i) => ({ playerIds: [`p${i}`] }));
    invalid(() => cleanGroups(many, { ...opts, maxGroups: 2 }), 'at most 2 groups');
  });
});

describe('stable comparison', () => {
  it('ignores key order', () => {
    expect(stableStringify({ b: 1, a: [2, { d: 4, c: 3 }] })).toBe(stableStringify({ a: [2, { c: 3, d: 4 }], b: 1 }));
    expect(sameValue({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameValue([1, 2], [2, 1])).toBe(false);
  });
});
