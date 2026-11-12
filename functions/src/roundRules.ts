import { createHash } from 'node:crypto';

import { HttpsError } from 'firebase-functions/v2/https';

import {
  FORMAT_IDS,
  MAX_COURSE_NAME_LENGTH,
  MAX_GROUP_SIZE_CAP,
  MAX_TEES_LENGTH,
  MAX_WAGER_POT_AMOUNT,
} from './limits';

// Pure validation and small helpers for rounds and their groups (docs/rounds-data-model.md, sections 2.1
// and 2.2). No database in here, so every rule is unit tested with plain data. Each `clean...` function
// returns the normalized value or throws an invalid-argument HttpsError that names the field.

function bad(message: string): never {
  throw new HttpsError('invalid-argument', message);
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isInt = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

// Rejects keys we do not know, so a typo cannot silently do nothing.
function onlyKeys(field: string, value: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) bad(`${field}.${key} is not a known setting`);
  }
}

// JSON with sorted keys: equal data always gives equal text, so it can be compared and hashed.
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export const sameValue = (a: unknown, b: unknown): boolean => stableStringify(a) === stableStringify(b);

// ---- holes ---------------------------------------------------------------------------------------

export type HolesPlanned = 9 | 18;

export function cleanHolesPlanned(value: unknown): HolesPlanned {
  if (value !== 9 && value !== 18) bad('holesPlanned must be 9 or 18');
  return value as HolesPlanned;
}

// 1 is the front (or only) nine, 10 the back nine. An 18-hole round always starts at hole 1.
export function cleanFirstHole(value: unknown, holesPlanned: HolesPlanned): 1 | 10 {
  if (value !== 1 && value !== 10) bad('firstHole must be 1 or 10');
  if (holesPlanned === 18 && value !== 1) bad('an 18-hole round starts at hole 1');
  return value as 1 | 10;
}

export interface PlayRange {
  first: number;
  last: number;
}

export const playRange = (firstHole: number, holesPlanned: number): PlayRange => ({
  first: firstHole,
  last: firstHole + holesPlanned - 1,
});

export function cleanMaxGroupSize(value: unknown): number {
  if (!isInt(value, 1, MAX_GROUP_SIZE_CAP)) bad(`maxGroupSize must be a whole number from 1 to ${MAX_GROUP_SIZE_CAP}`);
  return value as number;
}

// Holes out of play for this round (for example one closed for repair). Sorted, no repeats, all inside the
// round's range, and at least one hole must stay in play.
export function cleanSkippedHoles(value: unknown, range: PlayRange): number[] {
  if (!Array.isArray(value)) return bad('skippedHoles must be a list of hole numbers');
  const holes = new Set<number>();
  for (const hole of value) {
    if (!isInt(hole, range.first, range.last)) bad(`skippedHoles must be hole numbers from ${range.first} to ${range.last}`);
    holes.add(hole as number);
  }
  if (holes.size >= range.last - range.first + 1) bad('at least one hole must stay in play');
  return [...holes].sort((a, b) => a - b);
}

// ---- date, time zone and tee times -----------------------------------------------------------------

export function cleanTimeZone(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 64) return bad('timeZone must be a time zone name like America/Chicago');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
  } catch {
    bad('timeZone must be a time zone name like America/Chicago');
  }
  return value;
}

// A tee time is an exact instant: an ISO 8601 text WITH a "Z" or an offset (2026-11-14T13:30:00-06:00), so
// there is never a guess about the time zone. Stored as a UTC timestamp; shown in the round's time zone.
export function cleanTeeTime(value: unknown): Date | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return bad('teeTime must be a date and time with a time zone, like 2026-11-14T13:30:00-06:00');
  }
  const when = new Date(value);
  if (Number.isNaN(when.getTime()) || when.getUTCFullYear() < 2000 || when.getUTCFullYear() > 2100) {
    bad('teeTime is not a real date and time');
  }
  return when;
}

// ---- the course snapshot ---------------------------------------------------------------------------

export interface CourseHole {
  par: number;
  strokeIndex: number;
  yards: number | null;
}

export interface Course {
  name: string;
  tees: string | null;
  rating: number | null;
  slope: number | null;
  holes: CourseHole[];
}

