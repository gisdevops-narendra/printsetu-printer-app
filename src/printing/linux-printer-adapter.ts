import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  DetectedPrinter,
  PrinterAdapter,
  PrinterCapabilities,
  PrintOptions,
  PrintOutcomeUnknownError,
  SpoolJobRef,
  SpoolJobStatus,
} from './printer-adapter.interface';
import { errorMessage, PrinterDiagnostics } from './print-failure';
import { getJobAttributes, getPrinterAttributes, IPP_NOT_FOUND, IppReply } from './cups-ipp';
import { logger } from '../logger';

const execFileAsync = promisify(execFile);
const LP_TIMEOUT_MS = 30_000;

// CUPS/IPP standard "media" keywords for the backend's PaperSize enum.
const MEDIA: Record<string, string> = {
  A4: 'A4',
  A3: 'A3',
  LETTER: 'Letter',
  LEGAL: 'Legal',
};

async function run(command: string, args: string[]): Promise<string> {
  // LANG=C keeps lpstat's output in English so the parsing below is stable
  // on shop PCs set to a non-English locale.
  const { stdout } = await execFileAsync(command, args, {
    timeout: LP_TIMEOUT_MS,
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
  });
  return stdout;
}

/**
 * A timed-out `lp` becomes PrintOutcomeUnknownError; any other failure is
 * passed on untouched so its exit code, stderr and command line reach the
 * failure report (see classifyPrintError).
 */
function describeFailure(error: unknown): unknown {
  const e = error as { killed?: boolean; signal?: string | null };
  if (e.killed || e.signal) {
    return new PrintOutcomeUnknownError(
      `CUPS did not answer within ${LP_TIMEOUT_MS / 1000}s — the printer may or may not have received the order. ` +
        'Check the printer before printing again.',
    );
  }
  return error;
}

/** `lp` answers "request id is Canon_MF240-123 (1 file(s))". */
export function parseLpRequestId(stdout: string): SpoolJobRef | null {
  const match = /request id is (\S+)-(\d+)/.exec(stdout);
  return match ? { printerName: match[1], jobId: match[2] } : null;
}

// IPP printer/job state reasons that stop printing, in the shopkeeper's words.
const CUPS_REASON_PROBLEM: [RegExp, string][] = [
  [/^media-(empty|needed)$/, 'out of paper'],
  [/^media-jam$/, 'paper jam'],
  [/^(door|cover|interlock)-open$/, 'a door or cover is open'],
  [/^(toner|marker-supply)-empty$/, 'out of toner or ink'],
  [/^(offline|connecting-to-device|timed-out|printer-not-connected)$/, 'the printer is offline or not connected'],
  [/^(printer-stopped|paused)$/, 'the printer is paused in CUPS'],
];

/** Plain-language problem from IPP reasons; "-warning"/"-report" reasons (e.g. toner low) don't stop printing. */
function cupsProblem(reasons: string[]): string | undefined {
  for (const reason of reasons) {
    if (/-(warning|report)$/.test(reason)) continue;
    const bare = reason.replace(/-error$/, '');
    const hit = CUPS_REASON_PROBLEM.find(([pattern]) => pattern.test(bare));
    if (hit) return hit[1];
  }
  return undefined;
}

