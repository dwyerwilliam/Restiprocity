import { session } from 'electron';
import type { Session } from 'electron';

export function getApiSession(
  insecure = false,
  fromPartition: typeof session.fromPartition = session.fromPartition,
): Session {
  const apiSession = fromPartition(insecure ? 'restiprocity-api-insecure' : 'restiprocity-api', { cache: false });
  if (insecure) apiSession.setCertificateVerifyProc((_request, callback) => callback(0));
  return apiSession;
}
