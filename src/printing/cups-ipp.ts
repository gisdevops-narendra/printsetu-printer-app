import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';

/**
 * Just enough IPP (RFC 8010/8011) to ask the local CUPS scheduler about one
 * job: a Get-Job-Attributes request and a decoder for the reply. `lpstat`
 * only says whether a job is still queued; IPP also says how it ended
 * (completed / cancelled / aborted) and why it is stopped.
 */

const CUPS_SOCKETS = ['/run/cups/cups.sock', '/var/run/cups/cups.sock'];
const REQUEST_TIMEOUT_MS = 10_000;

const TAG = {
  operationAttributes: 0x01,
  end: 0x03,
  integer: 0x21,
  boolean: 0x22,
  enum: 0x23,
  keyword: 0x44,
  uri: 0x45,
  charset: 0x47,
  naturalLanguage: 0x48,
  nameWithoutLanguage: 0x42,
} as const;

const GET_JOB_ATTRIBUTES = 0x0009;
const GET_PRINTER_ATTRIBUTES = 0x000b;
/** IPP status 0x0406: no such job (e.g. CUPS doesn't keep job history). */
export const IPP_NOT_FOUND = 0x0406;

export const JOB_ATTRIBUTES = [
  'job-state',
  'job-state-reasons',
  'job-printer-state-message',
  'job-printer-state-reasons',
  // Progress, when the printer/filters report it: pages (impressions) done and in total.
  'job-impressions-completed',
  'job-impressions',
] as const;

/** What a printer can do: two-sided, colour, paper sizes. */
export const PRINTER_ATTRIBUTES = ['sides-supported', 'print-color-mode-supported', 'color-supported', 'media-supported'] as const;

export type IppValue = number | string;
export interface IppReply {
  statusCode: number;
  /** Attributes of the job group; multi-valued ones have several entries. */
  attributes: Record<string, IppValue[]>;
}

function attribute(tag: number, name: string, value: Buffer | string): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  const valueBuf = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  const head = Buffer.alloc(3);
  head.writeUInt8(tag, 0);
  head.writeUInt16BE(nameBuf.length, 1);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(valueBuf.length, 0);
  return Buffer.concat([head, nameBuf, len, valueBuf]);
}

export function encodeGetJobAttributes(jobId: number, user: string, requestId = 1): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt8(2, 0); // IPP 2.0
  header.writeUInt8(0, 1);
  header.writeUInt16BE(GET_JOB_ATTRIBUTES, 2);
  header.writeUInt32BE(requestId, 4);
  const [first, ...rest] = JOB_ATTRIBUTES;
  return Buffer.concat([
    header,
    Buffer.from([TAG.operationAttributes]),
    attribute(TAG.charset, 'attributes-charset', 'utf-8'),
    attribute(TAG.naturalLanguage, 'attributes-natural-language', 'en'),
    attribute(TAG.uri, 'job-uri', `ipp://localhost/jobs/${jobId}`),
    attribute(TAG.nameWithoutLanguage, 'requesting-user-name', user),
    attribute(TAG.keyword, 'requested-attributes', first),
    // Additional values of the same attribute carry an empty name.
    ...rest.map((name) => attribute(TAG.keyword, '', name)),
    Buffer.from([TAG.end]),
  ]);
}

export function decodeReply(buf: Buffer): IppReply {
  if (buf.length < 8) throw new Error(`IPP reply too short (${buf.length} bytes)`);
  const statusCode = buf.readUInt16BE(2);
  const attributes: Record<string, IppValue[]> = {};
  let offset = 8;
  let lastName = '';
  while (offset < buf.length) {
    const tag = buf.readUInt8(offset);
    offset += 1;
    if (tag === TAG.end) break;
    if (tag < 0x10) continue; // start of another attribute group
    const nameLen = buf.readUInt16BE(offset);
    offset += 2;
    const name = buf.toString('utf8', offset, offset + nameLen);
    offset += nameLen;
    const valueLen = buf.readUInt16BE(offset);
    offset += 2;
    const raw = buf.subarray(offset, offset + valueLen);
    offset += valueLen;
    if (name) lastName = name;
    const value: IppValue =
      (tag === TAG.integer || tag === TAG.enum) && valueLen === 4
        ? raw.readInt32BE(0)
        : tag === TAG.boolean && valueLen === 1
          ? raw.readUInt8(0)
          : raw.toString('utf8');
    (attributes[lastName] ??= []).push(value);
  }
  return { statusCode, attributes };
}

export function encodeGetPrinterAttributes(printerName: string, user: string, requestId = 1): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt8(2, 0); // IPP 2.0
  header.writeUInt8(0, 1);
  header.writeUInt16BE(GET_PRINTER_ATTRIBUTES, 2);
  header.writeUInt32BE(requestId, 4);
  const [first, ...rest] = PRINTER_ATTRIBUTES;
  return Buffer.concat([
    header,
    Buffer.from([TAG.operationAttributes]),
    attribute(TAG.charset, 'attributes-charset', 'utf-8'),
    attribute(TAG.naturalLanguage, 'attributes-natural-language', 'en'),
    attribute(TAG.uri, 'printer-uri', `ipp://localhost/printers/${encodeURIComponent(printerName)}`),
    attribute(TAG.nameWithoutLanguage, 'requesting-user-name', user),
    attribute(TAG.keyword, 'requested-attributes', first),
    ...rest.map((name) => attribute(TAG.keyword, '', name)),
    Buffer.from([TAG.end]),
  ]);
}

/** Sends one IPP request to the local CUPS scheduler: its Unix socket when present, else localhost:631. */
function post(body: Buffer, path = '/jobs/'): Promise<Buffer> {
  const socketPath = CUPS_SOCKETS.find((p) => fs.existsSync(p));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        ...(socketPath ? { socketPath } : { host: 'localhost', port: 631 }),
        method: 'POST',
        path,
        headers: { Host: 'localhost', 'Content-Type': 'application/ipp', 'Content-Length': body.length },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          res.statusCode === 200 ? resolve(Buffer.concat(chunks)) : reject(new Error(`CUPS answered HTTP ${res.statusCode}`)),
        );
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`CUPS did not answer within ${REQUEST_TIMEOUT_MS / 1000}s`)));
    req.on('error', reject);
    req.end(body);
  });
}

export async function getJobAttributes(jobId: number): Promise<IppReply> {
  return decodeReply(await post(encodeGetJobAttributes(jobId, os.userInfo().username)));
}

export async function getPrinterAttributes(printerName: string): Promise<IppReply> {
  return decodeReply(await post(encodeGetPrinterAttributes(printerName, os.userInfo().username), '/printers/'));
}