// The round's own copy of the course: par and stroke index for every hole, plus rating and slope when
// known. It must cover the holes the round plays (a back-nine round needs 18 holes), and each stroke index
// is used exactly once. null clears it (a round can exist before its course is known).
export function cleanCourse(value: unknown, range: PlayRange): Course | null {
  if (value === null) return null;
  if (!isPlainObject(value)) return bad('course must be an object, or null to clear it');
  onlyKeys('course', value, ['name', 'tees', 'rating', 'slope', 'holes']);

  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (name.length === 0 || name.length > MAX_COURSE_NAME_LENGTH) {
    bad(`course.name must be 1-${MAX_COURSE_NAME_LENGTH} characters`);
  }
  let tees: string | null = null;
  if (value.tees !== undefined && value.tees !== null && value.tees !== '') {
    if (typeof value.tees !== 'string' || value.tees.trim().length > MAX_TEES_LENGTH) {
      bad(`course.tees must be at most ${MAX_TEES_LENGTH} characters`);
    }
    tees = (value.tees as string).trim();
  }
  let rating: number | null = null;
  if (value.rating !== undefined && value.rating !== null) {
    if (typeof value.rating !== 'number' || !Number.isFinite(value.rating) || value.rating < 50 || value.rating > 90) {
      bad('course.rating must be a number from 50 to 90');
    }
    rating = Math.round((value.rating as number) * 10) / 10;
  }
  let slope: number | null = null;
  if (value.slope !== undefined && value.slope !== null) {
    if (!isInt(value.slope, 55, 155)) bad('course.slope must be a whole number from 55 to 155');
    slope = value.slope as number;
  }

  if (!Array.isArray(value.holes) || (value.holes.length !== 9 && value.holes.length !== 18)) {
    return bad('course.holes must list 9 or 18 holes');
  }
  const count = value.holes.length;
  if (range.last > count) bad(`this round plays hole ${range.last}, but the course lists only ${count} holes`);
  const seenIndex = new Set<number>();
  const holes = value.holes.map((raw: unknown, i: number): CourseHole => {
    if (!isPlainObject(raw)) return bad(`course.holes[${i}] must be an object`);
    onlyKeys(`course.holes[${i}]`, raw, ['par', 'strokeIndex', 'yards']);
    if (!isInt(raw.par, 3, 6)) bad(`hole ${i + 1}: par must be a whole number from 3 to 6`);
    if (!isInt(raw.strokeIndex, 1, count)) bad(`hole ${i + 1}: strokeIndex must be a whole number from 1 to ${count}`);
    if (seenIndex.has(raw.strokeIndex as number)) bad(`hole ${i + 1}: strokeIndex ${raw.strokeIndex} is used twice`);
    seenIndex.add(raw.strokeIndex as number);
    let yards: number | null = null;
    if (raw.yards !== undefined && raw.yards !== null) {
      if (!isInt(raw.yards, 1, 1000)) bad(`hole ${i + 1}: yards must be a whole number from 1 to 1000`);
      yards = raw.yards as number;
    }
    return { par: raw.par as number, strokeIndex: raw.strokeIndex as number, yards };
  });
  return { name, tees, rating, slope, holes };
}

// A short description for the activity feed: enough to show what changed without storing 18 holes.
export function courseSummary(course: Course | null): Record<string, unknown> | null {
  if (!course) return null;
  return {
    name: course.name,
    tees: course.tees,
    rating: course.rating,
    slope: course.slope,
    par: course.holes.reduce((total, hole) => total + hole.par, 0),
    holes: createHash('sha1').update(stableStringify(course.holes)).digest('hex').slice(0, 8),
  };
}

// ---- formats, scoring and skins --------------------------------------------------------------------

export interface RoundFormat {
  formatId: string;
  config: Record<string, unknown>;
}

export function cleanFormats(value: unknown): RoundFormat[] {
  if (!Array.isArray(value) || value.length === 0) return bad('formats must be a non-empty list');
  if (value.length > 10) bad('a round can run at most 10 formats');
  const seen = new Set<string>();
  return value.map((raw: unknown, i: number): RoundFormat => {
    if (!isPlainObject(raw)) return bad(`formats[${i}] must be an object`);
    onlyKeys(`formats[${i}]`, raw, ['formatId', 'config']);
    if (typeof raw.formatId !== 'string' || !(FORMAT_IDS as readonly string[]).includes(raw.formatId)) {
      bad(`formats[${i}].formatId must be one of: ${FORMAT_IDS.join(', ')}`);
    }
    if (seen.has(raw.formatId as string)) bad(`format ${raw.formatId} appears more than once`);
    seen.add(raw.formatId as string);
    const config = raw.config === undefined ? {} : raw.config;
    if (!isPlainObject(config) || stableStringify(config).length > 2000) bad(`formats[${i}].config must be a small object`);
    return { formatId: raw.formatId as string, config: config as Record<string, unknown> };
  });
}