/** IPP job-state (RFC 8011 §5.3.7) plus reasons -> where the job is. */
export function interpretCupsJob(reply: IppReply): SpoolJobStatus {
  if (reply.statusCode === IPP_NOT_FOUND) return { state: 'gone', detail: 'CUPS: job not found' };
  if (reply.statusCode > 0xff) throw new Error(`CUPS refused the job query (IPP status 0x${reply.statusCode.toString(16)})`);
  const a = reply.attributes;
  const jobState = Number(a['job-state']?.[0]);
  const reasons = [...(a['job-state-reasons'] ?? []), ...(a['job-printer-state-reasons'] ?? [])].map(String);
  const message = a['job-printer-state-message']?.[0];
  const problem = cupsProblem(reasons);
  const count = (name: string) => (typeof a[name]?.[0] === 'number' ? (a[name][0] as number) : undefined);
  const done = count('job-impressions-completed');
  const total = count('job-impressions');
  const pages = { pagesDone: done, pagesTotal: total && total > 0 ? total : undefined };
  const detail =
    `CUPS job-state ${jobState}; reasons ${reasons.join(',') || 'none'}` +
    `${done !== undefined ? `; pages ${done}/${total ?? '?'}` : ''}${message ? `; "${message}"` : ''}`;
  switch (jobState) {
    case 3: // pending
      return { state: problem ? 'paused' : 'waiting', problem, detail, ...pages };
    case 4: // pending-held
      return { state: 'paused', problem: problem ?? 'held in the print queue', detail, ...pages };
    case 5: // processing — still "processing" while the printer waits for paper
      return { state: problem ? 'paused' : 'printing', problem, detail, ...pages };
    case 6: // processing-stopped
      return { state: 'paused', problem: problem ?? 'the printer has stopped', detail, ...pages };
    case 7:
      return { state: 'cancelled', detail, ...pages };
    case 8: // aborted by the system
      return { state: 'failed', problem: problem ?? (message ? String(message) : undefined), detail, ...pages };
    case 9:
      return { state: 'completed', detail, ...pages };
    default:
      throw new Error(`CUPS returned no job state (${detail})`);
  }
}

const PWG_MEDIA: [RegExp, string][] = [
  [/^iso_a4_/, 'A4'],
  [/^iso_a3_/, 'A3'],
  [/^na_letter_/, 'LETTER'],
  [/^na_legal_/, 'LEGAL'],
];

/** IPP printer attributes -> what the printer can do; a field is left out when CUPS didn't say. */
export function interpretPrinterAttributes(reply: IppReply): PrinterCapabilities | undefined {
  if (reply.statusCode > 0xff) return undefined;
  const a = reply.attributes;
  const capabilities: PrinterCapabilities = {};
  const sides = a['sides-supported']?.map(String);
  if (sides?.length) capabilities.duplex = sides.some((s) => s.startsWith('two-sided'));
  const colorModes = a['print-color-mode-supported']?.map(String);
  if (colorModes?.length) capabilities.color = colorModes.some((m) => m === 'color' || m === 'auto-color' || m === 'process-color');
  else if (a['color-supported']?.length) capabilities.color = Number(a['color-supported'][0]) === 1;
  const media = a['media-supported']?.map(String) ?? [];
  const sizes = [...new Set(media.map((m) => PWG_MEDIA.find(([re]) => re.test(m))?.[1]).filter((s): s is string => !!s))];
  if (sizes.length) capabilities.paperSizes = sizes;
  return Object.keys(capabilities).length ? capabilities : undefined;
}

/**
 * Linux counterpart of WindowsPrinterAdapter: submits through CUPS with the
 * standard `lp`/`lpstat` client tools (present on every desktop Ubuntu/
 * Debian/Fedora install, package `cups-client`). CUPS's own filters handle
 * PDF, PNG and JPEG, so no bundled renderer is needed.
 */
export class LinuxPrinterAdapter implements PrinterAdapter {
  async print(filePath: string, printerName: string | undefined, options: PrintOptions): Promise<SpoolJobRef> {
    const args: string[] = [];
    if (printerName) args.push('-d', printerName);
    args.push('-n', String(Math.max(1, options.copies)));
    const media = MEDIA[options.paperSize];
    if (media) args.push('-o', `media=${media}`);
    args.push('-o', `sides=${options.sideMode === 'DUPLEX' ? 'two-sided-long-edge' : 'one-sided'}`);
    if (options.colorMode === 'BW') args.push('-o', 'print-color-mode=monochrome');
    args.push('--', filePath);

    logger.info(`Submitting ${filePath} to CUPS`, { printerName, args });
    const stdout = await run('lp', args).catch((error) => {
      throw describeFailure(error);
    });
    logger.info(`CUPS accepted job: ${stdout.trim()}`);
    return parseLpRequestId(stdout) ?? { printerName };
  }

