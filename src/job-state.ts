import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { AgentJobStatus, BackendHttpClient, FailureReport } from './http-client';
import { SpoolJobRef } from './printing/printer-adapter.interface';
import { logger } from './logger';

/** Writes a small JSON file so a crash or power cut never leaves it half written. */
function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export interface InterruptedJob {
  jobId: string;
  attemptId: string;
  documentIndex: number;
  documentCount: number;
  documentName: string;
  /** The print-queue job of the current document, once it was submitted. */
  spool?: SpoolJobRef;
  /** The current document finished printing (the order was between documents). */
  documentPrinted?: boolean;
}

/** Where the order being printed is, kept on disk so a restart can finish following it. */
export class InterruptedJobStore {
  constructor(private readonly file: string) {}

  save(job: InterruptedJob): void {
    try {
      writeJsonAtomic(this.file, job);
    } catch (error) {
      logger.warn(`Could not save the order's progress: ${(error as Error).message}`);
    }
  }

  load(): InterruptedJob | null {
    return readJson<InterruptedJob>(this.file);
  }

  clear(): void {
    fs.rmSync(this.file, { force: true });
  }
}

export interface PendingReport {
  jobId: string;
  status: Extract<AgentJobStatus, 'PRINTED' | 'PRINT_FAILED' | 'PRINT_UNKNOWN'>;
  attemptId: string;
  failure?: FailureReport;
  queuedAt?: string;
}

const OUTBOX_KEEP_MS = 7 * 24 * 60 * 60_000;

/**
 * Final reports (printed / failed / not confirmed) the backend could not be
 * told about — internet down when an order finished. Kept on disk and sent
 * again until the backend answers, so a printed order isn't left "not
 * confirmed" just because the shop's internet dropped at the wrong moment.
 */
export class ReportOutbox {
  private flushing = false;

  constructor(
    private readonly file: string,
    private readonly http: BackendHttpClient,
  ) {}

  add(report: PendingReport): void {
    const pending = this.read().filter((r) => !(r.jobId === report.jobId && r.attemptId === report.attemptId));
    pending.push({ ...report, queuedAt: new Date().toISOString() });
    this.write(pending);
    logger.warn(`Will report ${report.status} for job ${report.jobId} once PrintSetu can be reached.`);
  }

  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const pending = this.read();
      if (!pending.length) return;
      const kept: PendingReport[] = [];
      for (const report of pending) {
        if (Date.now() - new Date(report.queuedAt ?? 0).getTime() > OUTBOX_KEEP_MS) continue;
        try {
          await this.http.reportStatus(report.jobId, report.status, report.attemptId, report.failure);
          logger.info(`Delivered the delayed ${report.status} report for job ${report.jobId}.`);
        } catch (error) {
          // The backend refused it (order gone or already settled): sending again won't help.
          const status = (error as { cause?: unknown }).cause;
          const http = axios.isAxiosError(status) ? status.response?.status : undefined;
          if (http && http >= 400 && http < 500 && http !== 429) continue;
          kept.push(report);
        }
      }
      this.write(kept);
    } finally {
      this.flushing = false;
    }
  }

  private read(): PendingReport[] {
    return readJson<PendingReport[]>(this.file) ?? [];
  }

  private write(reports: PendingReport[]): void {
    try {
      if (reports.length) writeJsonAtomic(this.file, reports);
      else fs.rmSync(this.file, { force: true });
    } catch (error) {
      logger.error(`Could not save reports waiting to be sent: ${(error as Error).message}`);
    }
  }
}
