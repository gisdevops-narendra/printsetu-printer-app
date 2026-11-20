import { assertPrinterCanPrint } from './capability-check';
import { PrintFailure } from './print-failure';

const doc = (name: string, paperSize = 'A4', colorMode = 'BW', sideMode = 'SIMPLEX') => ({
  originalName: name,
  options: { paperSize, colorMode, sideMode },
});

describe('assertPrinterCanPrint', () => {
  it('fails safely, naming the printer, the problem and the files', () => {
    let error: unknown;
    try {
      assertPrinterCanPrint('HP', { duplex: false, color: false, paperSizes: ['A4'] }, [
        doc('cv.pdf', 'A4', 'BW', 'DUPLEX'),
        doc('photo.jpg', 'A4', 'COLOR'),
        doc('deed.pdf', 'LEGAL'),
      ]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(PrintFailure);
    expect((error as PrintFailure).code).toBe('PRINTER_CANNOT_PRINT_OPTION');
    expect((error as PrintFailure).message).toContain(`"HP" can't print double-sided ("cv.pdf")`);
    expect((error as PrintFailure).message).toContain('"HP" prints only in black & white ("photo.jpg")');
    expect((error as PrintFailure).message).toContain('"HP" has no Legal paper size ("deed.pdf")');
  });

  it('lets through what the printer can do and anything it did not report', () => {
    expect(() => assertPrinterCanPrint('E', { duplex: true, color: true, paperSizes: ['A4'] }, [doc('a', 'A4', 'COLOR', 'DUPLEX')])).not.toThrow();
    expect(() => assertPrinterCanPrint('E', undefined, [doc('a', 'A3', 'COLOR', 'DUPLEX')])).not.toThrow();
    expect(() => assertPrinterCanPrint('E', {}, [doc('a', 'A3', 'COLOR', 'DUPLEX')])).not.toThrow();
  });
});
