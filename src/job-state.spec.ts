import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AxiosError } from 'axios';
import { ReportOutbox } from './job-state';

jest.mock('./logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const refused = (status: number) =>
  Object.assign(new Error('refused'), {
    cause: new AxiosError('x', 'ERR', undefined, undefined, { status, statusText: '', headers: {}, config: {} as any, data: {} }),
  });

describe('ReportOutbox — final reports survive an internet outage', () => {
  let file: string;
  let http: { reportStatus: jest.Mock };

  beforeEach(() => {
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-')), 'outbox.json');
    http = { reportStatus: jest.fn() };
  });

  it('keeps a report on disk and delivers it once the backend answers', async () => {
    const outbox = new ReportOutbox(file, http as any);
    outbox.add({ jobId: 'job-1', status: 'PRINTED', attemptId: 'job-1:1' });
    expect(fs.existsSync(file)).toBe(true);

    http.reportStatus.mockRejectedValueOnce(new Error('ENOTFOUND'));
    await outbox.flush();
    expect(fs.existsSync(file)).toBe(true);

    // A new process (e.g. after a restart) still has it.
    http.reportStatus.mockResolvedValue(undefined);
    await new ReportOutbox(file, http as any).flush();
    expect(http.reportStatus).toHaveBeenLastCalledWith('job-1', 'PRINTED', 'job-1:1', undefined);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('drops a report the backend refuses (order gone), but keeps one it was too busy for', async () => {
    const outbox = new ReportOutbox(file, http as any);
    outbox.add({ jobId: 'gone', status: 'PRINTED', attemptId: 'gone:1' });
    outbox.add({ jobId: 'busy', status: 'PRINT_FAILED', attemptId: 'busy:1', failure: { message: 'jam' } });
    http.reportStatus.mockImplementation((jobId: string) => Promise.reject(refused(jobId === 'gone' ? 404 : 429)));

    await outbox.flush();

    const left = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(left.map((r: { jobId: string }) => r.jobId)).toEqual(['busy']);
  });

  it('keeps one report per attempt (the newest)', () => {
    const outbox = new ReportOutbox(file, http as any);
    outbox.add({ jobId: 'job-1', status: 'PRINT_UNKNOWN', attemptId: 'job-1:1' });
    outbox.add({ jobId: 'job-1', status: 'PRINTED', attemptId: 'job-1:1' });
    const left = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(left).toHaveLength(1);
    expect(left[0].status).toBe('PRINTED');
  });
});
