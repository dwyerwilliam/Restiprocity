import { EventEmitter } from 'events';
import type {
  AppUpdater,
  ProgressInfo,
  UpdateCheckResult,
  UpdateDownloadedEvent,
  UpdateInfo,
} from 'electron-updater';

export type WindowsAutoUpdaterState =
  | { kind: 'unsupported'; currentVersion: string }
  | { kind: 'idle'; currentVersion: string }
  | { kind: 'checking'; currentVersion: string }
  | { kind: 'no-update'; currentVersion: string; latestVersion: string }
  | { kind: 'available'; currentVersion: string; latestVersion: string }
  | { kind: 'downloading'; currentVersion: string; latestVersion: string; progress: ProgressInfo }
  | { kind: 'downloaded'; currentVersion: string; latestVersion: string; downloadedFile: string }
  | { kind: 'installing'; currentVersion: string; latestVersion: string }
  | { kind: 'error'; currentVersion: string; stage: 'check' | 'download' | 'install'; message: string; retryable: boolean };

export type WindowsAutoUpdaterApp = {
  isPackaged: boolean;
  getVersion(): string;
};

export type WindowsAutoUpdaterLike = Pick<
  AppUpdater,
  'autoDownload' | 'autoInstallOnAppQuit' | 'disableWebInstaller' | 'checkForUpdates' | 'quitAndInstall' | 'on' | 'removeListener'
>;

export type WindowsAutoUpdaterDependencies = {
  app: WindowsAutoUpdaterApp;
  platform: NodeJS.Platform;
  updater?: WindowsAutoUpdaterLike;
  autoCheckOnStart?: boolean;
};

type UpdaterEventName = 'checking-for-update' | 'update-available' | 'update-not-available' | 'download-progress' | 'update-downloaded' | 'error';

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getRetryable(error: unknown): boolean {
  if (error && typeof error === 'object' && 'retryable' in error && typeof (error as { retryable?: unknown }).retryable === 'boolean') {
    return (error as { retryable: boolean }).retryable;
  }
  return true;
}

export class WindowsAutoUpdaterService extends EventEmitter {
  private started = false;
  private currentCheck: Promise<WindowsAutoUpdaterState> | null = null;
  private updateInfo: UpdateInfo | null = null;
  private readonly updaterListeners: Array<[UpdaterEventName, (...args: any[]) => void]> = [];
  private state: WindowsAutoUpdaterState;
  private readonly deps: WindowsAutoUpdaterDependencies;

  constructor(deps: WindowsAutoUpdaterDependencies) {
    super();
    this.deps = deps;
    this.state = { kind: 'unsupported', currentVersion: deps.app.getVersion() };
  }

  getState(): WindowsAutoUpdaterState {
    return this.state;
  }

  async start(): Promise<WindowsAutoUpdaterState> {
    if (this.started) return this.state;
    this.started = true;

    if (!this.isSupported()) {
      this.setState({ kind: 'unsupported', currentVersion: this.deps.app.getVersion() });
      return this.state;
    }

    this.configureUpdater();
    this.bindUpdaterEvents();
    this.setState({ kind: 'idle', currentVersion: this.deps.app.getVersion() });

    if (this.deps.autoCheckOnStart !== false) {
      void this.checkForUpdates();
    }

    return this.state;
  }

  async checkForUpdates(): Promise<WindowsAutoUpdaterState> {
    if (!this.isSupported()) return this.state;
    if (this.currentCheck) return this.currentCheck;

    this.updateInfo = null;
    this.setState({ kind: 'checking', currentVersion: this.deps.app.getVersion() });

    this.currentCheck = this.deps.updater!.checkForUpdates()
      .then((result) => {
        if (result === null) {
          this.setState({ kind: 'no-update', currentVersion: this.deps.app.getVersion(), latestVersion: this.deps.app.getVersion() });
          return this.state;
        }

        this.observeDownload(result);
        this.applyCheckResult(result);
        return this.state;
      })
      .catch((error: unknown) => {
        this.setError('check', error);
        return this.state;
      })
      .finally(() => {
        this.currentCheck = null;
      });

    return this.currentCheck;
  }

