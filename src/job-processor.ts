import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { v4 as uuid } from 'uuid';
import { AgentConfig } from './config';
import { BackendHttpClient, AgentJobPayload, AgentJobDocument, FailureReport, ProgressReport } from './http-client';
import {
  DetectedPrinter,
  PrinterAdapter,
  PrinterCapabilities,
  PrintOptions,
  PrintOutcomeUnknownError,
  SpoolJobRef,
  SpoolJobState,
} from './printing/printer-adapter.interface';
import {
  classifyDownloadError,
  classifyPrintError,
  describeError,
  errorMessage,
  JobStage,
  PrintFailure,
} from './printing/print-failure';
import { logger } from './logger';
import { assertPrinterCanPrint } from './printing/capability-check';
import { InterruptedJobStore, ReportOutbox } from './job-state';

/**
 * Orchestrates one job end-to-end: download -> print -> report. The
 * backend, not this process, owns the print-job state machine (SRS
 * §13.1: "the agent is not trusted to change print-eligibility or order
 * status") — this class only ever *reports* what happened.
 */
const PRINT_RETRY_ATTEMPTS = 2;
const PRINT_RETRY_DELAY_MS = 2000;
// If the final report can't reach the backend, the order would sit in
// PRINTING with no outcome or reason at all — try a few times before giving up.
const FAILURE_REPORT_DELAYS_MS = [0, 3000, 10000];
// Following a submitted job in the print queue until it finishes.
const SPOOL_CHECK_INTERVAL_MS = 2500;
// Tells the backend "still printing" this often, so a long job isn't flagged as stuck.
const KEEP_ALIVE_INTERVAL_MS = 30_000;
const HANDLED_TTL_MS = 6 * 60 * 60_000;
// Progress changes (pages, paused/printing) are passed on at most this often.
const MIN_PROGRESS_INTERVAL_MS = 5_000;
// Consecutive failed queue checks (~20s) before giving up on confirming the job.
// Follow the queue through short hiccups (PowerShell/CUPS busy) for this long before giving up.
const SPOOL_CHECK_GIVE_UP_MS = 2 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class JobProcessor {
  private readonly inProgress = new Set<string>();
  /** Attempts already handled, so an order delivered twice (socket + polling) prints once. */
  private readonly handled = new Map<string, number>();
  private readonly outbox: ReportOutbox;
  private readonly state: InterruptedJobStore;

  constructor(
    private readonly config: AgentConfig,
    private readonly http: BackendHttpClient,
    private readonly printer: PrinterAdapter,
  ) {
    if (!fs.existsSync(config.downloadDir)) fs.mkdirSync(config.downloadDir, { recursive: true });
    this.outbox = new ReportOutbox(path.join(config.dataDir, 'outbox.json'), http);
    this.state = new InterruptedJobStore(path.join(config.dataDir, 'current-job.json'));
  }

  /** True while an order is being printed (the updater waits for this to clear). */
  get busy(): boolean {
    return this.inProgress.size > 0;
  }

  /** Sends reports that could not be delivered earlier (internet was down). */
  flushOutbox(): Promise<void> {
    return this.outbox.flush();
  }

  async handle(job: AgentJobPayload): Promise<void> {
    if (this.inProgress.has(job.jobId)) {
      logger.warn(`Ignoring duplicate dispatch for job ${job.jobId} (already in progress).`);
      return;
    }
    if (job.attemptId && this.handled.has(job.attemptId)) {
      logger.warn(`Ignoring duplicate dispatch for job ${job.jobId} (attempt ${job.attemptId} was already handled).`);
      return;
    }
    this.inProgress.add(job.jobId);
    const attemptId = job.attemptId || uuid();
    this.rememberHandled(attemptId);

    let stage: JobStage = 'report';
    let printerName: string | undefined;
    let current: { doc: AgentJobDocument; index: number; bytes?: number } | undefined;
    try {
      await this.http.reportStatus(job.jobId, 'ACCEPTED', attemptId);
      stage = 'choose-printer';
      const chosen = await this.resolvePrinter(job.printerName);
      printerName = chosen.name;
      logger.info(`Job ${job.jobId} will print on "${printerName ?? '(OS default)'}".`);
      assertPrinterCanPrint(printerName, chosen.capabilities, job.documents);
      stage = 'report';
      await this.http.reportStatus(job.jobId, 'PRINTING', attemptId);

      // One print request can carry several documents (each with its own
      // options) — print them in order, as one atomic outcome: the backend
      // still only tracks accepted/printing/printed/failed per JOB, not
      // per document, so if any document fails the whole job reports
      // PRINT_FAILED (documents already sent to the spooler before the
      // failure cannot be un-printed; the shopkeeper resolves it manually).
      for (const [index, doc] of job.documents.entries()) {
        current = { doc, index };
        const extension = doc.mimeType === 'application/pdf' ? '.pdf' : doc.mimeType === 'image/png' ? '.png' : '.jpg';
        const filePath = path.join(this.config.downloadDir, `${job.jobId}-${doc.documentId}${extension}`);
        try {
          stage = 'download';
          try {
            current.bytes = await this.http.downloadToFile(doc.documentSignedUrl, filePath);
          } catch (error) {
            throw classifyDownloadError(error);
          }
          stage = 'print';
          const spoolJob = await this.printWithRetry(filePath, printerName, doc.options);
          // PRINTED means the print queue finished the job, not just that it took it.
          stage = 'wait';
          if (spoolJob) await this.waitUntilPrinted(job.jobId, attemptId, spoolJob, index);
        } finally {
          fs.promises.unlink(filePath).catch(() => undefined);
        }
      }

      stage = 'report-printed';
      current = undefined;
      this.state.clear();
      await this.http.reportStatus(job.jobId, 'PRINTED', attemptId);
      logger.info(`Job ${job.jobId} printed successfully (${job.documents.length} document(s)).`);
    } catch (error) {
      if (stage === 'report-printed') {
        // Everything printed — only telling the backend failed. Never turn that into PRINT_FAILED.
        logger.error(`Job ${job.jobId} printed, but reporting it failed: ${errorMessage(error)}`);
        await this.reportWithRetry(job.jobId, 'PRINTED', attemptId);
        return;
      }
      // SRS §13.3 "Paper unavailable / driver error" -> fail safely, keep the job retryable.
      const failure =
        error instanceof PrintFailure
          ? error
          : stage === 'print'
            ? await this.explainPrintError(error, printerName)
            : new PrintFailure(
                'UNKNOWN',
                'The Printer App could not update this order in PrintSetu. Check the internet connection, then print again.',
                describeError(error),
              );

      // Which document broke matters when an order has several: earlier ones are already printed.
      let message = failure.message;
      if (current && job.documents.length > 1) {
        const alreadySent =
          current.index === 0 ? '' : current.index === 1 ? '; document 1 was already sent to the printer' : `; documents 1–${current.index} were already sent to the printer`;
        message += ` (document ${current.index + 1} of ${job.documents.length}: "${current.doc.originalName}"${alreadySent})`;
      }
      const context = [
        `stage=${stage}`,
        `printer=${printerName ?? '(OS default)'}`,
        current ? `document=${current.doc.documentId} (${current.doc.mimeType}, ${current.bytes ?? '?'} bytes)` : undefined,
        `agent=${os.hostname()} ${process.platform} ${os.release()}`,
      ].filter(Boolean).join('; ');
      const detail = `${context} | ${failure.detail}`;

      logger.error(`Job ${job.jobId} ${failure.outcomeUnknown ? 'has an unknown outcome' : 'failed'} [${failure.code}]: ${message}`, {
        attemptId,
        detail,
        stack: error instanceof Error ? error.stack : undefined,
      });
      await this.reportWithRetry(job.jobId, failure.outcomeUnknown ? 'PRINT_UNKNOWN' : 'PRINT_FAILED', attemptId, {
        message,
        errorCode: failure.code,
        errorDetail: detail,
      });
    } finally {
      this.state.clear();
      this.inProgress.delete(job.jobId);
    }
  }

  private rememberHandled(attemptId: string): void {
    const now = Date.now();
    this.handled.set(attemptId, now);
    for (const [id, at] of this.handled) if (now - at > HANDLED_TTL_MS) this.handled.delete(id);
  }

  /**
   * After a restart (power cut, Windows update, crash) in the middle of an
   * order: follows the job it had sent to the print queue to the end and
   * reports how it went, instead of leaving the order to be flagged
   * "not confirmed" with nobody watching.
   */
  async recoverInterrupted(): Promise<void> {
    const saved = this.state.load();
    if (!saved) return;
    this.state.clear();
    const { jobId, attemptId, documentIndex, documentCount, documentName } = saved;
    const which = documentCount > 1 ? ` (document ${documentIndex + 1} of ${documentCount}: "${documentName}")` : '';
    logger.warn(`Recovering job ${jobId} interrupted by a restart${which}.`);
    this.rememberHandled(attemptId);
    const lastDocument = documentIndex === documentCount - 1;
    try {
      if (saved.spool?.jobId && this.printer.checkJob) {
        await this.waitUntilPrinted(jobId, attemptId, saved.spool, documentIndex);
      } else if (!saved.documentPrinted) {
        throw new PrintFailure(
          'PRINT_NOT_CONFIRMED',
          `The Printer App restarted while sending this order to the printer${which}. Check the printer, then mark the order.`,
          'restarted before the print queue job could be followed',
          true,
        );
      }
      if (lastDocument) {
        await this.reportWithRetry(jobId, 'PRINTED', attemptId);
        logger.info(`Job ${jobId} printed (followed after a restart).`);
        return;
      }
      await this.reportWithRetry(jobId, 'PRINT_UNKNOWN', attemptId, {
        message: `The Printer App restarted during this order: documents 1–${documentIndex + 1} of ${documentCount} printed, the rest were not sent. Check the printer, then mark the order.`,
        errorCode: 'PRINT_NOT_CONFIRMED',
        errorDetail: `restarted after document ${documentIndex + 1} of ${documentCount}`,
      });
    } catch (error) {
      const failure = error instanceof PrintFailure ? error : new PrintFailure('PRINT_NOT_CONFIRMED', 'The Printer App restarted during this order and lost track of it. Check the printer, then mark the order.', describeError(error), true);
      await this.reportWithRetry(jobId, failure.outcomeUnknown ? 'PRINT_UNKNOWN' : 'PRINT_FAILED', attemptId, {
        message: failure.message + which,
        errorCode: failure.code,
        errorDetail: `after a restart | ${failure.detail}`,
      });
    }
  }

  /** The print command's own error rarely says why — ask the OS about the printer before classifying it. */
  private async explainPrintError(error: unknown, printerName: string | undefined): Promise<PrintFailure> {
    const diagnostics = await this.printer.diagnose?.(printerName).catch(() => undefined);
    return classifyPrintError(error, printerName, diagnostics);
  }

  /** Final reports never get lost: a few quick tries, then kept on disk and sent when the internet is back. */
  private async reportWithRetry(
    jobId: string,
    status: 'PRINTED' | 'PRINT_FAILED' | 'PRINT_UNKNOWN',
    attemptId: string,
    failure?: FailureReport,
  ): Promise<void> {
    for (const [i, delay] of FAILURE_REPORT_DELAYS_MS.entries()) {
      if (delay) await sleep(delay);
      try {
        await this.http.reportStatus(jobId, status, attemptId, failure);
        return;
      } catch (reportError) {
        logger.error(
          `Could not report ${status} for job ${jobId} (try ${i + 1}/${FAILURE_REPORT_DELAYS_MS.length}): ${errorMessage(reportError)}`,
        );
      }
    }
    this.outbox.add({ jobId, status, attemptId, failure });
  }

  /**
   * Picks the OS printer for a job. The shopkeeper's dashboard choice wins;
   * without one, a locally configured name (PRINTSETU_PRINTER_NAME /
   * agent.config.json) is used only if that printer really exists — older
   * downloads baked the dashboard label "Print Agent" in there, which is not
   * an OS printer — then the OS default, then the only installed printer.
   * Never guesses between several printers: printing a customer's document
   * on the wrong machine is worse than a clear PRINT_FAILED.
   */
  private async resolvePrinter(
    requested: string | null | undefined,
  ): Promise<{ name: string | undefined; capabilities?: PrinterCapabilities }> {
    let printers: DetectedPrinter[] | null = null;
    try {
      printers = await this.printer.listPrinters();
    } catch (error) {
      logger.warn(`Could not list printers, printing without validation: ${errorMessage(error)}`);
    }
    const pick = (printer: DetectedPrinter) => ({ name: printer.name, capabilities: printer.capabilities });

    if (requested) {
      const match = printers?.find((p) => p.name === requested);
      if (printers && !match) {
        throw new PrintFailure(
          'PRINTER_NOT_FOUND',
          `Printer "${requested}" is not installed on this computer. Choose a printer again on the Printer App page.`,
          `installed printers: ${installedList(printers)}`,
        );
      }
      return match ? pick(match) : { name: requested };
    }
    if (!printers) return { name: undefined };

    const configured = printers.find((p) => p.name === this.config.printerName);
    if (this.config.printerName && configured) return pick(configured);

    const osDefault = printers.find((p) => p.isDefault);
    if (osDefault) return pick(osDefault);
    if (printers.length === 1) return pick(printers[0]);
    if (printers.length === 0) {
      throw new PrintFailure('PRINTER_NOT_FOUND', 'No printers are installed on this computer.', 'installed printers: (none)');
    }
    throw new PrintFailure(
      'PRINTER_NOT_FOUND',
      'This computer has several printers and none is set as default. Choose one on the Printer App page.',
      `installed printers: ${installedList(printers)}`,
    );
  }

  /**
   * Follows a submitted job in the print queue until the queue says it is done,
   * so PRINTED means "finished", not "handed over". A paused job (out of paper,
   * jam) is waited on for as long as it takes — the shop fixes the printer and it
   * carries on — while "still printing" reports stop the backend from flagging a
   * long job as stuck; those reports carry the progress (which document, pages
   * the queue has sent, paused and why) for the shop's dashboard. A job cancelled
   * at the computer or printer fails the order (its documents are then kept); one
   * the queue can't be asked about is reported as unconfirmed rather than printed.
   */
  private async waitUntilPrinted(
    jobId: string,
    attemptId: string,
    ref: SpoolJobRef,
    documentIndex: number,
  ): Promise<void> {
    const where = `${ref.printerName ?? '(OS default)'} job ${ref.jobId ?? '?'}`;
    if (!ref.jobId || !this.printer.checkJob) {
      throw new PrintFailure(
        'PRINT_NOT_CONFIRMED',
        'The order was sent to the printer, but the Printer App could not follow it to the end. Check the printer, then mark the order.',
        `${where}: the print queue did not identify the submitted job`,
        true,
      );
    }

    let last: SpoolJobState | undefined;
    let lastDetail = '';
    let failures = 0;
    let failingSince = 0;
    let progress: ProgressReport = { documentIndex, spoolState: 'waiting' };
    let reported = ''; // the progress last sent, to send only changes
    let lastReportAt = 0;
    for (;;) {
      await sleep(SPOOL_CHECK_INTERVAL_MS);
      try {
        const status = await this.printer.checkJob!(ref);
        failures = 0;
        failingSince = 0;
        if (status.state !== last) {
          logger.info(`Print queue ${where}: ${status.state}${status.problem ? ` (${status.problem})` : ''}`, { detail: status.detail });
        }
        const state = status.state === 'gone' ? (last === 'cancelling' ? 'cancelled' : 'completed') : status.state;
        if (state === 'completed') return;
        if (state === 'cancelled') {
          throw new PrintFailure(
            'CANCELLED_AT_PRINTER',
            'Printing was cancelled at the computer or printer before it finished.',
            `${where}: ${status.detail}`,
          );
        }
        if (state === 'failed') {
          throw new PrintFailure(
            'PRINTER_PROBLEM',
            `The printer stopped this order${status.problem ? `: ${status.problem}` : ''}. Check the printer, then print again.`,
            `${where}: ${status.detail}`,
          );
        }
        last = status.state;
        lastDetail = status.detail;
        progress = {
          documentIndex,
          spoolState: status.state === 'paused' ? 'paused' : status.state === 'printing' ? 'printing' : 'waiting',
          pagesDone: status.pagesDone,
          pagesTotal: status.pagesTotal,
          problem: status.state === 'paused' ? status.problem : undefined,
        };
      } catch (error) {
        if (error instanceof PrintFailure) throw error;
        failures += 1;
        failingSince ||= Date.now();
        logger.warn(`Could not check ${where} (${failures} time(s) in a row): ${errorMessage(error)}`);
        if (Date.now() - failingSince >= SPOOL_CHECK_GIVE_UP_MS) {
          throw new PrintFailure(
            'PRINT_NOT_CONFIRMED',
            'The order was sent to the printer, but the Printer App lost track of it. Check the printer, then mark the order.',
            `${where}: last state ${last ?? 'none'} ${lastDetail} | ${describeError(error)}`,
            true,
          );
        }
      }

      // Changes go out promptly (at most every few seconds); otherwise a keep-alive.
      const snapshot = JSON.stringify(progress);
      const sinceLast = Date.now() - lastReportAt;
      if ((snapshot !== reported && sinceLast >= MIN_PROGRESS_INTERVAL_MS) || sinceLast >= KEEP_ALIVE_INTERVAL_MS) {
        lastReportAt = Date.now();
        reported = snapshot;
        await this.http.reportStatus(jobId, 'PRINTING', attemptId, undefined, progress).catch((error) =>
          logger.warn(`Could not tell PrintSetu job ${jobId} is still printing: ${errorMessage(error)}`),
        );
      }
    }
  }

  // USB/IPP-class-driver printers (e.g. small HP LaserJets) can transiently
  // report "printer doesn't exist" to the spooler API under rapid/back-to-
  // back submissions even though the OS printer list is correct — a driver
  // hiccup, not a real failure. Retry once with a short delay before
  // surfacing PRINT_FAILED, rather than relying on the shopkeeper to notice
  // and re-click Print.
  private async printWithRetry(
    filePath: string,
    printerName: string | undefined,
    options: PrintOptions,
  ): Promise<SpoolJobRef | null> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= PRINT_RETRY_ATTEMPTS; attempt++) {
      try {
        return (await this.printer.print(filePath, printerName, options)) ?? null;
      } catch (error) {
        // The spooler may already hold this job — retrying could print it twice.
        if (error instanceof PrintOutcomeUnknownError) throw error;
        lastError = error;
        if (attempt < PRINT_RETRY_ATTEMPTS) {
          logger.warn(`Print attempt ${attempt} failed, retrying in ${PRINT_RETRY_DELAY_MS}ms: ${errorMessage(error)}`, {
            detail: describeError(error),
          });
          await sleep(PRINT_RETRY_DELAY_MS);
        }
      }
    }
    throw lastError;
  }
}

function installedList(printers: DetectedPrinter[]): string {
  return printers.map((p) => `${p.name}${p.isDefault ? ' (default)' : ''}`).join(', ') || '(none)';
}
