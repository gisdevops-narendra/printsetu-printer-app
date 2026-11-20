import { PrinterCapabilities } from './printer-adapter.interface';
import { PrintFailure } from './print-failure';

const PAPER_LABEL: Record<string, string> = { A4: 'A4', A3: 'A3', LETTER: 'Letter', LEGAL: 'Legal' };

interface OrderedDocument {
  originalName: string;
  options: { paperSize: string; colorMode: string; sideMode: string };
}

/**
 * Fails safely (SRS §13.2) before anything prints when the printer's driver
 * clearly says it can't do what the order asks — rather than the driver
 * quietly printing one-sided or in colour-less ink. The backend checks the
 * same before sending; this catches orders picked up by polling, or a printer
 * changed since its last report. Unknown abilities block nothing.
 */
export function assertPrinterCanPrint(
  printerName: string | undefined,
  capabilities: PrinterCapabilities | undefined,
  documents: OrderedDocument[],
): void {
  if (!capabilities) return;
  const name = printerName ?? 'This printer';
  const list = (filter: (d: OrderedDocument) => boolean) =>
    documents.filter(filter).map((d) => `"${d.originalName}"`).join(', ');
  const problems: string[] = [];

  const duplex = list((d) => d.options.sideMode === 'DUPLEX');
  if (capabilities.duplex === false && duplex) {
    problems.push(`"${name}" can't print double-sided (${duplex}).`);
  }
  const color = list((d) => d.options.colorMode === 'COLOR');
  if (capabilities.color === false && color) {
    problems.push(`"${name}" prints only in black & white (${color}).`);
  }
  const sizes = capabilities.paperSizes;
  if (sizes?.length) {
    for (const size of new Set(documents.map((d) => d.options.paperSize))) {
      if (sizes.includes(size)) continue;
      problems.push(`"${name}" has no ${PAPER_LABEL[size] ?? size} paper size (${list((d) => d.options.paperSize === size)}).`);
    }
  }
  if (problems.length) {
    throw new PrintFailure(
      'PRINTER_CANNOT_PRINT_OPTION',
      `${problems.join(' ')} Choose another printer, or change the order's settings, then print again.`,
      `printer capabilities: ${JSON.stringify(capabilities)}`,
    );
  }
}
