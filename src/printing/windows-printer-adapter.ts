import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import {
  DetectedPrinter,
  PrinterAdapter,
  PrintOptions,
  PrintOutcomeUnknownError,
  SpoolJobRef,
  SpoolJobStatus,
} from './printer-adapter.interface';
import { errorMessage, PrinterDiagnostics, PrintFailure } from './print-failure';
import { logger } from '../logger';

const execFileAsync = promisify(execFile);
// Bundled from vendor/ (see vendor/README.md), not from pdf-to-printer, whose
// own copy is an older 32-bit build that runs out of memory on large files.
const SUMATRA_ASSET = 'SumatraPDF-3.6.1-64.exe';
// SumatraPDF renders the whole document before it returns, so a long PDF
// legitimately takes a while — but a driver stuck on a hidden dialog (the
// agent runs as SYSTEM, with no desktop) would otherwise hang the order in
// PRINTING forever.
const SUMATRA_TIMEOUT_MS = 180_000;
// A job that is reaching the queue may keep SumatraPDF busy longer (a long PDF), up to this.
const SUMATRA_MAX_MS = 30 * 60_000;
const QUEUE_WATCH_INTERVAL_MS = 5000;
const SNAPSHOT_ATTEMPTS = 3;
const DIAGNOSE_TIMEOUT_MS = 20_000;
// Asking every driver what it can do takes a while with network printers.
const LIST_PRINTERS_TIMEOUT_MS = 60_000;

// Win32_Printer.ExtendedPrinterStatus / DetectedErrorState values that mean
// the printer cannot print right now, in the shopkeeper's words.
const EXTENDED_STATUS_PROBLEM: Record<number, string> = {
  6: 'stopped printing',
  8: 'paused',
  9: 'in an error state',
  11: 'not available',
};
const DETECTED_ERROR_PROBLEM: Record<number, string> = {
  4: 'out of paper',
  6: 'out of toner or ink',
  7: 'a door or cover is open',
  8: 'paper jam',
  10: 'needs service',
  11: 'output tray is full',
};

/**
 * The printer name comes in through an environment variable, not the script
 * text, so a name with quotes or backslashes (\\server\\share) can't break
 * or inject into the PowerShell command.
 */
const DIAGNOSE_SCRIPT = [
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  "$ErrorActionPreference = 'SilentlyContinue'",
  '$name = $env:PRINTSETU_DIAG_PRINTER',
  '$svc = Get-Service -Name Spooler',
  "$p = if ($name) { Get-CimInstance Win32_Printer | Where-Object { $_.Name -eq $name } | Select-Object -First 1 } else { Get-CimInstance Win32_Printer -Filter 'Default=true' | Select-Object -First 1 }",
  '$jobs = if ($p) { @(Get-CimInstance Win32_PrintJob | Where-Object { $_.Name -like ($p.Name + \',*\') }).Count } else { 0 }',
  "[pscustomobject]@{ spooler = if ($svc) { $svc.Status.ToString() } else { 'NotFound' }; found = [bool]$p; name = $p.Name; printerStatus = $p.PrinterStatus; extendedStatus = $p.ExtendedPrinterStatus; errorState = $p.DetectedErrorState; workOffline = $p.WorkOffline; portName = $p.PortName; driverName = $p.DriverName; queuedJobs = $jobs } | ConvertTo-Json -Compress",
].join('; ');

/**
 * Jobs currently in one printer's queue (the default printer when none is
 * named), with the document name each was submitted under. Taken before and
 * after SumatraPDF runs: the new job whose document name holds our file's
 * name is ours. Names come in through environment variables, as in
 * DIAGNOSE_SCRIPT.
 */
const LIST_JOBS_SCRIPT = [
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  "$ErrorActionPreference = 'Stop'",
  '$name = $env:PRINTSETU_PRINTER',
  "if (-not $name) { $name = (Get-CimInstance Win32_Printer -Filter 'Default=true' | Select-Object -First 1).Name }",
  "$jobs = @(Get-CimInstance Win32_PrintJob | Where-Object { $_.Name.StartsWith($name + ',') } | ForEach-Object { [pscustomobject]@{ id = [int]$_.JobId; document = [string]$_.Document } })",
  '[pscustomobject]@{ printer = $name; jobs = $jobs } | ConvertTo-Json -Compress -Depth 3',
].join('; ');

