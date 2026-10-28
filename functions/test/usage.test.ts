import { describe, expect, it } from 'vitest';
import { HttpsError } from 'firebase-functions/v2/https';

import { runWithUsage, UsageLogger } from '../src/usage';

function fakeLogger() {
  const calls: { level: 'info' | 'warn' | 'error'; message: string; data: Record<string, unknown> }[] = [];
  const log: UsageLogger = {
    info: (message, data) => calls.push({ level: 'info', message, data }),
    warn: (message, data) => calls.push({ level: 'warn', message, data }),
    error: (message, data) => calls.push({ level: 'error', message, data }),
  };
  return { log, calls };
}

// Deterministic clock: each call advances 25ms.
function clock() {
  let t = 1000;
  return () => {
    t += 25;
    return t;
  };
}

describe('runWithUsage', () => {
  it('logs exactly one structured usage line on success, with counts and tournament', async () => {
    const { log, calls } = fakeLogger();

    const result = await runWithUsage(
      'createTournament',
      'user-1',
      async (usage) => {
        usage.forTournament('t-123');
        usage.read(2);
        usage.wrote(3);
        return 'done';
      },
      log,
      clock(),
    );

    expect(result).toBe('done');
    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe('info');
    expect(calls[0].data).toMatchObject({
      event: 'usage',
      operation: 'createTournament',
      uid: 'user-1',
      tournamentId: 't-123',
      docsRead: 2,
      docsWritten: 3,
      outcome: 'ok',
    });
    expect(calls[0].data.durationMs).toBeGreaterThan(0);
    expect(calls[0].data).not.toHaveProperty('errorCode');
  });

  it('logs null for tournamentId and uid when none apply', async () => {
    const { log, calls } = fakeLogger();
    await runWithUsage('upsertPlayerProfile', undefined, async () => 1, log, clock());
    expect(calls[0].data).toMatchObject({
      uid: null,
      tournamentId: null,
      docsRead: 0,
      docsWritten: 0,
      teamCount: null,
      rosterSize: null,
    });
  });

  it('logs the tournament size when the handler measured it, even on a refused call', async () => {
    const { log, calls } = fakeLogger();
    await runWithUsage('createTeams', 'user-5', async (usage) => {
      usage.forTournament('t-7');
      usage.teams(40);
      usage.roster(160);
      return 1;
    }, log, clock());
    expect(calls[0].data).toMatchObject({ teamCount: 40, rosterSize: 160 });

    await expect(
      runWithUsage('createTeams', 'user-5', async (usage) => {
        usage.teams(100);
        throw new HttpsError('resource-exhausted', 'full');
      }, log, clock()),
    ).rejects.toThrow();
    expect(calls[1].data).toMatchObject({ outcome: 'error', errorCode: 'resource-exhausted', teamCount: 100 });
  });

  it('logs caller mistakes as warnings and rethrows them', async () => {
    const { log, calls } = fakeLogger();
    const denied = new HttpsError('permission-denied', 'not an admin');

    await expect(
      runWithUsage('updateTournament', 'user-2', async () => { throw denied; }, log, clock()),
    ).rejects.toBe(denied);

    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe('warn');
    expect(calls[0].data).toMatchObject({ outcome: 'error', errorCode: 'permission-denied' });
  });

  it('logs unexpected failures as errors and rethrows them', async () => {
    const { log, calls } = fakeLogger();
    const boom = new Error('firestore exploded');

    await expect(
      runWithUsage('joinTournament', 'user-3', async () => { throw boom; }, log, clock()),
    ).rejects.toBe(boom);

    expect(calls).toHaveLength(1);
    expect(calls[0].level).toBe('error');
    expect(calls[0].data).toMatchObject({ outcome: 'error', errorCode: 'internal' });
  });

  it('keeps counts accumulated before a failure', async () => {
    const { log, calls } = fakeLogger();
    await expect(
      runWithUsage('createTeams', 'user-4', async (usage) => {
        usage.forTournament('t-9');
        usage.read();
        throw new HttpsError('not-found', 'no such tournament');
      }, log, clock()),
    ).rejects.toThrow();
    expect(calls[0].data).toMatchObject({ tournamentId: 't-9', docsRead: 1, docsWritten: 0 });
  });
});
