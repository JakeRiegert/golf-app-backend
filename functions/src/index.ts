import './config';

// Cloud Functions are exported here as they are ported from the AWS Lambdas (plan Phase 4).
// Still to port: joinTournament, createTeams, updateTeam, assignTournamentPlayer,
// updateTournament, assignCoAdmin.
export { upsertPlayerProfile } from './players';
export { createTournamentCallable as createTournament } from './tournaments';
