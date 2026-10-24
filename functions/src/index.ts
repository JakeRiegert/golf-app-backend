import './config';

// Cloud Functions are exported here as they are ported from the AWS Lambdas (plan Phase 4).
// Still to port: assignTournamentPlayer, updateTournament, assignCoAdmin.
export { upsertPlayerProfile } from './players';
export { joinTournamentCallable as joinTournament } from './roster';
export { createTeamsCallable as createTeams, updateTeamCallable as updateTeam } from './teams';
export { createTournamentCallable as createTournament } from './tournaments';
