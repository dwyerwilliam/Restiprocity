import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import type { Session } from 'electron';
import { parseNetLogConnectionTimings, type NetLogConnectionTimings } from './netLogTimings';

export interface ConnectionTimingCapture {
  /** Stops recording and returns the measured phases, or null when they can't be attributed. Idempotent. */
  finish(): Promise<NetLogConnectionTimings | null>;
}

/**
 * Records a NetLog on the request's session for the span of one send. The API sessions are
 * dedicated partitions, so the log only holds API traffic. `default` capture mode omits cookies
 * and credentials, and the file is deleted as soon as it has been parsed.
 */
export async function startNetLogCapture(
  requestSession: Pick<Session, 'netLog'>,
  getTempRoot: () => string,
): Promise<ConnectionTimingCapture | null> {
  const netLog = requestSession.netLog;
  // Someone else (e.g. --log-net-log) already owns the log; leave it alone.
  if (!netLog || netLog.currentlyLogging) return null;

  const filePath = path.join(getTempRoot(), `restiprocity-netlog-${randomUUID()}.json`);
  const removeFile = () => fs.rm(filePath, { force: true }).catch(() => {});
  try {
    await netLog.startLogging(filePath, { captureMode: 'default' });
  } catch {
    await removeFile();
    return null;
  }

  let finished: Promise<NetLogConnectionTimings | null> | undefined;
  return {
    finish: () => finished ??= (async () => {
      try {
        await netLog.stopLogging();
        return parseNetLogConnectionTimings(await fs.readFile(filePath, 'utf8'));
      } catch {
        return null;
      } finally {
        await removeFile();
      }
    })(),
  };
}