  /**
   * Asks CUPS over IPP how the job is doing; if that fails, falls back to
   * `lpstat -o`, which can only say "still queued" or "gone".
   */
  async checkJob(ref: SpoolJobRef): Promise<SpoolJobStatus> {
    const id = Number(ref.jobId);
    try {
      return interpretCupsJob(await getJobAttributes(id));
    } catch (ippError) {
      const queued = await run('lpstat', ref.printerName ? ['-o', ref.printerName] : ['-o']);
      const listed = queued.split('\n').some((line) => line.split(/\s+/)[0]?.endsWith(`-${id}`));
      return {
        state: listed ? 'printing' : 'gone',
        detail: `lpstat -o: job ${listed ? 'still queued' : 'not listed'} (IPP failed: ${errorMessage(ippError)})`,
      };
    }
  }

  async listPrinters(): Promise<DetectedPrinter[]> {
    // `lpstat -e` lists every destination name, one per line; `lpstat -d`
    // prints either "system default destination: NAME" or "no system
    // default destination". A CUPS install with zero printers makes
    // `lpstat -e` exit non-zero on some versions, which just means "none".
    const [names, defaultOut] = await Promise.all([
      run('lpstat', ['-e']).catch(() => ''),
      run('lpstat', ['-d']).catch(() => ''),
    ]);
    const defaultName = /system default destination:\s*(\S+)/.exec(defaultOut)?.[1];
    const list = names
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    return Promise.all(
      list.map(async (name) => {
        // What it can do, when CUPS can say (a printer that's gone or unreachable just has none).
        const capabilities = await getPrinterAttributes(name)
          .then(interpretPrinterAttributes)
          .catch(() => undefined);
        return { name, isDefault: name === defaultName, ...(capabilities ? { capabilities } : {}) };
      }),
    );
  }

  async diagnose(printerName: string | undefined): Promise<PrinterDiagnostics | undefined> {
    try {
      // lpstat exits non-zero for an unknown printer — keep its stderr as the answer.
      const capture = (args: string[]) => run('lpstat', args).catch((error) => (error as { stderr?: string }).stderr || errorMessage(error));
      const name = printerName ?? /system default destination:\s*(\S+)/.exec(await capture(['-d']))?.[1];
      const [scheduler, printer, accepting] = await Promise.all([
        capture(['-r']),
        name ? capture(['-p', name]) : Promise.resolve(''),
        // "enabled" (lpstat -p) and "accepting" (lpstat -a) are separate CUPS switches;
        // a queue can be enabled yet still reject every new job.
        name ? capture(['-a', name]) : Promise.resolve(''),
      ]);
      const disabled = /\bdisabled\b/.test(printer);
      // `lpstat -p` puts the reason a printer was disabled on the following indented line.
      const reason = disabled ? printer.split('\n').slice(1).join(' ').trim() : '';
      return {
        spoolerRunning: !/not running/.test(scheduler),
        printerFound: name ? !/invalid destination|unknown destination|does not exist/i.test(printer) : undefined,
        offline: /offline|not connected|unplugged/i.test(printer),
        rejecting: /not accepting/i.test(accepting),
        problem: disabled ? `paused in CUPS${reason ? ` (${reason})` : ''}` : undefined,
        summary: [scheduler, printer, accepting].map((part) => part.trim().replace(/\s+/g, ' ')).filter(Boolean).join(' | '),
      };
    } catch (error) {
      logger.warn(`Could not check the printer's state after the failure: ${errorMessage(error)}`);
      return undefined;
    }
  }
}
