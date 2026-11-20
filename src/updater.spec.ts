import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Updater } from './updater';

jest.mock('./logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('child_process', () => ({ spawn: jest.fn(() => ({ unref: jest.fn() })) }));

describe('Updater — the Printer App updates itself', () => {
  const newBinary = Buffer.from('new printer app');
  const info = { version: '1.0.0+bbb', sha256: createHash('sha256').update(newBinary).digest('hex'), size: newBinary.length };
  let dir: string;
  let execPath: string;
  let http: { checkForUpdate: jest.Mock; downloadUpdate: jest.Mock };
  let exit: jest.Mock;
  let beforeRestart: jest.Mock;
  let busy: boolean;

  const updater = (over: Record<string, unknown> = {}) =>
    new Updater({
      http: http as any,
      isBusy: () => busy,
      beforeRestart,
      execPath,
      packaged: true,
      version: '1.0.0+aaa',
      platform: 'linux',
      exit,
      versionOf: async () => info.version,
      ...over,
    });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'updater-'));
    execPath = path.join(dir, 'printsetu-agent');
    fs.writeFileSync(execPath, 'old printer app');
    busy = false;
    exit = jest.fn();
    beforeRestart = jest.fn();
    http = {
      checkForUpdate: jest.fn().mockResolvedValue(info),
      downloadUpdate: jest.fn(async (_os: string, dest: string) => fs.writeFileSync(dest, newBinary)),
    };
  });

  it('downloads, checks and swaps in a new version, then restarts', async () => {
    await expect(updater().check()).resolves.toBe('updated');
    expect(fs.readFileSync(execPath, 'utf8')).toBe('new printer app');
    expect(beforeRestart).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('keeps the old version when the download does not match its checksum', async () => {
    http.downloadUpdate.mockImplementation(async (_os: string, dest: string) => fs.writeFileSync(dest, Buffer.from('tampered!!!!!!!')));
    await expect(updater().check()).resolves.toBe('failed');
    expect(fs.readFileSync(execPath, 'utf8')).toBe('old printer app');
    expect(fs.existsSync(`${execPath}.new`)).toBe(false);
    expect(exit).not.toHaveBeenCalled();
  });

  it('refuses a download that is not really the offered version (no endless re-updating)', async () => {
    await expect(updater({ versionOf: async () => '1.0.0+aaa' }).check()).resolves.toBe('failed');
    expect(fs.readFileSync(execPath, 'utf8')).toBe('old printer app');
    expect(fs.existsSync(`${execPath}.new`)).toBe(false);
    expect(exit).not.toHaveBeenCalled();
  });

  it('refuses a download that does not start', async () => {
    const broken = updater({ versionOf: () => Promise.reject(new Error('does not start')) });
    await expect(broken.check()).resolves.toBe('failed');
    expect(fs.readFileSync(execPath, 'utf8')).toBe('old printer app');
  });

  it('never interrupts an order being printed', async () => {
    busy = true;
    await expect(updater().check()).resolves.toBe('busy');
    expect(http.checkForUpdate).not.toHaveBeenCalled();
  });

  it('does nothing when already on the offered version, or nothing is offered', async () => {
    await expect(updater({ version: '1.0.0+bbb' }).check()).resolves.toBe('current');
    http.checkForUpdate.mockResolvedValue(null);
    await expect(updater().check()).resolves.toBe('none');
    expect(http.downloadUpdate).not.toHaveBeenCalled();
  });

  it('is off for builds run from source or without a version', async () => {
    await expect(updater({ packaged: false }).check()).resolves.toBe('disabled');
    await expect(updater({ version: 'dev' }).check()).resolves.toBe('disabled');
  });

  it('on Windows moves the running .exe aside rather than overwriting it, and restarts the task', async () => {
    const { spawn } = jest.requireMock('child_process');
    await expect(updater({ platform: 'win32' }).check()).resolves.toBe('updated');
    expect(fs.readFileSync(execPath, 'utf8')).toBe('new printer app');
    expect(fs.readFileSync(`${execPath}.old`, 'utf8')).toBe('old printer app');
    expect(spawn).toHaveBeenCalledWith('cmd.exe', expect.arrayContaining([expect.stringContaining('schtasks /Run /TN PrintSetuAgent')]), expect.anything());
  });
});