export const DEFAULT_FORMATS: RoundFormat[] = [{ formatId: 'strokePlay', config: {} }];

export interface Scoring {
  handicapMode: 'gross' | 'net';
  maxScore: { mode: 'doublePar' | 'doubleBogey' | 'fixed'; value: number | null };
  tiebreak: 'countback' | null;
}

export const DEFAULT_SCORING: Scoring = {
  handicapMode: 'net',
  maxScore: { mode: 'doublePar', value: null },
  tiebreak: null,
};

// Settings that were not given keep their defaults, so { handicapMode: 'gross' } alone is valid.
export function cleanScoring(value: unknown): Scoring {
  if (!isPlainObject(value)) return bad('scoring must be an object');
  onlyKeys('scoring', value, ['handicapMode', 'maxScore', 'tiebreak']);
  const handicapMode = value.handicapMode ?? DEFAULT_SCORING.handicapMode;
  if (handicapMode !== 'gross' && handicapMode !== 'net') bad("scoring.handicapMode must be 'gross' or 'net'");

  const rawMax = value.maxScore ?? DEFAULT_SCORING.maxScore;
  if (!isPlainObject(rawMax)) return bad('scoring.maxScore must be an object');
  onlyKeys('scoring.maxScore', rawMax, ['mode', 'value']);
  const mode = rawMax.mode ?? 'doublePar';
  if (mode !== 'doublePar' && mode !== 'doubleBogey' && mode !== 'fixed') {
    bad("scoring.maxScore.mode must be 'doublePar', 'doubleBogey' or 'fixed'");
  }
  let maxValue: number | null = null;
  if (mode === 'fixed') {
    if (!isInt(rawMax.value, 1, 20)) bad('scoring.maxScore.value must be a whole number from 1 to 20 for a fixed maximum');
    maxValue = rawMax.value as number;
  } else if (rawMax.value !== undefined && rawMax.value !== null) {
    bad("scoring.maxScore.value is only used with mode 'fixed'");
  }

  const tiebreak = value.tiebreak ?? null;
  if (tiebreak !== null && tiebreak !== 'countback') bad("scoring.tiebreak must be 'countback' or null");

  return {
    handicapMode: handicapMode as 'gross' | 'net',
    maxScore: { mode: mode as 'doublePar' | 'doubleBogey' | 'fixed', value: maxValue },
    tiebreak: tiebreak as 'countback' | null,
  };
}

export interface Skins {
  enabled: boolean;
  mode: 'perSkin' | 'potSplit';
  value: number | null;
  carryover: boolean;
}

export const DEFAULT_SKINS: Skins = { enabled: false, mode: 'perSkin', value: null, carryover: false };

// Stored now, computed later (skins arrive after the stroke-play leaderboard).
export function cleanSkins(value: unknown): Skins {
  if (!isPlainObject(value)) return bad('skins must be an object');
  onlyKeys('skins', value, ['enabled', 'mode', 'value', 'carryover']);
  const enabled = value.enabled ?? DEFAULT_SKINS.enabled;
  if (typeof enabled !== 'boolean') bad('skins.enabled must be true or false');
  const mode = value.mode ?? DEFAULT_SKINS.mode;
  if (mode !== 'perSkin' && mode !== 'potSplit') bad("skins.mode must be 'perSkin' or 'potSplit'");
  let amount: number | null = null;
  if (value.value !== undefined && value.value !== null) {
    if (typeof value.value !== 'number' || !Number.isFinite(value.value) || value.value < 0 || value.value > MAX_WAGER_POT_AMOUNT) {
      bad(`skins.value must be a number from 0 to ${MAX_WAGER_POT_AMOUNT}`);
    }
    amount = Math.round((value.value as number) * 100) / 100;
  }
  const carryover = value.carryover ?? DEFAULT_SKINS.carryover;
  if (typeof carryover !== 'boolean') bad('skins.carryover must be true or false');
  return { enabled: enabled as boolean, mode: mode as 'perSkin' | 'potSplit', value: amount, carryover: carryover as boolean };
}

