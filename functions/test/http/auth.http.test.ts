import { describe, expect, it } from 'vitest';

import { call } from './helpers';

// Contract: every callable refuses a caller with no sign-in token, and answers an unknown function
// name with something that is not a success. A function added to index.ts without the `callable`
// wrapper would fail here. Keep this list in step with functions/src/index.ts.
const CALLABLES = [
  'assignCoAdmin',
  'assignTournamentPlayer',
  'chooseTeam',
  'createTeams',
  'createTournament',
  'joinTournament',
  'setMyHandicap',
  'startTournament',
  'updateTeam',
  'updateTournament',
  'upsertPlayerProfile',
];

describe('every callable requires sign-in', { timeout: 60_000 }, () => {
  it.each(CALLABLES)('%s refuses an anonymous caller', async (name) => {
    const res = await call(null, name, {});
    expect(res.http).toBe(401);
    expect(res.error?.status).toBe('UNAUTHENTICATED');
    expect(res.result).toBeUndefined();
  });

  it('does not answer for a function that does not exist', async () => {
    const res = await call(null, 'deleteEverything', {});
    expect(res.http).toBeGreaterThanOrEqual(400);
    expect(res.result).toBeUndefined();
  });
});
