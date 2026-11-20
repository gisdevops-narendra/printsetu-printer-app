import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentConfig } from './config';
import { AgentJobPayload } from './http-client';
import { JobProcessor } from './job-processor';
import { PrinterAdapter, SpoolJobStatus } from './printing/printer-adapter.interface';
import { decodeReply, encodeGetJobAttributes, IPP_NOT_FOUND } from './printing/cups-ipp';
import { interpretCupsJob, parseLpRequestId } from './printing/linux-printer-adapter';
import { interpretWindowsJob } from './printing/windows-printer-adapter';

jest.mock('./logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

describe('JobProcessor — PRINTED only once the print queue finishes the job', () => {
  const config: AgentConfig = {
    agentId: 'a',
    agentSecret: 's',
    backendWsUrl: 'ws://x',
    backendHttpUrl: 'http://x',
    pollIntervalMs: 1000,
    heartbeatIntervalMs: 1000,
    printDriver: 'mock',
    downloadDir: path.join(os.tmpdir(), 'printsetu-agent-spec'),
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'printsetu-agent-state-')),
  };
  const job: AgentJobPayload = {
    jobId: 'job-1',
    attemptId: 'job-1:0',
    printerName: 'HP',
    documents: [
      {
        documentId: 'doc-1',
        originalName: 'a.pdf',
        mimeType: 'application/pdf',
        options: { paperSize: 'A4', colorMode: 'BW', sideMode: 'SIMPLEX', copies: 1 },
        documentSignedUrl: 'https://signed/a.pdf',
      },
    ],
  };

  let http: { reportStatus: jest.Mock; downloadToFile: jest.Mock };
  let printer: { print: jest.Mock; listPrinters: jest.Mock; checkJob: jest.Mock; diagnose: jest.Mock };
  const statuses = () => http.reportStatus.mock.calls.map((c) => c[1]);
  const finalStatus = () => http.reportStatus.mock.calls.at(-1);
  const queue = (...states: Partial<SpoolJobStatus>[]) =>
    states.forEach((s) => printer.checkJob.mockResolvedValueOnce({ detail: 'test', ...s }));

  /** Runs the job with fake timers, fast-forwarding through the queue checks. */
  const run = async (advanceMs = 120_000) => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      const done = new JobProcessor(config, http as any, printer as unknown as PrinterAdapter).handle(job);
      await jest.advanceTimersByTimeAsync(advanceMs);
      await done;
    } finally {
      jest.useRealTimers();
    }
  };

  beforeEach(() => {
    http = { reportStatus: jest.fn().mockResolvedValue(undefined), downloadToFile: jest.fn().mockResolvedValue(10) };
    printer = {
      print: jest.fn().mockResolvedValue({ printerName: 'HP', jobId: '7' }),
      listPrinters: jest.fn().mockResolvedValue([{ name: 'HP', isDefault: true }]),
      checkJob: jest.fn(),
      diagnose: jest.fn().mockResolvedValue(undefined),
    };
  });

  it('keeps following the job through a short spell of failed queue checks', async () => {
    printer.checkJob
      .mockRejectedValueOnce(new Error('PowerShell busy'))
      .mockRejectedValueOnce(new Error('PowerShell busy'))
      .mockRejectedValueOnce(new Error('PowerShell busy'))
      .mockResolvedValueOnce({ state: 'printing', detail: 'test' })
      .mockResolvedValueOnce({ state: 'completed', detail: 'test' });
    await run();
    expect(finalStatus()).toEqual(['job-1', 'PRINTED', 'job-1:0']);
  });

  it('waits for the queue to finish the job before reporting PRINTED', async () => {
    queue({ state: 'waiting' }, { state: 'printing' }, { state: 'completed' });
    await run();
    expect(printer.checkJob).toHaveBeenCalledTimes(3);
    expect(finalStatus()).toEqual(['job-1', 'PRINTED', 'job-1:0']);
  });

  it('treats a job that simply left the queue as finished (Windows drops printed jobs)', async () => {
    queue({ state: 'printing' }, { state: 'gone' });
    await run();
    expect(finalStatus()).toEqual(['job-1', 'PRINTED', 'job-1:0']);
  });

  it('reports a job cancelled at the computer as failed, so its files are kept', async () => {
    queue({ state: 'printing' }, { state: 'cancelling' }, { state: 'gone' });
    await run();
    expect(finalStatus()).toEqual([
      'job-1',
      'PRINT_FAILED',
      'job-1:0',
      expect.objectContaining({ errorCode: 'CANCELLED_AT_PRINTER' }),
    ]);
  });

  it('keeps waiting through a pause (out of paper) and tells the backend it is still printing', async () => {
    printer.checkJob.mockResolvedValue({ state: 'paused', problem: 'out of paper', detail: 'test' });
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      const done = new JobProcessor(config, http as any, printer as unknown as PrinterAdapter).handle(job);
      await jest.advanceTimersByTimeAsync(10 * 60_000); // paused for 10 minutes
      expect(statuses()).not.toContain('PRINT_FAILED');
      expect(statuses().filter((s) => s === 'PRINTING').length).toBeGreaterThanOrEqual(20);

      printer.checkJob.mockResolvedValue({ state: 'completed', detail: 'test' }); // paper added
      await jest.advanceTimersByTimeAsync(5_000);
      await done;
    } finally {
      jest.useRealTimers();
    }
    expect(finalStatus()).toEqual(['job-1', 'PRINTED', 'job-1:0']);
  });

  it('reports PRINT_UNKNOWN, never PRINTED, when the queue cannot be asked for two minutes', async () => {
    printer.checkJob.mockRejectedValue(new Error('PowerShell failed'));
    await run(200_000);
    expect(statuses()).not.toContain('PRINTED');
    expect(finalStatus()).toEqual([
      'job-1',
      'PRINT_UNKNOWN',
      'job-1:0',
      expect.objectContaining({ errorCode: 'PRINT_NOT_CONFIRMED' }),
    ]);
  });

  it('reports PRINT_UNKNOWN when the submitted job could not be identified', async () => {
    printer.print.mockResolvedValue({ printerName: 'HP' });
    await run();
    expect(printer.checkJob).not.toHaveBeenCalled();
    expect(finalStatus()![1]).toBe('PRINT_UNKNOWN');
  });

  it('sends progress (pages, paused and why) with the "still printing" reports', async () => {
    queue(
      { state: 'printing', pagesDone: 10, pagesTotal: 100 },
      { state: 'printing', pagesDone: 10, pagesTotal: 100 },
      { state: 'paused', problem: 'out of paper', pagesDone: 42, pagesTotal: 100 },
      { state: 'paused', problem: 'out of paper', pagesDone: 42, pagesTotal: 100 },
      { state: 'paused', problem: 'out of paper', pagesDone: 42, pagesTotal: 100 },
      { state: 'completed' },
    );
    await run();

    const progress = http.reportStatus.mock.calls.filter((c) => c[1] === 'PRINTING' && c[4]).map((c) => c[4]);
    expect(progress[0]).toEqual({ documentIndex: 0, spoolState: 'printing', pagesDone: 10, pagesTotal: 100 });
    expect(progress).toContainEqual({
      documentIndex: 0,
      spoolState: 'paused',
      pagesDone: 42,
      pagesTotal: 100,
      problem: 'out of paper',
    });
    // Unchanged readings aren't re-sent every check.
    expect(progress.length).toBeLessThan(5);
    expect(finalStatus()).toEqual(['job-1', 'PRINTED', 'job-1:0']);
  });

  it('reports a job the printer aborted as failed, with the reason', async () => {
    queue({ state: 'printing' }, { state: 'failed', problem: 'paper jam' });
    await run();
    expect(finalStatus()).toEqual([
      'job-1',
      'PRINT_FAILED',
      'job-1:0',
      expect.objectContaining({ errorCode: 'PRINTER_PROBLEM', message: expect.stringContaining('paper jam') }),
    ]);
  });
});