// ---- groups ----------------------------------------------------------------------------------------

// One side of a match: the players on it. Stored as a list of objects, not a list of lists, because
// Firestore does not allow an array directly inside an array.
export interface Side {
  playerIds: string[];
}

export interface GroupInput {
  id?: string;
  playerIds?: string[];
  teeTime?: string | null;
  teeHole?: number;
  sides?: Side[] | null;
}

export interface CleanGroup {
  id: string | null;
  playerIds: string[];
  teeTime: Date | null;
  teeHole: number;
  sides: Side[] | null;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// Validates the shape of a whole group list. Whether the players are really on the roster is checked by
// the function (it needs the database). Players may appear in only one group, a group holds 1 to
// maxGroupSize players, a group starts on a hole that is in play (the first hole by default), and sides (for
// match play) are two non-empty, separate sets of that group's own players.
export function cleanGroups(
  value: unknown,
  opts: { maxGroupSize: number; firstHole: number; range: PlayRange; skippedHoles: number[]; maxGroups: number },
): CleanGroup[] {
  if (!Array.isArray(value)) return bad('groups must be a list');
  if (value.length > opts.maxGroups) bad(`a round can have at most ${opts.maxGroups} groups`);
  const seenPlayers = new Set<string>();
  const seenIds = new Set<string>();
  return value.map((raw: unknown, i: number): CleanGroup => {
    const label = `group ${i + 1}`;
    if (!isPlainObject(raw)) return bad(`${label} must be an object`);
    onlyKeys(label, raw, ['id', 'playerIds', 'teeTime', 'teeHole', 'sides']);

    let id: string | null = null;
    if (raw.id !== undefined && raw.id !== null) {
      if (typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) bad(`${label}: id is not valid`);
      if (seenIds.has(raw.id as string)) bad(`${label}: id appears twice`);
      seenIds.add(raw.id as string);
      id = raw.id as string;
    }

    if (!Array.isArray(raw.playerIds) || raw.playerIds.length === 0) bad(`${label} needs at least one player`);
    const playerIds = raw.playerIds as unknown[];
    if (playerIds.length > opts.maxGroupSize) bad(`${label} has ${playerIds.length} players; the limit is ${opts.maxGroupSize}`);
    for (const player of playerIds) {
      if (typeof player !== 'string' || !ID_PATTERN.test(player)) bad(`${label}: a player id is not valid`);
      if (seenPlayers.has(player as string)) bad(`a player appears in more than one group`);
      seenPlayers.add(player as string);
    }

    const teeTime = cleanTeeTime(raw.teeTime);
    const teeHole = raw.teeHole === undefined ? opts.firstHole : raw.teeHole;
    if (!isInt(teeHole, opts.range.first, opts.range.last)) {
      bad(`${label}: teeHole must be a hole from ${opts.range.first} to ${opts.range.last}`);
    }
    if (opts.skippedHoles.includes(teeHole as number)) bad(`${label}: cannot start on hole ${teeHole}, which is out of play`);

    let sides: Side[] | null = null;
    if (raw.sides !== undefined && raw.sides !== null) {
      if (!Array.isArray(raw.sides) || raw.sides.length !== 2) bad(`${label}: sides must be two sides, like [{ playerIds: [...] }, { playerIds: [...] }]`);
      const used = new Set<string>();
      sides = (raw.sides as unknown[]).map((side): Side => {
        if (!isPlainObject(side)) return bad(`${label}: each side must be an object with playerIds`);
        onlyKeys(`${label} side`, side, ['playerIds']);
        if (!Array.isArray(side.playerIds) || side.playerIds.length === 0) bad(`${label}: each side needs at least one player`);
        return {
          playerIds: (side.playerIds as unknown[]).map((player) => {
            if (typeof player !== 'string' || !(playerIds as string[]).includes(player)) {
              bad(`${label}: a side lists a player who is not in the group`);
            }
            if (used.has(player as string)) bad(`${label}: a player is on both sides`);
            used.add(player as string);
            return player as string;
          }),
        };
      });
    }
    return { id, playerIds: playerIds as string[], teeTime, teeHole: teeHole as number, sides };
  });
}
