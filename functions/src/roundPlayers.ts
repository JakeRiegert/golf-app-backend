import { FieldValue, Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';

import { logActivity } from './activity';
import { isAdminOf, readActiveTournament, requireId, requireTournamentId } from './authz';
import { getDb } from './firestore';
import { MAX_ROUND_PLAYER_EDITS } from './limits';
import { cleanRatingTable, Course, RatingTable } from './roundRules';
import { ROUND_STATUS } from './rounds';
import { callable, UsageTracker } from './usage';

// Tee picks and check-in, per player per round (docs/rounds-data-model.md, section 2.1c).
//   tournaments/{id}/rounds/{roundId}/roundPlayers/{playerId}
//     playerId, teeId (one of the course's tee ids, or null), table ('men' | 'women' | null: which rating table and
//     hole-ranking row the player plays by), checkedIn, checkedInAt, checkedInBy (the player or an admin), setBy, updatedAt
// Written only here (clients read them, security rules: roster members and admins). A player sets their own tee and
// checks themselves in; an organizer or co-admin can do the same for anyone, ahead of time or on the day. Choosing a
// tee is NOT checking in: an organizer can pre-set everyone's tee and still see who has actually turned up.

export interface RoundPlayerEdit {
  playerId?: string;
  teeId?: string | null;
  table?: RatingTable | null;
  checkedIn?: boolean;
}

export interface SetRoundPlayersInput {
  tournamentId?: string;
  roundId?: string;
  players?: RoundPlayerEdit[];
}

export interface RoundPlayerView {
  playerId: string;
  teeId: string | null;
  table: RatingTable | null;
  checkedIn: boolean;
}

interface CleanEdit {
  playerId: string;
  teeId: string | null | undefined;
  table: RatingTable | null | undefined;
  checkedIn: boolean | undefined;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function bad(message: string): never {
  throw new HttpsError('invalid-argument', message);
}

function cleanEdits(value: unknown, uid: string): CleanEdit[] {
  if (!Array.isArray(value) || value.length === 0) return bad('players must be a list with at least one player');
  if (value.length > MAX_ROUND_PLAYER_EDITS) bad(`at most ${MAX_ROUND_PLAYER_EDITS} players can be changed in one call`);
  const seen = new Set<string>();
  return value.map((raw: unknown, i: number): CleanEdit => {
    const label = `players[${i}]`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return bad(`${label} must be an object`);
    const entry = raw as Record<string, unknown>;
    for (const key of Object.keys(entry)) {
      if (!['playerId', 'teeId', 'table', 'checkedIn'].includes(key)) bad(`${label}.${key} is not a known setting`);
    }
    const playerId = entry.playerId === undefined ? uid : entry.playerId;
    if (typeof playerId !== 'string' || !ID_PATTERN.test(playerId)) bad(`${label}.playerId is not valid`);
    if (seen.has(playerId as string)) bad('a player appears twice');
    seen.add(playerId as string);

    let teeId: string | null | undefined;
    if (entry.teeId !== undefined) {
      if (entry.teeId !== null && (typeof entry.teeId !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(entry.teeId))) {
        bad(`${label}.teeId is not valid`);
      }
      teeId = entry.teeId as string | null;
    }
    let table: RatingTable | null | undefined;
    if (entry.table !== undefined) table = entry.table === null ? null : cleanRatingTable(entry.table, `${label}.table`);
    if (entry.checkedIn !== undefined && typeof entry.checkedIn !== 'boolean') bad(`${label}.checkedIn must be true or false`);
    if (teeId === undefined && table === undefined && entry.checkedIn === undefined) {
      bad(`${label} needs a teeId, a table or checkedIn`);
    }
    return { playerId: playerId as string, teeId, table, checkedIn: entry.checkedIn as boolean | undefined };
  });
}

// Does this tee offer ratings for the table? A tee with no ratings at all is fine (ratings are optional), but a tee
// that has ratings only for one table cannot be played by the other.
function teeAllowsTable(course: Course, teeId: string, table: RatingTable): string | null {
  const tee = course.tees.find((candidate) => candidate.id === teeId);
  if (!tee) return "that tee is not one of this round's tees";
  if (tee.men === null && tee.women === null) return null;
  if (tee[table] === null) return `${tee.name} has no ${table === 'men' ? "men's" : "women's"} rating`;
  return null;
}

// Set tee picks and check-in. A player may change only their own entry; an organizer or co-admin may change anyone's,
// up to MAX_ROUND_PLAYER_EDITS at once. Only the fields given change. Checking in needs a tee and a table whenever the
// round's course has tee sets (the round's default tee fills in a missing tee, never the table, which must be a
// visible choice). A player cannot change their own tee or table once they have a score in the round; an organizer
// still can, and on a live round that is announced to everyone.
export async function setRoundPlayers(
  db: Firestore,
  uid: string,
  input: SetRoundPlayersInput,
  usage: UsageTracker,
): Promise<{ players: RoundPlayerView[] }> {
  const tournamentId = requireTournamentId(input.tournamentId);
  const roundId = requireId('roundId', input.roundId);
  const edits = cleanEdits(input.players, uid);

  usage.forTournament(tournamentId);
  const tournamentRef = db.collection('tournaments').doc(tournamentId);
  const roundRef = tournamentRef.collection('rounds').doc(roundId);
  const picksRef = roundRef.collection('roundPlayers');

  return db.runTransaction(async (tx) => {
    const tournament = await readActiveTournament(tx, tournamentRef, usage);
    const admin = isAdminOf(tournament, uid);
    if (!admin && edits.some((edit) => edit.playerId !== uid)) {
      throw new HttpsError('permission-denied', "Only this tournament's organizer or co-admin can change another player's tee or check-in");
    }

    const roundSnap = await tx.get(roundRef);
    usage.read();
    const round = roundSnap.data();
    if (!round) throw new HttpsError('not-found', 'Round not found in this tournament');
    // Check-in is a record for the organizer, never a gate: players change theirs while the round is scheduled or live,
    // but an organizer can still fill it in afterwards (a player who hands in a card and leaves the rest to them) on
    // any round that has not been cancelled.
    const open = round.status === ROUND_STATUS.SCHEDULED || round.status === ROUND_STATUS.LIVE;
    if (!open && !(admin && round.status !== ROUND_STATUS.CANCELLED)) {
      throw new HttpsError(
        'failed-precondition',
        admin
          ? `This round is ${round.status}; tees and check-in can no longer be changed`
          : `This round is ${round.status}; only the organizer can change tees and check-in now`,
      );
    }
    const course = (round.course as Course | null) ?? null;
    const tees = Array.isArray(course?.tees) ? course!.tees : [];

    // Everyone named must be on the roster and still playing.
    const rosterEntries = await tx.getAll(...edits.map((edit) => tournamentRef.collection('players').doc(edit.playerId)));
    usage.read(rosterEntries.length);
    for (const entry of rosterEntries) {
      if (!entry.exists) {
        throw new HttpsError('failed-precondition', entry.id === uid ? 'You are not on this tournament\'s roster' : "A player is not on this tournament's roster");
      }
      if (entry.data()?.withdrawn === true) {
        throw new HttpsError('failed-precondition', entry.id === uid ? 'You have been removed from this tournament' : 'A player has been removed from this tournament');
      }
    }

    const existingSnaps = await tx.getAll(...edits.map((edit) => picksRef.doc(edit.playerId)));
    usage.read(existingSnaps.length);

    const next = edits.map((edit, i) => {
      const old = existingSnaps[i].data();
      const before = {
        teeId: (old?.teeId as string | null | undefined) ?? null,
        table: (old?.table as RatingTable | null | undefined) ?? null,
        checkedIn: old?.checkedIn === true,
      };
      const state = {
        teeId: edit.teeId === undefined ? before.teeId : edit.teeId,
        table: edit.table === undefined ? before.table : edit.table,
        checkedIn: edit.checkedIn === undefined ? before.checkedIn : edit.checkedIn,
      };
      if (state.teeId !== null) {
        if (tees.length === 0) bad("this round's course has no tee sets yet; add them on the course first");
        if (!tees.some((tee) => tee.id === state.teeId)) bad("that tee is not one of this round's tees");
      }
      if (state.teeId !== null && state.table !== null) {
        const problem = teeAllowsTable(course!, state.teeId, state.table);
        if (problem) bad(problem);
      }
      if (state.checkedIn && tees.length > 0) {
        // Checking in fills a missing tee from the round's default, but never the table: that is a visible choice.
        if (state.teeId === null) state.teeId = (round.defaultTeeId as string | null | undefined) ?? tees[0].id;
        if (state.table === null) bad("Choose men's or women's tees to check in, so the right rating applies");
        const problem = teeAllowsTable(course!, state.teeId, state.table);
        if (problem) bad(problem);
      }
      const teeChanged = state.teeId !== before.teeId || state.table !== before.table;
      const checkInChanged = state.checkedIn !== before.checkedIn;
      return { edit, old, before, state, changed: teeChanged || checkInChanged, teeChanged, checkInChanged };
    });

    // A player's own tee and table are fixed once they have a score in this round (the yardage and rating behind
    // that score must not change under it); the organizer can still correct it.
    if (!admin && next.some((item) => item.teeChanged)) {
      const scored = await tx.get(roundRef.collection('scores').where('playerId', '==', uid).limit(1));
      usage.read(scored.size);
      if (!scored.empty) {
        throw new HttpsError(
          'failed-precondition',
          'You already have a score in this round, so only the organizer can change your tee',
        );
      }
    }

    const changed = next.filter((item) => item.changed);
    for (const item of changed) {
      const { edit, state, old } = item;
      const data = {
        playerId: edit.playerId,
        teeId: state.teeId,
        table: state.table,
        checkedIn: state.checkedIn,
        checkedInAt: state.checkedIn ? (item.checkInChanged ? FieldValue.serverTimestamp() : (old?.checkedInAt ?? FieldValue.serverTimestamp())) : null,
        // Who completed the check-in: the player themselves, or the organizer on their behalf (shown differently to
        // admins; it changes no rules). Kept while the check-in stands, cleared when it is undone.
        checkedInBy: state.checkedIn ? (item.checkInChanged ? uid : ((old?.checkedInBy as string | undefined) ?? uid)) : null,
        setBy: uid,
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (old) tx.update(picksRef.doc(edit.playerId), data);
      else tx.create(picksRef.doc(edit.playerId), { ...data, createdAt: FieldValue.serverTimestamp() });
    }
    usage.wrote(changed.length);

    // The organizer doing this for others leaves a (quiet) record; players doing it for themselves do not, like
    // choosing their own team. A tee changed on a live round is something everyone playing it should see.
    const forOthers = changed.filter((item) => item.edit.playerId !== uid);
    if (forOthers.length > 0) {
      const teesChanged = forOthers.filter((item) => item.teeChanged).length;
      logActivity(tx, tournamentRef, usage, {
        type: 'round_players_changed',
        actorId: uid,
        targetPlayerId: forOthers.length === 1 ? forOthers[0].edit.playerId : null,
        level: teesChanged > 0 && round.status !== ROUND_STATUS.SCHEDULED ? 'all' : 'admins',
        data: {
          roundId,
          number: round.number,
          players: forOthers.length,
          teesChanged,
          checkInsChanged: forOthers.filter((item) => item.checkInChanged).length,
          playerIds: forOthers.slice(0, 20).map((item) => item.edit.playerId),
        },
      });
    }

    return {
      players: next.map(
        (item): RoundPlayerView => ({
          playerId: item.edit.playerId,
          teeId: item.state.teeId,
          table: item.state.table,
          checkedIn: item.state.checkedIn,
        }),
      ),
    };
  });
}

export const setRoundPlayersCallable = callable<SetRoundPlayersInput, { players: RoundPlayerView[] }>(
  'setRoundPlayers',
  async (request, usage, uid) => setRoundPlayers(getDb(), uid, request.data ?? {}, usage),
);
