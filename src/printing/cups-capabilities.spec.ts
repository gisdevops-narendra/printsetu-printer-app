import { decodeReply, encodeGetPrinterAttributes } from './cups-ipp';
import { interpretPrinterAttributes } from './linux-printer-adapter';

jest.mock('../logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

/** Builds an IPP reply with a printer attribute group, as CUPS sends it. */
function reply(attrs: [number, string, string | number][], status = 0): Buffer {
  const parts: Buffer[] = [Buffer.from([2, 0, status >> 8, status & 0xff, 0, 0, 0, 1]), Buffer.from([0x04])];
  for (const [tag, name, value] of attrs) {
    const nameBuf = Buffer.from(name);
    const valueBuf = typeof value === 'number' ? Buffer.from([value]) : Buffer.from(value);
    const head = Buffer.alloc(3);
    head.writeUInt8(tag, 0);
    head.writeUInt16BE(nameBuf.length, 1);
    const len = Buffer.alloc(2);
    len.writeUInt16BE(valueBuf.length, 0);
    parts.push(head, nameBuf, len, valueBuf);
  }
  parts.push(Buffer.from([0x03]));
  return Buffer.concat(parts);
}

describe('CUPS printer abilities over IPP', () => {
  it('asks for the abilities of the named printer', () => {
    const body = encodeGetPrinterAttributes('Canon MF240', 'shop').toString('latin1');
    expect(body.slice(2, 4)).toBe('\x00\x0b');
    expect(body).toContain('ipp://localhost/printers/Canon%20MF240');
    expect(body).toContain('sides-supported');
    expect(body).toContain('media-supported');
  });

  it('reads duplex, colour and paper sizes', () => {
    const r = decodeReply(
      reply([
        [0x44, 'sides-supported', 'one-sided'],
        [0x44, '', 'two-sided-long-edge'],
        [0x44, 'print-color-mode-supported', 'monochrome'],
        [0x44, 'media-supported', 'iso_a4_210x297mm'],
        [0x44, '', 'na_letter_8.5x11in'],
        [0x44, '', 'na_executive_7.25x10.5in'],
      ]),
    );
    expect(interpretPrinterAttributes(r)).toEqual({ duplex: true, color: false, paperSizes: ['A4', 'LETTER'] });
  });

  it('falls back to color-supported, and leaves out what CUPS did not say', () => {
    const r = decodeReply(reply([[0x22, 'color-supported', 1]]));
    expect(interpretPrinterAttributes(r)).toEqual({ color: true });
  });

  it('knows nothing for a printer CUPS refused to describe', () => {
    expect(interpretPrinterAttributes(decodeReply(reply([], 0x0406)))).toBeUndefined();
    expect(interpretPrinterAttributes(decodeReply(reply([])))).toBeUndefined();
  });
});
