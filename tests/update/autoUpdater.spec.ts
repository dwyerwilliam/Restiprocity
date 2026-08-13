import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createWindowsAutoUpdaterService } from '../../src/main/update/autoUpdater';

class FakeUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = true;
  disableWebInstaller = false;
  quitCalls: Array<{ isSilent: boolean; isForceRunAfter: boolean }> = [];
  checkForUpdatesCalls = 0;
  private checkResult: unknown;

  setCheckResult(result: unknown): void {
    this.checkResult = result;
  }

  async checkForUpdates(): Promise<never> {
    this.checkForUpdatesCalls += 1;
    if (this.checkResult instanceof Error) throw this.checkResult;
    return this.checkResult as never;
  }

  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void {
    this.quitCalls.push({ isSilent, isForceRunAfter });
  }
}

const app = (isPackaged: boolean) => ({ isPackaged, getVersion: () => '0.2.2' });
const info = (version: string) => ({ version, files: [] });

describe('WindowsAutoUpdaterService', () => {
  it('covers no-update, available, automatic download, and manual install transitions', async () => {
    const updater = new FakeUpdater();
    const service = createWindowsAutoUpdaterService({ app: app(true), platform: 'win32', updater, autoCheckOnStart: false });
    const states: string[] = [];
    service.on('state', (state) => states.push(state.kind));

    await service.start();
    expect([updater.autoDownload, updater.autoInstallOnAppQuit, updater.disableWebInstaller]).toEqual([true, false, true]);

    updater.setCheckResult({ isUpdateAvailable: false, updateInfo: info('0.2.2'), versionInfo: info('0.2.2') });
    await service.checkForUpdates();
    expect(service.getState()).toMatchObject({ kind: 'no-update', latestVersion: '0.2.2' });

    updater.setCheckResult({ isUpdateAvailable: true, updateInfo: info('0.2.3'), versionInfo: info('0.2.3') });
    await service.checkForUpdates();
    expect(service.getState()).toMatchObject({ kind: 'available', latestVersion: '0.2.3' });
    updater.emit('download-progress', { bytesPerSecond: 1, percent: 40, total: 100, transferred: 40 });
    expect(service.getState()).toMatchObject({ kind: 'downloading', progress: { percent: 40 } });
    updater.emit('update-downloaded', { version: '0.2.3', files: [], downloadedFile: 'Restiprocity-Setup-0.2.3.exe' });
    expect(service.getState()).toMatchObject({ kind: 'downloaded', downloadedFile: 'Restiprocity-Setup-0.2.3.exe' });

    service.applyDownloadedUpdate();
    expect(service.getState().kind).toBe('installing');
    expect(updater.quitCalls).toEqual([{ isSilent: false, isForceRunAfter: false }]);
    expect(states).toEqual(expect.arrayContaining(['idle', 'no-update', 'available', 'downloading', 'downloaded', 'installing']));
  });

  it('reports check and download errors without installing automatically', async () => {
    const updater = new FakeUpdater();
    const service = createWindowsAutoUpdaterService({ app: app(true), platform: 'win32', updater, autoCheckOnStart: false });
    await service.start();
    updater.setCheckResult(new Error('network unavailable'));
    await service.checkForUpdates();
    expect(service.getState()).toMatchObject({ kind: 'error', stage: 'check', message: 'network unavailable', retryable: true });
    updater.emit('download-progress', { bytesPerSecond: 1, percent: 1, total: 100, transferred: 1 });
    updater.emit('error', new Error('download failed'));
    expect(service.getState()).toMatchObject({ kind: 'error', stage: 'download', message: 'download failed' });
    expect(updater.quitCalls).toHaveLength(0);
  });

  it('classifies an error after update availability as a download error before progress', async () => {
    const updater = new FakeUpdater();
    const service = createWindowsAutoUpdaterService({ app: app(true), platform: 'win32', updater, autoCheckOnStart: false });
    await service.start();

    updater.setCheckResult({ isUpdateAvailable: true, updateInfo: info('0.2.3'), versionInfo: info('0.2.3') });
    await service.checkForUpdates();
    expect(service.getState()).toMatchObject({ kind: 'available', latestVersion: '0.2.3' });

    updater.emit('error', new Error('installer asset unavailable'));
    expect(service.getState()).toMatchObject({ kind: 'error', stage: 'download', message: 'installer asset unavailable' });
  });

  it('reports a rejected automatic download promise as a download error', async () => {
    const updater = new FakeUpdater();
    const service = createWindowsAutoUpdaterService({ app: app(true), platform: 'win32', updater, autoCheckOnStart: false });
    await service.start();

    const downloadPromise = Promise.reject(new Error('automatic download failed'));
    updater.setCheckResult({
      isUpdateAvailable: true,
      updateInfo: info('0.2.3'),
      versionInfo: info('0.2.3'),
      downloadPromise,
    });
    await service.checkForUpdates();

    expect(service.getState()).toMatchObject({ kind: 'error', stage: 'download', message: 'automatic download failed' });
  });

  it('handles a rejected automatic download promise without duplicating the updater error state', async () => {
    const updater = new FakeUpdater();
    const service = createWindowsAutoUpdaterService({ app: app(true), platform: 'win32', updater, autoCheckOnStart: false });
    const errorStates: string[] = [];
    service.on('state', (state) => {
      if (state.kind === 'error') errorStates.push(state.message);
    });
    await service.start();

    let rejectDownload!: (reason: Error) => void;
    const downloadPromise = new Promise<string[]>((_resolve, reject) => {
      rejectDownload = reject;
    });
    updater.setCheckResult({
      isUpdateAvailable: true,
      updateInfo: info('0.2.3'),
      versionInfo: info('0.2.3'),
      downloadPromise,
    });
    await service.checkForUpdates();

    const error = new Error('automatic download failed');
    updater.emit('error', error);
    rejectDownload(error);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(service.getState()).toMatchObject({ kind: 'error', stage: 'download', message: 'automatic download failed' });
    expect(errorStates).toEqual(['automatic download failed']);
  });

  it.each([
    ['unpackaged Windows', false, 'win32'],
    ['packaged non-Windows', true, 'linux'],
  ])('is unsupported for %s', async (_label, isPackaged, platform) => {
    const updater = new FakeUpdater();
    const service = createWindowsAutoUpdaterService({ app: app(isPackaged), platform: platform as NodeJS.Platform, updater, autoCheckOnStart: true });
    await service.start();
    expect(service.getState().kind).toBe('unsupported');
    expect(updater.checkForUpdatesCalls).toBe(0);
    expect(updater.quitCalls).toHaveLength(0);
  });
});
