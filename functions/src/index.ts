import './config';

// Every callable from the original AWS design is ported (plan Phase 4).
export {
  assignTournamentPlayerCallable as assignTournamentPlayer,
  chooseTeamCallable as chooseTeam,
} from './assignment';
export { setMyHandicapCallable as setMyHandicap } from './handicap';
export { startTournamentCallable as startTournament } from './lifecycle';
export { upsertPlayerProfile } from './players';
export { joinTournamentCallable as joinTournament } from './roster';
export { createTeamsCallable as createTeams, updateTeamCallable as updateTeam } from './teams';
export {
  assignCoAdminCallable as assignCoAdmin,
  updateTournamentCallable as updateTournament,
} from './tournamentAdmin';
export { createTournamentCallable as createTournament } from './tournaments';
