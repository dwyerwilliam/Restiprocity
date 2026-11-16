import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';

/** The Internet zone, as a browser records it for a download. */
const WINDOWS_ZONE_MARK = '[ZoneTransfer]\r\nZoneId=3\r\n';

/**
 * Marks a file written from a response as having come from the network, the way a browser marks a download, so
 * the operating system warns before running it:
 * - Windows: a `Zone.Identifier` stream on the file (Explorer, SmartScreen and Office read it).
 * - macOS: the quarantine attribute (Gatekeeper checks the file when it is opened).
 * - Linux: nothing; no mark is enforced there, and a saved file is not executable.
 *
 * The request URL is deliberately left out of the mark: it can carry credentials.
 * Best effort: a volume that cannot hold the mark (FAT, some network shares) still keeps the file. Returns
 * whether a mark was written.
 */
export async function markSavedFromNetwork(filePath: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  try {
    // Writing the Windows stream would create the file if it were missing; only ever mark one that is there.
    if (!(await fs.stat(filePath)).isFile()) return false;
    if (platform === 'win32') {
      await fs.writeFile(`${filePath}:Zone.Identifier`, WINDOWS_ZONE_MARK, 'utf-8');
      return true;
    }
    if (platform === 'darwin') {
      // flags;time;agent;event id. 0081 is what a browser download carries before the user has approved it.
      const value = `0081;${Math.floor(Date.now() / 1000).toString(16)};Restiprocity;`;
      await new Promise<void>((resolve, reject) => {
        execFile('/usr/bin/xattr', ['-w', 'com.apple.quarantine', value, filePath], { timeout: 5000 }, error => (error ? reject(error) : resolve()));
      });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
