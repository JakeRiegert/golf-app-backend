import { createHash } from 'node:crypto';

import { HttpsError } from 'firebase-functions/v2/https';

import {
  FORMAT_IDS,
  MAX_COURSE_NAME_LENGTH,
  MAX_GROUP_SIZE_CAP,
  MAX_ROUND_NAME_LENGTH,
  MAX_STROKES,
  MAX_TEE_SETS,
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

// An optional label an organizer gives a round, like "Practice" or "Friday AM". Empty or absent means no name
// (the app then shows its play-order label). Trimmed, and refused if too long or if it has control characters.
export function cleanRoundName(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return bad('name must be text');
  const name = value.trim();
  if (name.length === 0) return null;
  if (name.length > MAX_ROUND_NAME_LENGTH) return bad(`name must be at most ${MAX_ROUND_NAME_LENGTH} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return bad('name cannot contain control characters');
  return name;
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

// One hole. `strokeIndex` is the men's (or only) hole ranking and `strokeIndexWomen` the women's, which real
// scorecards print as a second row and which can differ on most holes. `parWomen` is set only on a hole whose par
// is different for women; null means the same par.
export interface CourseHole {
  par: number;
  parWomen: number | null;
  strokeIndex: number;
  strokeIndexWomen: number | null;
}

export interface RatingPair {
  rating: number;
  slope: number;
}

// A set of tee markers: its own yardage for every hole, and its own rating and slope for men and for women.
export interface CourseTee {
  id: string;
  name: string;
  // One entry per hole of the course (null where unknown).
  yards: (number | null)[];
  men: RatingPair | null;
  women: RatingPair | null;
}

export interface Course {
  name: string;
  holes: CourseHole[];
  tees: CourseTee[];
}

// Which rating table (and which hole ranking row) a player plays by.
export type RatingTable = 'men' | 'women';

export function cleanRatingTable(value: unknown, field = 'table'): RatingTable {
  if (value !== 'men' && value !== 'women') bad(`${field} must be 'men' or 'women'`);
  return value as RatingTable;
}

// The par a player of this table faces on a hole (1-based hole number). Falls back to the men's par.
export function parForTable(course: Course, hole: number, table: RatingTable | null): number | null {
  const entry = course.holes[hole - 1];
  if (!entry) return null;
  return table === 'women' && entry.parWomen !== null ? entry.parWomen : entry.par;
}

const RATING_MIN = 50;
const RATING_MAX = 90;
const SLOPE_MIN = 55;
const SLOPE_MAX = 155;

function cleanRatingPair(value: unknown, field: string): RatingPair | null {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) return bad(`${field} must be { rating, slope }`);
  onlyKeys(field, value, ['rating', 'slope']);
  if (typeof value.rating !== 'number' || !Number.isFinite(value.rating) || value.rating < RATING_MIN || value.rating > RATING_MAX) {
    bad(`${field}.rating must be a number from ${RATING_MIN} to ${RATING_MAX}`);
  }
  if (!isInt(value.slope, SLOPE_MIN, SLOPE_MAX)) bad(`${field}.slope must be a whole number from ${SLOPE_MIN} to ${SLOPE_MAX}`);
  return { rating: Math.round((value.rating as number) * 10) / 10, slope: value.slope as number };
}

function cleanYards(value: unknown, count: number, field: string): (number | null)[] {
  if (value === undefined || value === null) return Array<number | null>(count).fill(null);
  if (!Array.isArray(value) || value.length !== count) return bad(`${field}.yards must list ${count} holes (use null for an unknown one)`);
  return value.map((yards: unknown, i: number) => {
    if (yards === null) return null;
    if (!isInt(yards, 1, 1000)) bad(`${field}, hole ${i + 1}: yards must be a whole number from 1 to 1000`);
    return yards as number;
  });
}

const TEE_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

// The older single-tee spelling (a tee name text, one rating and slope, yards on each hole) is still accepted
// and becomes one tee set, so clients and stored rounds written before tee sets existed keep working.
function legacyTees(value: Record<string, unknown>, holes: unknown[]): CourseTee[] {
  const hasYards = holes.some((hole) => isPlainObject(hole) && hole.yards !== undefined && hole.yards !== null);
  const hasName = value.tees !== undefined && value.tees !== null && value.tees !== '';
  const hasRating = value.rating !== undefined && value.rating !== null;
  const hasSlope = value.slope !== undefined && value.slope !== null;
  if (!hasYards && !hasName && !hasRating && !hasSlope) return [];
  let name = 'Default';
  if (hasName) {
    if (typeof value.tees !== 'string' || value.tees.trim().length === 0 || value.tees.trim().length > MAX_TEES_LENGTH) {
      bad(`course.tees must be at most ${MAX_TEES_LENGTH} characters`);
    }
    name = (value.tees as string).trim();
  }
  let men: RatingPair | null = null;
  if (hasRating || hasSlope) {
    if (!hasRating || !hasSlope) bad('course.rating and course.slope go together');
    men = cleanRatingPair({ rating: value.rating, slope: value.slope }, 'course');
  }
  const yards = holes.map((hole, i) => {
    const raw = isPlainObject(hole) ? hole.yards : null;
    if (raw === undefined || raw === null) return null;
    if (!isInt(raw, 1, 1000)) bad(`hole ${i + 1}: yards must be a whole number from 1 to 1000`);
    return raw as number;
  });
  return [{ id: 't1', name, yards, men, women: null }];
}

function cleanTees(value: unknown, count: number): CourseTee[] {
  if (!Array.isArray(value)) return bad('course.tees must be a list of tee sets');
  if (value.length > MAX_TEE_SETS) bad(`a course can have at most ${MAX_TEE_SETS} tee sets`);
  const ids = new Set<string>();
  const names = new Set<string>();
  return value.map((raw: unknown, i: number): CourseTee => {
    const label = `course.tees[${i}]`;
    if (!isPlainObject(raw)) return bad(`${label} must be an object`);
    onlyKeys(label, raw, ['id', 'name', 'yards', 'men', 'women']);
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (name.length === 0 || name.length > MAX_TEES_LENGTH) bad(`${label}.name must be 1-${MAX_TEES_LENGTH} characters`);
    if (names.has(name.toLowerCase())) bad(`${label}: another tee is already named ${name}`);
    names.add(name.toLowerCase());
    let id: string;
    if (raw.id === undefined || raw.id === null) {
      let n = i + 1;
      while (ids.has(`t${n}`)) n += 1;
      id = `t${n}`;
    } else {
      if (typeof raw.id !== 'string' || !TEE_ID_PATTERN.test(raw.id)) return bad(`${label}.id is not valid`);
      id = raw.id;
    }
    if (ids.has(id)) bad(`${label}: tee id ${id} is used twice`);
    ids.add(id);
    return {
      id,
      name,
      yards: cleanYards(raw.yards, count, label),
      men: cleanRatingPair(raw.men, `${label}.men`),
      women: cleanRatingPair(raw.women, `${label}.women`),
    };
  });
}

// The round's own copy of the course: par and the two hole-ranking rows for every hole, and the tee sets (yardage,
// rating and slope for men and for women). It must cover the holes the round plays (a back-nine round needs 18
// holes); each ranking row uses 1..N exactly once, and the women's row is given for all holes or none.
// null clears it (a round can exist before its course is known).
export function cleanCourse(value: unknown, range: PlayRange): Course | null {
  if (value === null) return null;
  if (!isPlainObject(value)) return bad('course must be an object, or null to clear it');
  onlyKeys('course', value, ['name', 'tees', 'rating', 'slope', 'holes']);

  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (name.length === 0 || name.length > MAX_COURSE_NAME_LENGTH) {
    bad(`course.name must be 1-${MAX_COURSE_NAME_LENGTH} characters`);
  }

  if (!Array.isArray(value.holes) || (value.holes.length !== 9 && value.holes.length !== 18)) {
    return bad('course.holes must list 9 or 18 holes');
  }
  const count = value.holes.length;
  if (range.last > count) bad(`this round plays hole ${range.last}, but the course lists only ${count} holes`);

  const rawHoles = value.holes as unknown[];
  const seenMen = new Set<number>();
  const seenWomen = new Set<number>();
  const holes = rawHoles.map((raw: unknown, i: number): CourseHole => {
    if (!isPlainObject(raw)) return bad(`course.holes[${i}] must be an object`);
    onlyKeys(`course.holes[${i}]`, raw, ['par', 'parWomen', 'strokeIndex', 'strokeIndexWomen', 'yards']);
    if (!isInt(raw.par, 3, 6)) bad(`hole ${i + 1}: par must be a whole number from 3 to 6`);
    let parWomen: number | null = null;
    if (raw.parWomen !== undefined && raw.parWomen !== null) {
      if (!isInt(raw.parWomen, 3, 6)) bad(`hole ${i + 1}: parWomen must be a whole number from 3 to 6`);
      parWomen = raw.parWomen as number;
    }
    if (!isInt(raw.strokeIndex, 1, count)) bad(`hole ${i + 1}: strokeIndex must be a whole number from 1 to ${count}`);
    if (seenMen.has(raw.strokeIndex as number)) bad(`hole ${i + 1}: strokeIndex ${raw.strokeIndex} is used twice`);
    seenMen.add(raw.strokeIndex as number);
    let strokeIndexWomen: number | null = null;
    if (raw.strokeIndexWomen !== undefined && raw.strokeIndexWomen !== null) {
      if (!isInt(raw.strokeIndexWomen, 1, count)) bad(`hole ${i + 1}: strokeIndexWomen must be a whole number from 1 to ${count}`);
      if (seenWomen.has(raw.strokeIndexWomen as number)) bad(`hole ${i + 1}: strokeIndexWomen ${raw.strokeIndexWomen} is used twice`);
      seenWomen.add(raw.strokeIndexWomen as number);
      strokeIndexWomen = raw.strokeIndexWomen as number;
    }
    return { par: raw.par as number, parWomen, strokeIndex: raw.strokeIndex as number, strokeIndexWomen };
  });
  if (seenWomen.size !== 0 && seenWomen.size !== count) {
    bad("the women's hole ranking (strokeIndexWomen) must be given for every hole or for none");
  }

  const tees = Array.isArray(value.tees) ? cleanTees(value.tees, count) : legacyTees(value, rawHoles);
  if (Array.isArray(value.tees)) {
    // Mixing the two spellings is ambiguous, so it is refused.
    if (value.rating !== undefined || value.slope !== undefined || rawHoles.some((hole) => isPlainObject(hole) && hole.yards !== undefined)) {
      bad('with a list of tee sets, put rating, slope and yards inside each tee set');
    }
  }
  return { name, holes, tees };
}

// A short description for the activity feed: enough to show what changed without storing 18 holes.
export function courseSummary(course: Course | null): Record<string, unknown> | null {
  if (!course) return null;
  return {
    name: course.name,
    tees: course.tees.map((tee) => tee.name),
    par: course.holes.reduce((total, hole) => total + hole.par, 0),
    holes: createHash('sha1').update(stableStringify([course.holes, course.tees])).digest('hex').slice(0, 8),
  };
}

// The tee a round offers by default: the one given if it exists on the course. With `explicit` false a missing or
// unknown id quietly falls back to the first tee (so editing the course never leaves a dangling default); with
// `explicit` true an unknown id is an error. No tees on the course means no default.
export function cleanDefaultTee(value: unknown, course: Course | null, explicit: boolean): string | null {
  if (!course || course.tees.length === 0) {
    if (explicit && value !== undefined && value !== null) bad('this round has no tee sets to choose from yet');
    return null;
  }
  const known = typeof value === 'string' && course.tees.some((tee) => tee.id === value);
  if (known) return value as string;
  if (explicit && value !== undefined && value !== null) bad("defaultTeeId is not one of this course's tees");
  return course.tees[0].id;
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
  // 'none' records the real score with no maximum (some formats, such as a high school match, need every stroke).
  maxScore: { mode: 'doublePar' | 'doubleBogey' | 'fixed' | 'none'; value: number | null };
  tiebreak: 'countback' | null;
}

export const DEFAULT_SCORING: Scoring = {
  handicapMode: 'net',
  maxScore: { mode: 'doublePar', value: null },
  tiebreak: null,
};

// Settings that were not given keep their value from `base` (the defaults unless the caller passes the round's
// or tournament's current settings), so { handicapMode: 'gross' } alone is valid and changes nothing else.
export function cleanScoring(value: unknown, base: Scoring = DEFAULT_SCORING): Scoring {
  if (!isPlainObject(value)) return bad('scoring must be an object');
  onlyKeys('scoring', value, ['handicapMode', 'maxScore', 'tiebreak']);
  const handicapMode = value.handicapMode ?? base.handicapMode;
  if (handicapMode !== 'gross' && handicapMode !== 'net') bad("scoring.handicapMode must be 'gross' or 'net'");

  const rawMax = value.maxScore ?? base.maxScore;
  if (!isPlainObject(rawMax)) return bad('scoring.maxScore must be an object');
  onlyKeys('scoring.maxScore', rawMax, ['mode', 'value']);
  const mode = rawMax.mode ?? base.maxScore.mode;
  if (mode !== 'doublePar' && mode !== 'doubleBogey' && mode !== 'fixed' && mode !== 'none') {
    bad("scoring.maxScore.mode must be 'doublePar', 'doubleBogey', 'fixed' or 'none'");
  }
  let maxValue: number | null = null;
  if (mode === 'fixed') {
    if (!isInt(rawMax.value, 1, MAX_STROKES)) bad(`scoring.maxScore.value must be a whole number from 1 to ${MAX_STROKES} for a fixed maximum`);
    maxValue = rawMax.value as number;
  } else if (rawMax.value !== undefined && rawMax.value !== null) {
    bad("scoring.maxScore.value is only used with mode 'fixed'");
  }

  const tiebreak = value.tiebreak === undefined ? base.tiebreak : value.tiebreak;
  if (tiebreak !== null && tiebreak !== 'countback') bad("scoring.tiebreak must be 'countback' or null");

  return {
    handicapMode: handicapMode as 'gross' | 'net',
    maxScore: { mode: mode as 'doublePar' | 'doubleBogey' | 'fixed' | 'none', value: maxValue },
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
