/**
 * Reading card-machine exports from any provider (Yoco, iKhokha, Adumo, the
 * banks…) in the browser: CSV with commas, semicolons or tabs; dates in
 * South African, ISO or written-out form; amounts like "R 1 234,50".
 * The rows are sent to the server, which matches them to card sales.
 */

export type CardColumn = 'date' | 'time' | 'amount' | 'reference' | 'status' | 'last4' | 'terminal';

export interface CardRow {
  atMillis: number;
  amountCents: number;
  reference?: string;
  status?: string;
  last4?: string;
  terminal?: string;
}

/** businesses/{b}/cardTransactions/{id} – a card-machine payment, written by the server. */
export interface CardTransaction extends CardRow {
  id: string;
  provider: string;
  source: 'upload' | 'webhook';
  approved: boolean;
  dayKey: string;
  matchedSaleId: string | null;
  matchedBy?: string;
}

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
}

export const PROVIDERS = ['Yoco', 'iKhokha', 'Adumo', 'Paycorp', 'SnapScan', 'Zapper', 'FNB', 'Standard Bank', 'Absa', 'Nedbank', 'Capitec', 'Other'];

/** Splits CSV text into a header row and data rows (quotes, doubled quotes and line breaks inside quotes are handled). */
export function parseCsv(text: string): ParsedCsv {
  const clean = text.replace(/^﻿/, '');
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? '';
  const counts = { ',': (firstLine.match(/,/g) ?? []).length, ';': (firstLine.match(/;/g) ?? []).length, '\t': (firstLine.match(/\t/g) ?? []).length };
  const sep = (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? ',') as ',' | ';' | '\t';
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (quoted) {
      if (c === '"' && clean[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === sep) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && clean[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f.trim() !== '')) out.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) out.push(row);
  const [headers = [], ...rows] = out;
  return { headers: headers.map((h) => h.trim()), rows: rows.map((r) => r.map((f) => f.trim())) };
}

const GUESS: [CardColumn, RegExp][] = [
  ['time', /^(time|txn time|transaction time)$/i],
  ['date', /date|timestamp|created|processed|when/i],
  ['amount', /amount|value|total|gross|price/i],
  ['reference', /ref|auth|approval|rrn|receipt|transaction id|txn id|^id$/i],
  ['status', /status|result|response|outcome|state/i],
  ['last4', /card|pan|last ?4|masked/i],
  ['terminal', /terminal|device|tid|machine/i],
];

/** Which header holds what, guessed from the names (column index, or -1). */
export function guessColumns(headers: string[]): Record<CardColumn, number> {
  const map: Record<CardColumn, number> = { date: -1, time: -1, amount: -1, reference: -1, status: -1, last4: -1, terminal: -1 };
  const taken = new Set<number>();
  for (const [col, re] of GUESS) {
    const i = headers.findIndex((h, idx) => !taken.has(idx) && re.test(h));
    if (i >= 0) {
      map[col] = i;
      taken.add(i);
    }
  }
  return map;
}

/** "R 1 234,50", "1,234.50", "45.5", "-35.00", "(35.00)" → cents; null if it isn't a number. */
export function parseAmount(text: string): number | null {
  let s = text.replace(/[R\s ]|ZAR/gi, '');
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1);
  }
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let decimalSep: ',' | '.' | null = null;
  if (lastComma >= 0 && lastDot >= 0) decimalSep = lastComma > lastDot ? ',' : '.';
  else if (lastComma >= 0) decimalSep = s.length - lastComma - 1 <= 2 ? ',' : null;
  else if (lastDot >= 0) decimalSep = s.length - lastDot - 1 <= 2 ? '.' : null;
  const digits = decimalSep ? s.slice(0, s.lastIndexOf(decimalSep)).replace(/[.,]/g, '') + '.' + s.slice(s.lastIndexOf(decimalSep) + 1) : s.replace(/[.,]/g, '');
  const value = Number(digits);
  if (!Number.isFinite(value)) return null;
  const cents = Math.round(value * 100);
  return negative ? -cents : cents;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/**
 * Local date/time in the shop's usual forms → epoch millis (in this device's
 * time zone, which is the shop's). Day comes before month (South African style).
 */
export function parseDateTime(date: string, time = ''): number | null {
  const s = `${date} ${time}`.trim().replace(/\s+/g, ' ');
  if (/^\d{4}-\d{2}-\d{2}T/.test(s) && /(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }
  let y: number, mo: number, d: number;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[ T]?(.*)$/.exec(s);
  let rest = '';
  if (m) {
    [y, mo, d, rest] = [Number(m[1]), Number(m[2]), Number(m[3]), m[4]];
  } else if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})[ T]?(.*)$/.exec(s))) {
    [d, mo, y, rest] = [Number(m[1]), Number(m[2]), Number(m[3]), m[4]];
  } else if ((m = /^(\d{1,2}) ([A-Za-z]{3})[a-z]* (\d{4}),? ?(.*)$/.exec(s))) {
    [d, mo, y, rest] = [Number(m[1]), MONTHS[m[2].toLowerCase()] ?? 0, Number(m[3]), m[4]];
  } else {
    return null;
  }
  if (y < 100) y += 2000;
  const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i.exec(rest.trim());
  let h = tm ? Number(tm[1]) : 0;
  const min = tm ? Number(tm[2]) : 0;
  const sec = tm?.[3] ? Number(tm[3]) : 0;
  if (tm?.[4]) h = (h % 12) + (tm[4].toLowerCase() === 'pm' ? 12 : 0);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || min > 59) return null;
  const at = new Date(y, mo - 1, d, h, min, sec);
  return at.getMonth() === mo - 1 ? at.getTime() : null;
}

export interface Converted {
  rows: CardRow[];
  /** "row 7: no amount" … */
  problems: string[];
}

/** Turns CSV rows into card rows using the column choice; rows that can't be read are listed, not guessed. */
export function toCardRows(csv: ParsedCsv, cols: Record<CardColumn, number>): Converted {
  const rows: CardRow[] = [];
  const problems: string[] = [];
  csv.rows.forEach((r, i) => {
    const cell = (c: CardColumn) => (cols[c] >= 0 ? (r[cols[c]] ?? '').trim() : '');
    const at = parseDateTime(cell('date'), cell('time'));
    const amount = parseAmount(cell('amount'));
    if (at === null) return void problems.push(`row ${i + 2}: can't read the date "${`${cell('date')} ${cell('time')}`.trim()}"`);
    if (amount === null) return void problems.push(`row ${i + 2}: can't read the amount "${cell('amount')}"`);
    const last4 = cell('last4').replace(/\D/g, '').slice(-4);
    rows.push({
      atMillis: at,
      amountCents: amount,
      ...(cell('reference') ? { reference: cell('reference') } : {}),
      ...(cell('status') ? { status: cell('status') } : {}),
      ...(last4 ? { last4 } : {}),
      ...(cell('terminal') ? { terminal: cell('terminal') } : {}),
    });
  });
  return { rows, problems };
}