  applyDownloadedUpdate(): void {
    if (!this.isSupported()) return;
    if (this.state.kind !== 'downloaded') {
      throw new Error('No downloaded update is ready to install.');
    }

    this.setState({
      kind: 'installing',
      currentVersion: this.deps.app.getVersion(),
      latestVersion: this.state.latestVersion,
    });

    try {
      this.deps.updater!.quitAndInstall(false, false);
    } catch (error: unknown) {
      this.setError('install', error);
      throw error;
    }
  }

  dispose(): void {
    if (!this.deps.updater) return;
    for (const [eventName, handler] of this.updaterListeners) {
      this.deps.updater.removeListener(eventName, handler);
    }
    this.updaterListeners.length = 0;
  }

  private isSupported(): boolean {
    return this.deps.platform === 'win32' && this.deps.app.isPackaged;
  }

  private configureUpdater(): void {
    if (!this.deps.updater) {
      throw new Error('Windows updater service requires an injected updater instance.');
    }

    this.deps.updater.autoDownload = true;
    this.deps.updater.autoInstallOnAppQuit = false;
    this.deps.updater.disableWebInstaller = true;
  }

  private bindUpdaterEvents(): void {
    if (!this.deps.updater) return;

    this.onUpdaterEvent('checking-for-update', () => {
      this.setState({ kind: 'checking', currentVersion: this.deps.app.getVersion() });
    });

    this.onUpdaterEvent('update-available', (info: UpdateInfo) => {
      this.updateInfo = info;
      this.setState({
        kind: 'available',
        currentVersion: this.deps.app.getVersion(),
        latestVersion: info.version,
      });
    });

    this.onUpdaterEvent('update-not-available', (info: UpdateInfo) => {
      this.updateInfo = info;
      this.setState({
        kind: 'no-update',
        currentVersion: this.deps.app.getVersion(),
        latestVersion: info.version,
      });
    });

    this.onUpdaterEvent('download-progress', (progress: ProgressInfo) => {
      const latestVersion = this.updateInfo?.version ?? this.deps.app.getVersion();
      this.setState({
        kind: 'downloading',
        currentVersion: this.deps.app.getVersion(),
        latestVersion,
        progress,
      });
    });

    this.onUpdaterEvent('update-downloaded', (info: UpdateDownloadedEvent) => {
      this.updateInfo = info;
      this.setState({
        kind: 'downloaded',
        currentVersion: this.deps.app.getVersion(),
        latestVersion: info.version,
        downloadedFile: info.downloadedFile,
      });
    });

    this.onUpdaterEvent('error', (error: Error) => {
      const stage = this.state.kind === 'downloading'
        || this.state.kind === 'available'
        ? 'download'
        : this.state.kind === 'installing'
          ? 'install'
          : 'check';
      this.setError(stage, error);
    });
  }

  private onUpdaterEvent(eventName: UpdaterEventName, handler: (...args: any[]) => void): void {
    this.deps.updater?.on(eventName, handler);
    this.updaterListeners.push([eventName, handler]);
  }

  private observeDownload(result: UpdateCheckResult): void {
    if (!result.downloadPromise) return;

    void result.downloadPromise.catch((error: unknown) => {
      if (this.state.kind === 'error' && this.state.stage === 'download') return;
      this.setError('download', error);
    });
  }

  private applyCheckResult(result: UpdateCheckResult): void {
    const latestVersion = result.updateInfo.version;
    if (result.isUpdateAvailable) {
      this.updateInfo = result.updateInfo;
      this.setState({
        kind: 'available',
        currentVersion: this.deps.app.getVersion(),
        latestVersion,
      });
      return;
    }

    this.setState({
      kind: 'no-update',
      currentVersion: this.deps.app.getVersion(),
      latestVersion,
    });
  }

  private setError(stage: 'check' | 'download' | 'install', error: unknown): void {
    this.setState({
      kind: 'error',
      currentVersion: this.deps.app.getVersion(),
      stage,
      message: getErrorMessage(error),
      retryable: getRetryable(error),
    });
  }

  private setState(state: WindowsAutoUpdaterState): void {
    this.state = state;
    this.emit('state', state);
  }
}

export function createWindowsAutoUpdaterService(deps: Omit<WindowsAutoUpdaterDependencies, 'updater'> & { updater?: WindowsAutoUpdaterLike }): WindowsAutoUpdaterService {
  return new WindowsAutoUpdaterService(deps);
}