describe('Windows print queue (Win32_PrintJob)', () => {
  it.each([
    [{ found: false }, 'gone'],
    [{ found: true, statusMask: 0x10 }, 'printing'],
    [{ found: true, statusMask: 0x8 }, 'waiting'],
    [{ found: true, statusMask: 0x80 }, 'completed'],
    [{ found: true, statusMask: 0x14 }, 'cancelling'],
    [{ found: true, statusMask: 0x50 }, 'paused'],
  ])('%j -> %s', (job, state) => {
    expect(interpretWindowsJob(job).state).toBe(state);
  });

  it('names the problem of a paused job', () => {
    expect(interpretWindowsJob({ found: true, statusMask: 0x40 | 0x10 }).problem).toBe('out of paper');
  });

  it('passes on the page counts, ignoring a total of 0 (not known yet)', () => {
    expect(interpretWindowsJob({ found: true, statusMask: 0x10, pagesPrinted: 42, totalPages: 100 })).toEqual(
      expect.objectContaining({ pagesDone: 42, pagesTotal: 100 }),
    );
    expect(interpretWindowsJob({ found: true, statusMask: 0x10, pagesPrinted: 0, totalPages: 0 }).pagesTotal).toBeUndefined();
  });
});

describe('CUPS print queue', () => {
  it('reads the job number from lp', () => {
    expect(parseLpRequestId('request id is Canon_MF240_HR-123 (1 file(s))\n')).toEqual({
      printerName: 'Canon_MF240_HR',
      jobId: '123',
    });
    expect(parseLpRequestId('something else')).toBeNull();
  });

  const reply = (attributes: Record<string, (string | number)[]>, statusCode = 0) => ({ statusCode, attributes });

  it.each([
    [3, [], 'waiting'],
    [5, ['job-printing'], 'printing'],
    [5, ['media-empty-error'], 'paused'],
    [6, ['printer-stopped'], 'paused'],
    [7, ['job-canceled-by-user'], 'cancelled'],
    [8, ['aborted-by-system'], 'failed'],
    [9, ['job-completed-successfully'], 'completed'],
  ])('job-state %i with %j -> %s', (jobState, reasons, state) => {
    expect(interpretCupsJob(reply({ 'job-state': [jobState], 'job-state-reasons': reasons })).state).toBe(state);
  });

  it('names paper problems and ignores warnings', () => {
    const paused = interpretCupsJob(
      reply({ 'job-state': [5], 'job-printer-state-reasons': ['toner-low-warning', 'media-jam-error'] }),
    );
    expect(paused).toEqual(expect.objectContaining({ state: 'paused', problem: 'paper jam' }));
    expect(interpretCupsJob(reply({ 'job-state': [5], 'job-printer-state-reasons': ['toner-low-warning'] })).state).toBe(
      'printing',
    );
  });

  it('passes on the page counts CUPS reports', () => {
    expect(
      interpretCupsJob(reply({ 'job-state': [5], 'job-impressions-completed': [42], 'job-impressions': [100] })),
    ).toEqual(expect.objectContaining({ state: 'printing', pagesDone: 42, pagesTotal: 100 }));
    expect(interpretCupsJob(reply({ 'job-state': [5] })).pagesDone).toBeUndefined();
  });

  it('treats "no such job" as gone', () => {
    expect(interpretCupsJob(reply({}, IPP_NOT_FOUND)).state).toBe('gone');
  });

  it('encodes a Get-Job-Attributes request CUPS understands', () => {
    const req = encodeGetJobAttributes(123, 'printsetu-agent', 5);
    expect(req.readUInt16BE(2)).toBe(0x0009);
    expect(req.readUInt32BE(4)).toBe(5);
    expect(req.toString('latin1')).toContain('ipp://localhost/jobs/123');
    expect(req.at(-1)).toBe(0x03);
  });

  it('decodes integers, enums and multi-valued keywords from a reply', () => {
    const attr = (tag: number, name: string, value: Buffer) => {
      const b = Buffer.alloc(5 + name.length + value.length);
      b.writeUInt8(tag, 0);
      b.writeUInt16BE(name.length, 1);
      b.write(name, 3);
      b.writeUInt16BE(value.length, 3 + name.length);
      value.copy(b, 5 + name.length);
      return b;
    };
    const int = (n: number) => {
      const b = Buffer.alloc(4);
      b.writeInt32BE(n);
      return b;
    };
    const buf = Buffer.concat([
      Buffer.from([2, 0, 0, 0, 0, 0, 0, 5]),
      Buffer.from([0x02]), // job attributes group
      attr(0x23, 'job-state', int(5)),
      attr(0x44, 'job-state-reasons', Buffer.from('job-printing')),
      attr(0x44, '', Buffer.from('media-empty-error')),
      Buffer.from([0x03]),
    ]);
    expect(decodeReply(buf)).toEqual({
      statusCode: 0,
      attributes: { 'job-state': [5], 'job-state-reasons': ['job-printing', 'media-empty-error'] },
    });
  });
});
