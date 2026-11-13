import { DocumentData, DocumentReference, FieldValue, Firestore, Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';

import { announce, logActivity } from './activity';
import { assertAdmin, requireId, requireTournamentId } from './authz';
import { getDb } from './firestore';
import { DEFAULT_GROUP_SIZE, MAX_ROUNDS_PER_TOURNAMENT } from './limits';
import {
  cleanCourse,
  cleanFirstHole,
  cleanFormats,
  cleanHolesPlanned,
  cleanMaxGroupSize,
  cleanRoundName,
  cleanScoring,
  cleanSkippedHoles,
  cleanSkins,
  cleanTimeZone,
  Course,
  courseSummary,
  DEFAULT_FORMATS,
  DEFAULT_SCORING,
  DEFAULT_SKINS,
  playRange,
  RoundFormat,
  sameValue,
  Scoring,
  Skins,
} from './roundRules';
import { cleanDate } from './tournaments';
import { callable, UsageTracker } from './usage';

// Rounds: one playing day in a tournament (docs/rounds-data-model.md, section 2.1).
//   tournaments/{id}/rounds/{roundId}
// Admins (organizer or co-admin) create and change them; everyone who can see the tournament reads them
// (security rules). Groups live under the round and are set by setGroups (groups.ts).

export const ROUND_STATUS = {
  SCHEDULED: 'scheduled',
  LIVE: 'live',
  PENDING_REVIEW: 'pending_review',
  FINALIZED: 'finalized',
  CANCELLED: 'cancelled',
} as const;

export interface RoundSettings {
  date?: string;
  // An optional label like "Practice"; null or empty clears it.
  name?: string | null;
  timeZone?: string | null;
  holesPlanned?: number;
  firstHole?: number;
  maxGroupSize?: number;
  skippedHoles?: number[];
  course?: Course | null;
  formats?: RoundFormat[];
  scoring?: Partial<Scoring>;
  skins?: Partial<Skins>;
  // A round dated outside the tournament's start and end dates is refused unless the admin agrees to move
  // those dates to include it.
  extendTournamentDates?: boolean;
}

export interface CreateRoundInput extends RoundSettings {
  tournamentId?: string;
}

export interface UpdateRoundInput extends RoundSettings {
  tournamentId?: string;
  roundId?: string;
}

export interface RoundView {
  id: string;
  // The order the rounds were added in. Fixed for the life of the round and never shown as a label: the app
  // shows rounds by date and numbers them by position, so a round added later for an earlier day slots in
  // without renaming the others. Use roundId to refer to a round.
  number: number;
  name: string | null;
  date: string;
  timeZone: string | null;
  status: string;
  holesPlanned: number;
  firstHole: number;
  maxGroupSize: number;
  skippedHoles: number[];
  course: Course | null;
  courseSource: string | null;
  formats: RoundFormat[];
  scoring: Scoring;
  skins: Skins;
}

const SETTING_KEYS = [
  'date',
  'name',
  'timeZone',
  'holesPlanned',
  'firstHole',
  'maxGroupSize',
  'skippedHoles',
  'course',
  'formats',
  'scoring',
  'skins',
  'extendTournamentDates',
];

function rejectUnknownKeys(input: object, extra: string[]): void {
  const allowed = new Set([...SETTING_KEYS, ...extra]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new HttpsError('invalid-argument', `${key} cannot be set here`);
  }
}

function toView(id: string, data: DocumentData): RoundView {
  return {
    id,
    number: data.number,
    name: data.name ?? null,
    date: data.date,
    timeZone: data.timeZone ?? null,
    status: data.status,
    holesPlanned: data.holesPlanned,
    firstHole: data.firstHole,
    maxGroupSize: data.maxGroupSize,
    skippedHoles: data.skippedHoles ?? [],
    course: data.course ?? null,
    courseSource: data.courseSource ?? null,
    formats: data.formats,
    scoring: data.scoring,
    skins: data.skins,
  };
}

// If the date falls outside the tournament's start and end dates, either refuse (the admin has not agreed)
// or work out the widened dates. Returns the tournament fields to change, or null when none.
function neededDateExtension(
  tournament: DocumentData,
  date: string,
  allowExtend: boolean,
): { startDate?: string; endDate?: string } | null {
  const start = (tournament.startDate as string | null | undefined) ?? null;
  const end = (tournament.endDate as string | null | undefined) ?? null;
  const widen: { startDate?: string; endDate?: string } = {};
  if (start && date < start) widen.startDate = date;
  if (end && date > end) widen.endDate = date;
  if (Object.keys(widen).length === 0) return null;
  if (!allowExtend) {
    throw new HttpsError(
      'failed-precondition',
      `This date is outside the tournament dates (${start ?? '...'} to ${end ?? '...'}). Pass extendTournamentDates to widen them.`,
    );
  }
  return widen;
}

// Written after all of the transaction's reads: widen the tournament dates and record it.
function applyDateExtension(
  tx: Transaction,
  tournamentRef: DocumentReference,
  tournament: DocumentData,
  widen: { startDate?: string; endDate?: string },
  uid: string,
  usage: UsageTracker,
): void {
  tx.update(tournamentRef, { ...widen, updatedAt: FieldValue.serverTimestamp() });
  usage.wrote();
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  if (widen.startDate) changes.startDate = { from: tournament.startDate ?? null, to: widen.startDate };
  if (widen.endDate) changes.endDate = { from: tournament.endDate ?? null, to: widen.endDate };
  logActivity(tx, tournamentRef, usage, {
    type: 'tournament_updated',
    actorId: uid,
    level: announce(Boolean(tournament.startedAt), 'admins'),
    changes,
    data: { reason: 'round_date' },
  });
}

// Admin: add a round. It can be created at any time, before or after the tournament has started (an extra
// day, or a replacement after a rainout). The new round takes the next number. Anything not given takes
// the tournament's default (holes, group size) or a built-in one (18 holes, groups of 4, stroke play, net,
// double par maximum, no skins). The course is optional here and can be entered by hand later.
export async function createRound(
  db: Firestore,
  uid: string,
  input: CreateRoundInput,
  usage: UsageTracker,
): Promise<RoundView> {
  const tournamentId = requireTournamentId(input.tournamentId);
  rejectUnknownKeys(input, ['tournamentId']);
  const date = cleanDate('date', input.date);
  if (!date) throw new HttpsError('invalid-argument', 'date is required, like 2026-11-14');
  if (input.extendTournamentDates !== undefined && typeof input.extendTournamentDates !== 'boolean') {
    throw new HttpsError('invalid-argument', 'extendTournamentDates must be true or false');
  }

  usage.forTournament(tournamentId);
  const tournamentRef = db.collection('tournaments').doc(tournamentId);
  const roundsRef = tournamentRef.collection('rounds');

  return db.runTransaction(async (tx) => {
    const tournament = await assertAdmin(tx, tournamentRef, uid, usage);
    const existing = await tx.get(roundsRef);
    usage.read(existing.size);
    if (existing.size >= MAX_ROUNDS_PER_TOURNAMENT) {
      throw new HttpsError(
        'resource-exhausted',
        `A tournament can have at most ${MAX_ROUNDS_PER_TOURNAMENT} rounds (it has ${existing.size})`,
      );
    }

    const holesPlanned = cleanHolesPlanned(input.holesPlanned ?? tournament.defaultHolesPlanned ?? 18);
    const firstHole = cleanFirstHole(input.firstHole ?? 1, holesPlanned);
    const range = playRange(firstHole, holesPlanned);
    const maxGroupSize = cleanMaxGroupSize(input.maxGroupSize ?? tournament.defaultMaxGroupSize ?? DEFAULT_GROUP_SIZE);
    const skippedHoles = input.skippedHoles === undefined ? [] : cleanSkippedHoles(input.skippedHoles, range);
    const course = input.course === undefined ? null : cleanCourse(input.course, range);
    const formats = input.formats === undefined ? DEFAULT_FORMATS : cleanFormats(input.formats);
    const scoring = input.scoring === undefined ? DEFAULT_SCORING : cleanScoring(input.scoring);
    const skins = input.skins === undefined ? DEFAULT_SKINS : cleanSkins(input.skins);
    const timeZone = input.timeZone === undefined ? (tournament.timeZone ?? null) : cleanTimeZone(input.timeZone);
    const name = cleanRoundName(input.name);
    const widen = neededDateExtension(tournament, date, input.extendTournamentDates === true);

    const number = existing.docs.reduce((highest, doc) => Math.max(highest, (doc.data().number as number) ?? 0), 0) + 1;
    const roundRef = roundsRef.doc();
    const data = {
      number,
      name,
      date,
      timeZone,
      status: ROUND_STATUS.SCHEDULED,
      holesPlanned,
      firstHole,
      maxGroupSize,
      skippedHoles,
      course,
      courseSource: course ? 'manual' : null,
      courseVerifiedAt: null,
      courseVerifiedBy: null,
      formats,
      scoring,
      skins,
      createdBy: uid,
      startedAt: null,
      endedAt: null,
      finalizedAt: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    tx.create(roundRef, data);
    usage.wrote();
    if (widen) applyDateExtension(tx, tournamentRef, tournament, widen, uid, usage);
    logActivity(tx, tournamentRef, usage, {
      type: 'round_created',
      actorId: uid,
      level: announce(Boolean(tournament.startedAt), 'admins'),
      data: { roundId: roundRef.id, number, name, date, courseName: course?.name ?? null },
    });
    return toView(roundRef.id, data);
  });
}

// Settings that describe the course and the holes in play. Once any score exists they are fixed, so a
// finished hole can never change meaning under a score that was already entered.
const FROZEN_AFTER_FIRST_SCORE = ['course', 'holesPlanned', 'firstHole', 'skippedHoles'] as const;

// Admin: change a round's settings. Only the settings given change; passing course: null clears the course.
// Changes that leave a setting as it was do nothing and leave no feed event. Refused for a cancelled,
// finished or under-review round. The course and the holes in play are refused once a score exists.
export async function updateRound(
  db: Firestore,
  uid: string,
  input: UpdateRoundInput,
  usage: UsageTracker,
): Promise<RoundView> {
  const tournamentId = requireTournamentId(input.tournamentId);
  const roundId = requireId('roundId', input.roundId);
  rejectUnknownKeys(input, ['tournamentId', 'roundId']);
  const given = SETTING_KEYS.filter((key) => key !== 'extendTournamentDates' && (input as Record<string, unknown>)[key] !== undefined);
  if (given.length === 0) throw new HttpsError('invalid-argument', 'provide at least one setting to change');
  if (input.extendTournamentDates !== undefined && typeof input.extendTournamentDates !== 'boolean') {
    throw new HttpsError('invalid-argument', 'extendTournamentDates must be true or false');
  }
  const newDate = input.date === undefined ? undefined : cleanDate('date', input.date);
  if (input.date !== undefined && !newDate) throw new HttpsError('invalid-argument', 'date cannot be empty');

  usage.forTournament(tournamentId);
  const tournamentRef = db.collection('tournaments').doc(tournamentId);
  const roundRef = tournamentRef.collection('rounds').doc(roundId);

  return db.runTransaction(async (tx) => {
    const tournament = await assertAdmin(tx, tournamentRef, uid, usage);
    const snap = await tx.get(roundRef);
    usage.read();
    const current = snap.data();
    if (!current) throw new HttpsError('not-found', 'Round not found in this tournament');
    if (current.status !== ROUND_STATUS.SCHEDULED && current.status !== ROUND_STATUS.LIVE) {
      throw new HttpsError('failed-precondition', `This round is ${current.status} and can no longer be changed`);
    }

    // The new values: what was given, cleaned, else what the round already has.
    const holesPlanned = input.holesPlanned === undefined ? (current.holesPlanned as number) : cleanHolesPlanned(input.holesPlanned);
    const holesChanged = holesPlanned !== current.holesPlanned;
    const firstHole = cleanFirstHole(
      input.firstHole === undefined ? (current.firstHole as number) : input.firstHole,
      holesPlanned as 9 | 18,
    );
    const range = playRange(firstHole, holesPlanned);
    const rangeChanged = holesChanged || firstHole !== current.firstHole;
    const maxGroupSize = input.maxGroupSize === undefined ? (current.maxGroupSize as number) : cleanMaxGroupSize(input.maxGroupSize);
    // A setting that depends on the range is checked again against it, so a change to the range cannot
    // leave a skipped hole or the course pointing at holes the round no longer plays.
    const skippedHoles = cleanSkippedHoles(input.skippedHoles === undefined ? (current.skippedHoles ?? []) : input.skippedHoles, range);
    const course = cleanCourse(input.course === undefined ? (current.course ?? null) : input.course, range);
    const formats = input.formats === undefined ? (current.formats as RoundFormat[]) : cleanFormats(input.formats);
    const scoring = input.scoring === undefined ? (current.scoring as Scoring) : cleanScoring(input.scoring);
    const skins = input.skins === undefined ? (current.skins as Skins) : cleanSkins(input.skins);
    const timeZone = input.timeZone === undefined ? (current.timeZone ?? null) : cleanTimeZone(input.timeZone);
    const date = newDate ?? (current.date as string);
    const name = input.name === undefined ? ((current.name as string | null | undefined) ?? null) : cleanRoundName(input.name);

    const next = { name, date, timeZone, holesPlanned, firstHole, maxGroupSize, skippedHoles, course, formats, scoring, skins };
    const before = {
      name: current.name ?? null,
      date: current.date,
      timeZone: current.timeZone ?? null,
      holesPlanned: current.holesPlanned,
      firstHole: current.firstHole,
      maxGroupSize: current.maxGroupSize,
      skippedHoles: current.skippedHoles ?? [],
      course: current.course ?? null,
      formats: current.formats,
      scoring: current.scoring,
      skins: current.skins,
    };
    const changed = (Object.keys(next) as (keyof typeof next)[]).filter((key) => !sameValue(next[key], before[key]));
    if (changed.length === 0) return toView(roundId, current);

    // Reads that decide whether the change is allowed, all before any write.
    if (changed.some((key) => (FROZEN_AFTER_FIRST_SCORE as readonly string[]).includes(key))) {
      const scores = await tx.get(roundRef.collection('scores').limit(1));
      usage.read(scores.size);
      if (!scores.empty) {
        throw new HttpsError(
          'failed-precondition',
          'A score has been entered, so the course and the holes in play can no longer be changed',
        );
      }
    }
    if (changed.some((key) => key === 'holesPlanned' || key === 'firstHole' || key === 'skippedHoles' || key === 'maxGroupSize')) {
      const groups = await tx.get(roundRef.collection('groups'));
      usage.read(groups.size);
      for (const group of groups.docs) {
        const data = group.data();
        if (data.teeHole < range.first || data.teeHole > range.last || skippedHoles.includes(data.teeHole)) {
          throw new HttpsError(
            'failed-precondition',
            `Group ${data.order} starts on hole ${data.teeHole}, which this change takes out of play. Change its starting hole first.`,
          );
        }
        if ((data.playerIds as string[]).length > maxGroupSize) {
          throw new HttpsError(
            'failed-precondition',
            `Group ${data.order} has ${(data.playerIds as string[]).length} players, more than ${maxGroupSize}. Move some of its players to another group first, then lower the size.`,
          );
        }
      }
    }
    const widen = changed.includes('date')
      ? neededDateExtension(tournament, date, input.extendTournamentDates === true)
      : null;

    const updates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
    for (const key of changed) updates[key] = next[key];
    if (changed.includes('course')) {
      // A course entered or edited here is by hand; a later verification step records who checked it.
      updates.courseSource = course ? 'manual' : null;
      updates.courseVerifiedAt = null;
      updates.courseVerifiedBy = null;
    }
    tx.update(roundRef, updates);
    usage.wrote();
    if (widen) applyDateExtension(tx, tournamentRef, tournament, widen, uid, usage);

    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const key of changed) {
      changes[key] =
        key === 'course'
          ? { from: courseSummary(before.course as Course | null), to: courseSummary(course) }
          : { from: before[key], to: next[key] };
    }
    logActivity(tx, tournamentRef, usage, {
      type: 'round_updated',
      actorId: uid,
      level: announce(Boolean(tournament.startedAt), 'admins'),
      changes,
      data: { roundId, number: current.number, name },
    });
    return toView(roundId, { ...current, ...updates });
  });
}

export interface DeleteRoundInput {
  tournamentId?: string;
  roundId?: string;
}

// Admin: remove a round that has not been played (a mistaken round, or a replaced one), together with its
// groups. Only a round still 'scheduled' with no score on it can go; anything with scores is cancelled
// instead (a later step), so a result is never deleted. Refused for an
// unknown round. Players have already seen the groups and tee times, so the feed event goes to everyone when
// the round had groups, and follows the usual before-Start rule otherwise.
// Also refused when the round has any score submission (even a pending or rejected one). Any per-round
// collection added later must be deleted here or must block deletion.
export async function deleteRound(
  db: Firestore,
  uid: string,
  input: DeleteRoundInput,
  usage: UsageTracker,
): Promise<{ roundId: string; deleted: true }> {
  const tournamentId = requireTournamentId(input.tournamentId);
  const roundId = requireId('roundId', input.roundId);
  usage.forTournament(tournamentId);
  const tournamentRef = db.collection('tournaments').doc(tournamentId);
  const roundRef = tournamentRef.collection('rounds').doc(roundId);

  return db.runTransaction(async (tx) => {
    const tournament = await assertAdmin(tx, tournamentRef, uid, usage);
    const snap = await tx.get(roundRef);
    usage.read();
    const current = snap.data();
    if (!current) throw new HttpsError('not-found', 'Round not found in this tournament');
    if (current.status !== ROUND_STATUS.SCHEDULED) {
      throw new HttpsError('failed-precondition', `This round is ${current.status}, so it cannot be deleted`);
    }
    const scores = await tx.get(roundRef.collection('scores').limit(1));
    usage.read(scores.size);
    if (!scores.empty) {
      throw new HttpsError('failed-precondition', 'A score has been entered, so this round cannot be deleted');
    }
    // A score still waiting to be checked (or one that was turned away) counts too: it belongs to this round.
    const submissions = await tx.get(roundRef.collection('submissions').limit(1));
    usage.read(submissions.size);
    if (!submissions.empty) {
      throw new HttpsError('failed-precondition', 'A score has been entered or is waiting to sync, so this round cannot be deleted');
    }
    const groups = await tx.get(roundRef.collection('groups'));
    usage.read(groups.size);

    for (const group of groups.docs) {
      tx.delete(group.ref);
      usage.wrote();
    }
    tx.delete(roundRef);
    usage.wrote();
    logActivity(tx, tournamentRef, usage, {
      type: 'round_deleted',
      actorId: uid,
      level: groups.empty ? announce(Boolean(tournament.startedAt), 'admins') : 'all',
      data: { roundId, number: current.number, name: current.name ?? null, date: current.date },
    });
    return { roundId, deleted: true };
  });
}

export const createRoundCallable = callable<CreateRoundInput, RoundView>(
  'createRound',
  async (request, usage, uid) => createRound(getDb(), uid, request.data ?? {}, usage),
);

export const deleteRoundCallable = callable<DeleteRoundInput, { roundId: string; deleted: true }>(
  'deleteRound',
  async (request, usage, uid) => deleteRound(getDb(), uid, request.data ?? {}, usage),
);

export const updateRoundCallable = callable<UpdateRoundInput, RoundView>(
  'updateRound',
  async (request, usage, uid) => updateRound(getDb(), uid, request.data ?? {}, usage),
);
