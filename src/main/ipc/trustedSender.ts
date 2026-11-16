import path from 'path';
import { fileURLToPath } from 'url';

export type AppPageCheck = (url: string) => boolean;

/** The parts of an IPC event the sender check reads. */
export type IpcSenderEvent = {
  senderFrame: { url: string; parent: unknown } | null;
};

/**
 * Builds the test for "this URL is the app's own page": the built `index.html`, or any page of the dev
 * server while developing. File URLs are compared as paths, so encoding differences cannot cause a mismatch.
 */
export function createAppPageCheck(options: {
  indexPath: string;
  devServerUrl?: string;
  platform?: NodeJS.Platform;
}): AppPageCheck {
  const platform = options.platform ?? process.platform;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const comparable = (value: string) => {
    const normalized = paths.normalize(value);
    return platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  const indexPath = comparable(options.indexPath);
  let devOrigin: string | null = null;
  if (options.devServerUrl) {
    try { devOrigin = new URL(options.devServerUrl).origin; } catch { devOrigin = null; }
  }

  return (url) => {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return false; }
    if (devOrigin !== null) return parsed.origin === devOrigin;
    if (parsed.protocol !== 'file:') return false;
    try {
      return comparable(fileURLToPath(parsed, { windows: platform === 'win32' })) === indexPath;
    } catch {
      return false;
    }
  };
}

/** True when the call came from the top frame of a window that is showing the app's own page. */
export function isAppPageSender(event: IpcSenderEvent, isAppPage: AppPageCheck): boolean {
  const frame = event.senderFrame;
  // The frame is null once it has navigated away or been destroyed; there is nobody left to answer.
  return frame !== null && frame.parent === null && isAppPage(frame.url);
}

/** Every IPC handler calls this first: the main process answers the app's own page and nothing else. */
export function assertAppPageSender(event: IpcSenderEvent, isAppPage: AppPageCheck): void {
  if (!isAppPageSender(event, isAppPage)) throw new Error('This call must come from the application page.');
}
