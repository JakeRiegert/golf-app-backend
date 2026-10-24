import './config';

// Cloud Functions are exported here as they are ported from the AWS Lambdas (plan Phase 4).
// Still to port: createTournament, joinTournament, createTeams, updateTeam,
// assignTournamentPlayer, updateTournament, assignCoAdmin.
export { upsertPlayerProfile } from './players';
