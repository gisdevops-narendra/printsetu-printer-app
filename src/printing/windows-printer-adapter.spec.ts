import { findOurJob, parsePrinterList, parseQueueSnapshot } from './windows-printer-adapter';

jest.mock('../logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const snap = (...jobs: [number, string][]) => ({ printer: 'HP', jobs: jobs.map(([id, document]) => ({ id, document })) });
const marker = 'job-1-doc-1';

describe('findOurJob — which new print-queue job is ours', () => {
  it('picks the new job named after our file, even when another program printed meanwhile', () => {
    const before = snap([3, 'Report.docx']);
    const after = snap([3, 'Report.docx'], [4, `C:\\PrintSetu\\downloads\\${marker}.pdf`], [5, 'Invoice - Word']);
    expect(findOurJob(before, after, marker)).toBe('4');
  });

  it('takes a single new job as ours when nothing names it', () => {
    expect(findOurJob(snap(), snap([9, '']), marker)).toBe('9');
  });

  it('refuses to guess between several unnamed new jobs', () => {
    expect(findOurJob(snap(), snap([9, 'Word'], [10, 'Excel']), marker)).toBe('unknown');
  });

  it('says the job already left the queue when nothing new is there', () => {
    expect(findOurJob(snap([1, 'x']), snap([1, 'x']), marker)).toBe('gone');
  });

  it('cannot tell without both looks at the queue', () => {
    expect(findOurJob(null, snap([9, marker]), marker)).toBe('unknown');
    expect(findOurJob(snap(), null, marker)).toBe('unknown');
  });
});

describe('PowerShell output parsing', () => {
  it('reads one job, several jobs or none (ConvertTo-Json gives an object / array / null)', () => {
    expect(parseQueueSnapshot('{"printer":"HP","jobs":{"id":4,"document":"a.pdf"}}').jobs).toEqual([{ id: 4, document: 'a.pdf' }]);
    expect(parseQueueSnapshot('{"printer":"HP","jobs":[{"id":4,"document":"a"},{"id":5,"document":null}]}').jobs).toEqual([
      { id: 4, document: 'a' },
      { id: 5, document: '' },
    ]);
    expect(parseQueueSnapshot('{"printer":"HP","jobs":null}').jobs).toEqual([]);
  });

  it("lists printers with what their drivers say they can do, in PrintSetu's paper names", () => {
    const out = JSON.stringify([
      { name: 'HP LaserJet', isDefault: true, valid: true, duplex: false, color: false, paper: ['A4', 'Letter', 'Legal', 'Executive', 'A4'] },
      { name: 'Epson', isDefault: false, valid: true, duplex: true, color: true, paper: 'A3' },
      { name: 'Broken driver', isDefault: false, valid: false, duplex: null, color: null, paper: [] },
    ]);
    expect(parsePrinterList(out)).toEqual([
      { name: 'HP LaserJet', isDefault: true, capabilities: { duplex: false, color: false, paperSizes: ['A4', 'LETTER', 'LEGAL'] } },
      { name: 'Epson', isDefault: false, capabilities: { duplex: true, color: true, paperSizes: ['A3'] } },
      { name: 'Broken driver', isDefault: false },
    ]);
  });

  it('reads a single printer (an object, not an array) and no printers', () => {
    expect(parsePrinterList('{"name":"Only","isDefault":false,"valid":true,"duplex":true,"color":false,"paper":[]}')).toEqual([
      { name: 'Only', isDefault: false, capabilities: { duplex: true, color: false } },
    ]);
    expect(parsePrinterList('')).toEqual([]);
  });
});
