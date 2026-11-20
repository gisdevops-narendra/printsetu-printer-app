import { execFile, spawn } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { BackendHttpClient, AgentUpdateInfo } from './http-client';
import { logger } from './logger';
import { AGENT_VERSION } from './version';

const FIRST_CHECK_MS = 2 * 60_000;
const CHECK_EVERY_MS = 30 * 60_000;
const TASK_NAME = 'PrintSetuAgent';

export interface UpdaterDeps {
  http: Pick<BackendHttpClient, 'checkForUpdate' | 'downloadUpdate'>;
  /** True while an order is printing: the update waits, never interrupting one. */
  isBusy: () => boolean;
  /** Called right before the process exits to restart as the new version. */
  beforeRestart: () => void;
  platform?: NodeJS.Platform;
  execPath?: string;
  packaged?: boolean;
  version?: string;
  exit?: (code: number) => void;
  /** Runs `<file> --version` (replaced in tests). */
  versionOf?: (file: string) => Promise<string>;
}

/**
 * Keeps the Printer App up to date by itself, so a fix reaches every shop
 * without anyone reinstalling. Every half hour it asks the backend which
 * version to run; when that differs it downloads it next to itself, checks
 * its SHA-256 and size, swaps the files and restarts — only while no order is
 * printing. Windows: the running .exe is renamed aside (allowed while it runs)
 * and the scheduled task is started again. Linux: the new file replaces the
 * old one and systemd (Restart=always) starts it again.
 *
 * Only packaged builds with a real version update themselves; running from
 * source ("dev") never does.
 */
export class Updater {
  private timer: NodeJS.Timeout | null = null;
  private checking = false;
  private readonly platform: NodeJS.Platform;
  private readonly execPath: string;
  private readonly packaged: boolean;
  private readonly version: string;
  private readonly exit: (code: number) => void;

  constructor(private readonly deps: UpdaterDeps) {
    this.platform = deps.platform ?? process.platform;
    this.execPath = deps.execPath ?? process.execPath;
    this.packaged = deps.packaged ?? !!(process as unknown as { pkg?: unknown }).pkg;
    this.version = deps.version ?? AGENT_VERSION;
    this.exit = deps.exit ?? ((code) => process.exit(code));
  }

  get enabled(): boolean {
    return this.packaged && this.version !== 'dev' && (this.platform === 'win32' || this.platform === 'linux');
  }

  start(): void {
    this.removeLeftovers();
    if (!this.enabled) {
      logger.info(`Automatic updates are off for this build (version ${this.version}).`);
      return;
    }
    setTimeout(() => void this.check(), FIRST_CHECK_MS);
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One check; returns what happened (for logs and tests). */
  async check(): Promise<'disabled' | 'busy' | 'current' | 'none' | 'updated' | 'failed'> {
    if (!this.enabled) return 'disabled';
    if (this.checking) return 'busy';
    if (this.deps.isBusy()) return 'busy';
    this.checking = true;
    const newPath = `${this.execPath}.new`;
    try {
      const update = await this.deps.http.checkForUpdate(this.platform === 'win32' ? 'windows' : 'linux');
      if (!update) return 'none';
      if (update.version === this.version) return 'current';
      logger.info(`Updating the Printer App from ${this.version} to ${update.version}...`);

      await this.deps.http.downloadUpdate(this.platform === 'win32' ? 'windows' : 'linux', newPath);
      await verify(newPath, update);
      if (this.platform !== 'win32') fs.chmodSync(newPath, 0o755);
      // It must start, and be the version offered — otherwise it would "update" again after every restart.
      const reported = await (this.deps.versionOf ?? versionOf)(newPath);
      if (reported !== update.version) {
        throw new Error(`the downloaded Printer App says it is version "${reported}", expected "${update.version}"`);
      }
      // An order may have arrived during the download: finish it first, try again next time.
      if (this.deps.isBusy()) {
        fs.rmSync(newPath, { force: true });
        return 'busy';
      }
      this.swap(newPath);
      logger.info(`Printer App ${update.version} installed; restarting.`);
      this.restart();
      return 'updated';
    } catch (error) {
      fs.rmSync(newPath, { force: true });
      logger.warn(`Automatic update failed (the current version keeps running): ${(error as Error).message}`);
      return 'failed';
    } finally {
      this.checking = false;
    }
  }

  private swap(newPath: string): void {
    if (this.platform === 'win32') {
      // A running .exe can't be overwritten, but it can be renamed.
      const oldPath = `${this.execPath}.old`;
      fs.rmSync(oldPath, { force: true });
      fs.renameSync(this.execPath, oldPath);
      try {
        fs.renameSync(newPath, this.execPath);
      } catch (error) {
        fs.renameSync(oldPath, this.execPath);
        throw error;
      }
    } else {
      fs.chmodSync(newPath, 0o755);
      fs.renameSync(newPath, this.execPath);
    }
  }

  private restart(): void {
    this.deps.beforeRestart();
    if (this.platform === 'win32') {
      // Start the scheduled task again a few seconds after this process has exited
      // (the task won't start a second copy while this one still runs).
      // If the task can't be started (app run by hand), start the .exe directly from its folder
      // (it reads agent.config.json from there).
      const command = `"timeout /t 5 /nobreak >nul & (schtasks /Run /TN ${TASK_NAME} >nul 2>&1 || start "" "${this.execPath}")"`;
      spawn('cmd.exe', ['/d', '/s', '/c', command], {
        cwd: path.dirname(this.execPath),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        windowsVerbatimArguments: true,
      }).unref();
      this.exit(0);
    } else {
      // systemd's Restart=always starts the new file.
      this.exit(0);
    }
  }

  /** Removes the previous version's file and any unfinished download. */
  private removeLeftovers(): void {
    for (const leftover of [`${this.execPath}.old`, `${this.execPath}.new`]) {
      try {
        fs.rmSync(leftover, { force: true });
      } catch {
        // Still locked right after an update on Windows: removed next start.
      }
    }
  }
}

async function verify(file: string, update: AgentUpdateInfo): Promise<void> {
  const size = (await fs.promises.stat(file)).size;
  if (size !== update.size) throw new Error(`the download is ${size} bytes, expected ${update.size}`);
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(file).on('data', (c) => hash.update(c)).on('end', resolve).on('error', reject);
  });
  const sha256 = hash.digest('hex');
  if (sha256 !== update.sha256.toLowerCase()) throw new Error(`the download's checksum does not match (${sha256})`);
}

/** What a Printer App binary says its version is (`--version` prints it and exits). */
function versionOf(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, ['--version'], { timeout: 60_000, windowsHide: true }, (error, stdout) => {
      if (error) return reject(new Error(`the downloaded Printer App does not start: ${error.message}`));
      resolve(String(stdout).trim().split(/\r?\n/).pop() ?? '');
    });
  });
}