/**
 * Every printer with what its driver says it can do (two-sided, colour, paper
 * sizes), read through .NET's PrinterSettings — the same answers the Windows
 * print dialog shows. A printer whose driver can't be asked comes back
 * without them (valid = false), so nothing is blocked for it.
 */
const LIST_PRINTERS_SCRIPT = [
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  "$ErrorActionPreference = 'SilentlyContinue'",
  'Add-Type -AssemblyName System.Drawing',
  "$list = @(Get-CimInstance Win32_Printer | ForEach-Object { $s = New-Object System.Drawing.Printing.PrinterSettings; $s.PrinterName = $_.Name; $ok = [bool]$s.IsValid; [pscustomobject]@{ name = [string]$_.Name; isDefault = [bool]$_.Default; valid = $ok; duplex = $(if ($ok) { [bool]$s.CanDuplex } else { $null }); color = $(if ($ok) { [bool]$s.SupportsColor } else { $null }); paper = @($(if ($ok) { $s.PaperSizes | ForEach-Object { [string]$_.Kind } } else { @() })) } })",
  'ConvertTo-Json -Compress -Depth 3 -InputObject $list',
].join('; ');

export interface QueueSnapshot {
  printer: string;
  jobs: { id: number; document: string }[];
}

/** PowerShell's ConvertTo-Json gives a lone item as an object and none as null. */
function asArray<T>(value: T | T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

export function parseQueueSnapshot(stdout: string): QueueSnapshot {
  const parsed = JSON.parse(stdout) as { printer: string; jobs: QueueSnapshot['jobs'] | QueueSnapshot['jobs'][number] | null };
  return { printer: parsed.printer, jobs: asArray(parsed.jobs).map((j) => ({ id: Number(j.id), document: String(j.document ?? '') })) };
}

/**
 * Which new queue job is ours. A new job named after our file is ours; with
 * no name to go by, a single new job is taken as ours (nothing else was
 * printed meanwhile). Several new jobs and none named after our file:
 * 'unknown' — following another program's job would report the wrong
 * result, so the order is left for the shop to confirm. 'gone' = no new job:
 * ours already finished and left the queue.
 */
export function findOurJob(before: QueueSnapshot | null, after: QueueSnapshot | null, marker: string): string | 'gone' | 'unknown' {
  if (!before || !after) return 'unknown';
  const known = new Set(before.jobs.map((j) => j.id));
  const added = after.jobs.filter((j) => !known.has(j.id));
  if (added.length === 0) return 'gone';
  const named = added.filter((j) => j.document.toLowerCase().includes(marker.toLowerCase()));
  if (named.length > 0) return String(Math.max(...named.map((j) => j.id)));
  if (added.length === 1) return String(added[0].id);
  return 'unknown';
}

const PAPER_KINDS: Record<string, string> = { A4: 'A4', A3: 'A3', Letter: 'LETTER', Legal: 'LEGAL' };

/** LIST_PRINTERS_SCRIPT's output -> printers with what each can do (when its driver could be asked). */
export function parsePrinterList(stdout: string): DetectedPrinter[] {
  const rows = asArray(
    JSON.parse(stdout || '[]') as
      | { name: string; isDefault: boolean; valid: boolean; duplex: boolean | null; color: boolean | null; paper: string[] | string | null }[]
      | null,
  );
  return rows.map((row) => {
    const printer: DetectedPrinter = { name: row.name, isDefault: !!row.isDefault };
    if (!row.valid) return printer;
    const paperSizes = [...new Set(asArray(row.paper).map((kind) => PAPER_KINDS[kind]).filter((p): p is string => !!p))];
    printer.capabilities = {
      ...(typeof row.duplex === 'boolean' ? { duplex: row.duplex } : {}),
      ...(typeof row.color === 'boolean' ? { color: row.color } : {}),
      ...(paperSizes.length ? { paperSizes } : {}),
    };
    return printer;
  });
}

/** One job's state in the Windows print queue (Win32_PrintJob), or found=false once it has left. */
const CHECK_JOB_SCRIPT = [
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  "$ErrorActionPreference = 'Stop'",
  '$name = $env:PRINTSETU_PRINTER',
  '$id = [int]$env:PRINTSETU_JOB_ID',
  "$j = Get-CimInstance Win32_PrintJob | Where-Object { $_.JobId -eq $id -and $_.Name.StartsWith($name + ',') } | Select-Object -First 1",
  "if ($j) { [pscustomobject]@{ found = $true; statusMask = $j.StatusMask; jobStatus = $j.JobStatus; pagesPrinted = $j.PagesPrinted; totalPages = $j.TotalPages } | ConvertTo-Json -Compress } else { '{\"found\":false}' }",
].join('; ');

export interface WindowsJobState {
  found: boolean;
  statusMask?: number | null;
  jobStatus?: string | null;
  pagesPrinted?: number | null;
  totalPages?: number | null;
}

// Win32_PrintJob.StatusMask bits.
const JOB = {
  PAUSED: 0x1,
  ERROR: 0x2,
  DELETING: 0x4,
  PRINTING: 0x10,
  OFFLINE: 0x20,
  PAPER_OUT: 0x40,
  PRINTED: 0x80,
  DELETED: 0x100,
  BLOCKED: 0x200,
  USER_INTERVENTION: 0x400,
};
const JOB_PROBLEM: [number, string][] = [
  [JOB.PAPER_OUT, 'out of paper'],
  [JOB.OFFLINE, 'the printer is offline'],
  [JOB.USER_INTERVENTION, 'the printer needs attention'],
  [JOB.ERROR, 'the printer reports an error'],
  [JOB.BLOCKED, 'blocked by an earlier job'],
  [JOB.PAUSED, 'paused on the computer'],
];

/** Win32_PrintJob -> where the job is. Windows drops finished jobs, so "not found" is `gone`. */
export function interpretWindowsJob(job: WindowsJobState): SpoolJobStatus {
  const detail = JSON.stringify(job);
  if (!job.found) return { state: 'gone', detail };
  const pages = {
    pagesDone: typeof job.pagesPrinted === 'number' ? job.pagesPrinted : undefined,
    pagesTotal: typeof job.totalPages === 'number' && job.totalPages > 0 ? job.totalPages : undefined,
  };
  const mask = job.statusMask ?? 0;
  if (mask & (JOB.DELETING | JOB.DELETED)) return { state: 'cancelling', detail, ...pages };
  if (mask & JOB.PRINTED) return { state: 'completed', detail, ...pages };
  const problem = JOB_PROBLEM.find(([bit]) => mask & bit)?.[1];
  if (problem) return { state: 'paused', problem, detail, ...pages };
  return { state: mask & JOB.PRINTING ? 'printing' : 'waiting', detail, ...pages };
}

interface WindowsPrinterState {
  spooler?: string;
  found?: boolean;
  name?: string | null;
  printerStatus?: number | null;
  extendedStatus?: number | null;
  errorState?: number | null;
  workOffline?: boolean | null;
  portName?: string | null;
  driverName?: string | null;
  queuedJobs?: number;
}

/**
 * SumatraPDF.exe lives in vendor/. Under `pkg` that path is inside the
 * read-only virtual snapshot, which `child_process.execFile` cannot spawn
 * directly — so when packaged, extract it once to a real temp file (the
 * version is in the file name, so an upgrade never reuses an older copy).
 * In normal (non-pkg) runs the vendor/ copy is used as is.
 */
function resolveSumatraPath(): string {
  // dist/printing (or src/printing under ts-node) -> the package root.
  const vendorPath = path.join(__dirname, '..', '..', 'vendor', SUMATRA_ASSET);
  if (!(process as unknown as { pkg?: unknown }).pkg) return vendorPath;

  const extractedPath = path.join(os.tmpdir(), 'printsetu-agent', SUMATRA_ASSET);
  if (!fs.existsSync(extractedPath)) {
    fs.mkdirSync(path.dirname(extractedPath), { recursive: true });
    // Written under a temporary name first: a copy cut short (agent stopped,
    // disk full) must not be left behind as a broken exe that is reused forever.
    const partialPath = `${extractedPath}.${process.pid}.partial`;
    fs.writeFileSync(partialPath, fs.readFileSync(vendorPath));
    fs.renameSync(partialPath, extractedPath);
  }
  return extractedPath;
}

/**
 * SRS §13.1/13.2: submits the file to the configured Windows printer via
 * the OS print spooler (through SumatraPDF, bundled from vendor/ —
 * no custom native driver code, and it works for both PDF and raster
 * images). Only runs on win32; see PrinterAdapterFactory.
 */
export class WindowsPrinterAdapter implements PrinterAdapter {
  async print(filePath: string, printerName: string | undefined, options: PrintOptions): Promise<SpoolJobRef | null> {
    if (!fs.existsSync(filePath)) throw new Error(`No such file: ${filePath}`);
    // Our download's file name (order id + document id): SumatraPDF submits the
    // job under the file's path, so it identifies our job among others in the queue.
    const marker = path.basename(filePath, path.extname(filePath));
    const before = await this.snapshot(printerName, 'before printing');

    // The same SumatraPDF command line pdf-to-printer builds, run directly so
    // it can be watched and its exit code/output kept for the report.
    // SRS §13.2: "If the exact printer does not support a requested option,
    // the job must fail safely" — SumatraPDF exits non-zero, which the caller
    // (job-processor.ts) reports as PRINT_FAILED.
    const settings = [
      options.colorMode === 'BW' ? 'monochrome' : 'color',
      options.sideMode === 'DUPLEX' ? 'duplex' : 'simplex',
      `paper=${options.paperSize}`,
    ];
    if (options.copies) settings.push(`${options.copies}x`);
    const args = [
      ...(printerName ? ['-print-to', printerName] : ['-print-to-default']),
      '-silent',
      '-print-settings',
      settings.join(','),
      filePath,
    ];
    let sumatraPath: string;
    try {
      sumatraPath = resolveSumatraPath();
    } catch (error) {
      throw new PrintFailure(
        'PRINT_PROGRAM_ERROR',
        'The Printer App could not prepare its print program. Reinstall the Printer App and try again.',
        `extracting ${SUMATRA_ASSET} failed: ${errorMessage(error)}`,
      );
    }

    logger.info(`Submitting ${filePath} to Windows spooler`, { printerName, sumatraPath, args });
    const started = Date.now();
    const { stdout, stderr } = await this.runSumatra(sumatraPath, args, printerName, before, marker);
    logger.info(`SumatraPDF handed the document to the spooler in ${Date.now() - started}ms`, {
      stdout: stdout.trim() || undefined,
      stderr: stderr.trim() || undefined,
    });

    const after = await this.snapshot(printerName, 'after printing');
    const queue = after?.printer ?? before?.printer ?? printerName;
    const found = findOurJob(before, after, marker);
    if (found === 'unknown') return { printerName: queue };
    if (found === 'gone') return null;
    return { printerName: queue, jobId: found };
  }

  /**
   * Runs SumatraPDF while watching the print queue. A slow job (a long PDF
   * being drawn page by page) is given time as long as it is reaching the
   * queue; a driver stuck on a hidden dialog (the agent runs as SYSTEM, with
   * no desktop) is stopped after SUMATRA_TIMEOUT_MS — and when nothing reached
   * the queue by then, the order is reported failed for certain rather than
   * "not confirmed".
   */
  private runSumatra(
    sumatraPath: string,
    args: string[],
    printerName: string | undefined,
    before: QueueSnapshot | null,
    marker: string,
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      let seenInQueue = false;
      let stopReason: 'nothing-queued' | 'too-long' | null = null;
      let watching = false;
      const child = execFile(sumatraPath, args, { windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        clearInterval(timer);
        if (stopReason === 'nothing-queued') {
          return reject(
            new PrintFailure(
              'DRIVER_NOT_RESPONDING',
              `The printer driver stopped responding before anything reached the print queue, so nothing was printed. Check the printer (and any message on this computer's screen), then print again.`,
              `SumatraPDF stopped after ${SUMATRA_TIMEOUT_MS / 60_000} min; no job of ours appeared in the queue of ${printerName ?? '(default printer)'}`,
            ),
          );
        }
        if (stopReason === 'too-long' || (error && (error.killed || error.signal) && !stopReason)) {
          return reject(
            new PrintOutcomeUnknownError(
              `The printer did not finish taking the order within ${Math.round((Date.now() - started) / 60_000)} minutes — it may or may not have printed. ` +
                'Check the printer before printing again.',
            ),
          );
        }
        if (error) return reject(Object.assign(error, { stdout, stderr }));
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      });

      const timer = setInterval(async () => {
        if (watching || stopReason) return;
        watching = true;
        try {
          if (!seenInQueue && before) {
            const now = await this.listJobs(printerName).catch(() => null);
            const found = findOurJob(before, now, marker);
            if (found !== 'unknown' && found !== 'gone') seenInQueue = true;
          }
          const elapsed = Date.now() - started;
          if (elapsed > SUMATRA_TIMEOUT_MS && !seenInQueue) {
            // Without a readable queue we can't say nothing was printed: stays "not confirmed".
            stopReason = before ? 'nothing-queued' : 'too-long';
            child.kill();
          } else if (elapsed > SUMATRA_MAX_MS) {
            stopReason = 'too-long';
            child.kill();
          }
        } finally {
          watching = false;
        }
      }, QUEUE_WATCH_INTERVAL_MS);
    });
  }

  async checkJob(ref: SpoolJobRef): Promise<SpoolJobStatus> {
    const stdout = await this.powershell(CHECK_JOB_SCRIPT, {
      PRINTSETU_PRINTER: ref.printerName ?? '',
      PRINTSETU_JOB_ID: ref.jobId ?? '',
    });
    return interpretWindowsJob(JSON.parse(stdout) as WindowsJobState);
  }

  /** The queue, read up to three times: one failed PowerShell call shouldn't leave the order unconfirmed. */
  private async snapshot(printerName: string | undefined, when: string): Promise<QueueSnapshot | null> {
    for (let attempt = 1; attempt <= SNAPSHOT_ATTEMPTS; attempt++) {
      try {
        return await this.listJobs(printerName);
      } catch (error) {
        logger.warn(`Could not read the print queue ${when} (try ${attempt}/${SNAPSHOT_ATTEMPTS}): ${errorMessage(error)}`);
        if (attempt < SNAPSHOT_ATTEMPTS) await new Promise((r) => setTimeout(r, 1000));
      }
    }
    return null;
  }

  private async listJobs(printerName: string | undefined): Promise<QueueSnapshot> {
    return parseQueueSnapshot(await this.powershell(LIST_JOBS_SCRIPT, { PRINTSETU_PRINTER: printerName ?? '' }));
  }

  private async powershell(script: string, env: Record<string, string>, timeout = DIAGNOSE_TIMEOUT_MS): Promise<string> {
    const { stdout } = await execFileAsync('Powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout,
      windowsHide: true,
      env: { ...process.env, ...env },
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim();
  }

  /**
   * The printers, the default one (the agent runs as SYSTEM — see
   * service/Install-Task.ps1 — which often has no default printer of its own:
   * then none is marked), and what each can do.
   */
  async listPrinters(): Promise<DetectedPrinter[]> {
    return parsePrinterList(await this.powershell(LIST_PRINTERS_SCRIPT, {}, LIST_PRINTERS_TIMEOUT_MS));
  }

  async diagnose(printerName: string | undefined): Promise<PrinterDiagnostics | undefined> {
    try {
      const { stdout } = await execFileAsync('Powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', DIAGNOSE_SCRIPT], {
        timeout: DIAGNOSE_TIMEOUT_MS,
        windowsHide: true,
        env: { ...process.env, PRINTSETU_DIAG_PRINTER: printerName ?? '' },
      });
      return interpretWindowsState(JSON.parse(stdout.trim()) as WindowsPrinterState);
    } catch (error) {
      logger.warn(`Could not check the printer's state after the failure: ${errorMessage(error)}`);
      return undefined;
    }
  }
}

function interpretWindowsState(state: WindowsPrinterState): PrinterDiagnostics {
  const problems = [
    state.extendedStatus != null ? EXTENDED_STATUS_PROBLEM[state.extendedStatus] : undefined,
    state.errorState != null ? DETECTED_ERROR_PROBLEM[state.errorState] : undefined,
  ].filter((p): p is string => !!p);
  return {
    spoolerRunning: state.spooler === 'Running',
    printerFound: state.found === true,
    // PrinterStatus/ExtendedPrinterStatus 7 and DetectedErrorState 9 all mean "offline".
    offline: state.workOffline === true || state.printerStatus === 7 || state.extendedStatus === 7 || state.errorState === 9,
    problem: problems.length ? problems.join(', ') : undefined,
    summary: JSON.stringify(state),
  };
}
