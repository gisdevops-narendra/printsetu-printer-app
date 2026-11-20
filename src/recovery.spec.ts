import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JobProcessor } from './job-processor';
import { AgentConfig } from './config';
import { AgentJobPayload } from './http-client';
import { PrinterAdapter } from './printing/printer-adapter.interface';
import { InterruptedJobStore } from './job-state';

jest.mock('./logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

describe('JobProcessor — restarts, duplicates and printers that cannot do the order', () => {
  let config: AgentConfig;
  let http: { reportStatus: jest.Mock; downloadToFile: jest.Mock };
  let printer: { print: jest.Mock; listPrinters: jest.Mock; checkJob: jest.Mock; diagnose: jest.Mock };
  const statuses = () => http.reportStatus.mock.calls.map((c) => c[1]);
  const job = (over: Partial<AgentJobPayload> = {}): AgentJobPayload => ({
    jobId: 'job-1',
    attemptId: 'job-1:1',
    printerName: 'HP',
    documents: [
      {
        documentId: 'doc-1',
        originalName: 'cv.pdf',
        mimeType: 'application/pdf',
        options: { paperSize: 'A4', colorMode: 'BW', sideMode: 'SIMPLEX', copies: 1 },
        documentSignedUrl: 'https://signed/cv.pdf',
      },
    ],
    ...over,
  });

  beforeEach(() => {
    config = {
      agentId: 'a',
      agentSecret: 's',
      backendWsUrl: 'ws://x',
      backendHttpUrl: 'http://x',
      pollIntervalMs: 1000,
      heartbeatIntervalMs: 1000,
      printDriver: 'mock',
      downloadDir: fs.mkdtempSync(path.join(os.tmpdir(), 'agent-dl-')),
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'agent-state-')),
    };
    http = { reportStatus: jest.fn().mockResolvedValue(undefined), downloadToFile: jest.fn().mockResolvedValue(10) };
    printer = {
      print: jest.fn().mockResolvedValue(null),
      listPrinters: jest.fn().mockResolvedValue([{ name: 'HP', isDefault: true }]),
      checkJob: jest.fn(),
      diagnose: jest.fn().mockResolvedValue(undefined),
    };
  });
  const processor = () => new JobProcessor(config, http as any, printer as unknown as PrinterAdapter);
  const store = () => new InterruptedJobStore(path.join(config.dataDir, 'current-job.json'));

  it('prints an attempt only once, even when it is delivered twice', async () => {
    const p = processor();
    await p.handle(job());
    await p.handle(job());
    expect(printer.print).toHaveBeenCalledTimes(1);
    // A new attempt (the shop pressed PRINT again) does print.
    await p.handle(job({ attemptId: 'job-1:2' }));
    expect(printer.print).toHaveBeenCalledTimes(2);
  });

  it("fails safely, printing nothing, when the printer can't do what was ordered", async () => {
    printer.listPrinters.mockResolvedValue([{ name: 'HP', isDefault: true, capabilities: { duplex: false } }]);
    const duplexJob = job();
    duplexJob.documents[0].options.sideMode = 'DUPLEX';

    await processor().handle(duplexJob);

    expect(printer.print).not.toHaveBeenCalled();
    expect(http.reportStatus).toHaveBeenLastCalledWith(
      'job-1',
      'PRINT_FAILED',
      'job-1:1',
      expect.objectContaining({ errorCode: 'PRINTER_CANNOT_PRINT_OPTION', message: expect.stringContaining("can't print double-sided") }),
    );
  });

  it('leaves no saved progress behind after a normal order', async () => {
    await processor().handle(job());
    expect(store().load()).toBeNull();
  });

  describe('after a restart in the middle of an order', () => {
    it('follows the job it had sent to the printer and reports PRINTED', async () => {
      store().save({ jobId: 'job-1', attemptId: 'job-1:1', documentIndex: 0, documentCount: 1, documentName: 'cv.pdf', spool: { printerName: 'HP', jobId: '7' } });
      printer.checkJob.mockResolvedValue({ state: 'completed', detail: 'done' });
      jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
      try {
        const done = processor().recoverInterrupted();
        await jest.advanceTimersByTimeAsync(10_000);
        await done;
      } finally {
        jest.useRealTimers();
      }
      expect(statuses()).toEqual(['PRINTED']);
      expect(store().load()).toBeNull();
    });

    it('says which documents printed when it stopped between documents', async () => {
      store().save({ jobId: 'job-1', attemptId: 'job-1:1', documentIndex: 0, documentCount: 3, documentName: 'a.pdf', documentPrinted: true });
      await processor().recoverInterrupted();
      expect(http.reportStatus).toHaveBeenCalledWith(
        'job-1',
        'PRINT_UNKNOWN',
        'job-1:1',
        expect.objectContaining({ message: expect.stringContaining('documents 1–1 of 3 printed') }),
      );
    });

    it('asks the shop to check when it stopped while sending to the printer', async () => {
      store().save({ jobId: 'job-1', attemptId: 'job-1:1', documentIndex: 0, documentCount: 1, documentName: 'cv.pdf' });
      await processor().recoverInterrupted();
      expect(http.reportStatus).toHaveBeenCalledWith('job-1', 'PRINT_UNKNOWN', 'job-1:1', expect.objectContaining({ errorCode: 'PRINT_NOT_CONFIRMED' }));
    });

    it('does nothing when no order was in progress', async () => {
      await processor().recoverInterrupted();
      expect(http.reportStatus).not.toHaveBeenCalled();
    });
  });
});
