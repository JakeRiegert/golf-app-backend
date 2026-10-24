import * as firebaseLogger from 'firebase-functions/logger';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';

// Every callable goes through here, so every call emits exactly one structured `usage` log
// line (Cloud Logging jsonPayload) with a fixed schema. Per-tournament cost analysis runs
// over these lines in Log Analytics / BigQuery -- IDs belong in logs, not metric labels.
// Log the uid, never email or other PII.
//
//   event, operation, uid, tournamentId, docsRead, docsWritten, durationMs, outcome,
//   errorCode (only on failure)

export class UsageTracker {
  tournamentId?: string;
  docsRead = 0;
  docsWritten = 0;

  forTournament(id: string): void {
    this.tournamentId = id;
  }
  read(count = 1): void {
    this.docsRead += count;
  }
  wrote(count = 1): void {
    this.docsWritten += count;
  }
}

export interface UsageLogger {
  info(message: string, data: Record<string, unknown>): void;
  warn(message: string, data: Record<string, unknown>): void;
  error(message: string, data: Record<string, unknown>): void;
}

// Failures the caller caused (bad input, not allowed, ...) are warnings; anything else is an
// error, which Error Reporting will group and which should page us rather than just be noted.
const CLIENT_ERROR_CODES = new Set([
  'invalid-argument',
  'unauthenticated',
  'permission-denied',
  'not-found',
  'already-exists',
  'failed-precondition',
  'out-of-range',
  'resource-exhausted',
]);

export async function runWithUsage<T>(
  operation: string,
  uid: string | undefined,
  handler: (usage: UsageTracker) => Promise<T>,
  log: UsageLogger = firebaseLogger,
  now: () => number = Date.now,
): Promise<T> {
  const usage = new UsageTracker();
  const started = now();
  const base = () => ({
    event: 'usage',
    operation,
    uid: uid ?? null,
    tournamentId: usage.tournamentId ?? null,
    docsRead: usage.docsRead,
    docsWritten: usage.docsWritten,
    durationMs: now() - started,
  });

  try {
    const result = await handler(usage);
    log.info('usage', { ...base(), outcome: 'ok' });
    return result;
  } catch (err) {
    const code = err instanceof HttpsError ? err.code : 'internal';
    const data = { ...base(), outcome: 'error', errorCode: code, errorMessage: String(err) };
    if (CLIENT_ERROR_CODES.has(code)) {
      log.warn('usage', data);
    } else {
      log.error('usage', data);
    }
    throw err;
  }
}

// Callable wrapper: requires sign-in, hands the handler the caller's uid and a UsageTracker.
export function callable<TData, TResult>(
  operation: string,
  handler: (request: CallableRequest<TData>, usage: UsageTracker, uid: string) => Promise<TResult>,
) {
  return onCall<TData, Promise<TResult>>((request) =>
    runWithUsage(operation, request.auth?.uid, async (usage) => {
      const uid = request.auth?.uid;
      if (!uid) {
        throw new HttpsError('unauthenticated', 'Sign in required');
      }
      return handler(request, usage, uid);
    }),
  );
}
