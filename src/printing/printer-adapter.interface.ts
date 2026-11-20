import type { PrinterDiagnostics } from './print-failure';

export interface PrintOptions {
  paperSize: string;
  colorMode: string;
  sideMode: string;
  copies: number;
}

/** One OS-level printer visible to this computer's print spooler. */
export interface DetectedPrinter {
  name: string;
  /** The OS's own default printer (for the account the agent runs as). */
  isDefault: boolean;
  /** What its driver says it can do; missing = could not be asked (then nothing is blocked). */
  capabilities?: PrinterCapabilities;
}

export interface PrinterCapabilities {
  duplex?: boolean;
  color?: boolean;
  /** Of PrintSetu's sizes (A4, A3, LETTER, LEGAL), the ones the printer offers. */
  paperSizes?: string[];
}

/**
 * The spooler call didn't come back (e.g. `lp` hung and was killed), so the
 * job may or may not have been queued. Never retried — resubmitting could
 * print a second copy — and reported as PRINT_UNKNOWN for the shopkeeper to
 * check the printer and reconcile.
 */
export class PrintOutcomeUnknownError extends Error {}

/**
 * The print-queue job a print() call created, so the agent can follow it to
 * the end. `jobId` undefined = the job was submitted but the queue could not
 * tell us which one it is (it can't be followed, so the outcome is unconfirmed).
 */
export interface SpoolJobRef {
  printerName?: string;
  jobId?: string;
}

/**
 * Where a print-queue job is. `cancelling` = seen being deleted (Windows shows
 * this briefly before the job disappears). `gone` = no longer in the queue and
 * the OS can't say how it ended — the caller decides from the last state seen.
 */
export type SpoolJobState = 'waiting' | 'printing' | 'paused' | 'cancelling' | 'completed' | 'cancelled' | 'failed' | 'gone';

export interface SpoolJobStatus {
  state: SpoolJobState;
  /** Plain-language reason for `paused` / `failed`, e.g. "out of paper". */
  problem?: string;
  /**
   * Pages the queue says it has sent to the printer so far, and in total, when
   * the driver reports them. Many don't (or report 0 until the end), and
   * "sent" can run ahead of paper actually coming out.
   */
  pagesDone?: number;
  pagesTotal?: number;
  /** What the OS returned, for logs and failure reports. */
  detail: string;
}

export interface PrinterAdapter {
  /**
   * Resolves once the OS print spooler has *accepted* the job, not once physical
   * printing finishes. Returns the queue job to follow with checkJob(), or
   * null/undefined when it has already left the queue (or there is no queue, as
   * with the mock printer) — i.e. nothing is left to wait for.
   */
  print(filePath: string, printerName: string | undefined, options: PrintOptions): Promise<SpoolJobRef | null | void>;
  /** Asks the print queue where a submitted job is. Throws when the queue can't be asked. */
  checkJob?(ref: SpoolJobRef): Promise<SpoolJobStatus>;
  listPrinters(): Promise<DetectedPrinter[]>;
  /**
   * Asks the OS about the printer and its spooler, only after a print failed —
   * the print command's own error rarely says *why* (offline, out of paper,
   * spooler stopped). Optional; must never throw.
   */
  diagnose?(printerName: string | undefined): Promise<PrinterDiagnostics | undefined>;
}
