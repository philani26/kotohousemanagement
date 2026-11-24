import { describe, expect, it } from 'vitest';
import { guessColumns, parseAmount, parseCsv, parseDateTime, toCardRows } from './cards';

describe('parseAmount', () => {
  it('reads South African and international formats', () => {
    expect(parseAmount('R 45,50')).toBe(4550);
    expect(parseAmount('R1 234,50')).toBe(123450);
    expect(parseAmount('1,234.50')).toBe(123450);
    expect(parseAmount('1.234,50')).toBe(123450);
    expect(parseAmount('35')).toBe(3500);
    expect(parseAmount('45.5')).toBe(4550);
    expect(parseAmount('ZAR 80.00')).toBe(8000);
  });
  it('keeps refunds negative and rejects text', () => {
    expect(parseAmount('-35.00')).toBe(-3500);
    expect(parseAmount('(35.00)')).toBe(-3500);
    expect(parseAmount('approved')).toBeNull();
    expect(parseAmount('')).toBeNull();
  });
});

describe('parseDateTime', () => {
  it('reads the usual export formats, day before month', () => {
    const expected = new Date(2026, 10, 24, 14, 5, 0).getTime();
    expect(parseDateTime('2026-11-24 14:05:00')).toBe(expected);
    expect(parseDateTime('2026/11/24', '14:05')).toBe(expected);
    expect(parseDateTime('24/11/2026 14:05')).toBe(expected);
    expect(parseDateTime('24-11-2026', '02:05 PM')).toBe(expected);
    expect(parseDateTime('24 Nov 2026 14:05')).toBe(expected);
    expect(parseDateTime('24 November 2026, 14:05')).toBe(expected);
  });
  it('respects an explicit time zone and rejects nonsense', () => {
    expect(parseDateTime('2026-11-24T12:05:00Z')).toBe(Date.UTC(2026, 10, 24, 12, 5));
    expect(parseDateTime('31/02/2026')).toBeNull();
    expect(parseDateTime('yesterday')).toBeNull();
  });
});

describe('reading a provider export', () => {
  it('splits quoted CSV with any separator and guesses the columns', () => {
    const semicolon = parseCsv('﻿Transaction Date;Time;Amount;Status;Auth Code;Card Number\r\n24/11/2026;14:05;R 35,00;Approved;"A1;2";****1234\r\n');
    expect(semicolon.headers).toEqual(['Transaction Date', 'Time', 'Amount', 'Status', 'Auth Code', 'Card Number']);
    expect(semicolon.rows[0][4]).toBe('A1;2');
    const cols = guessColumns(semicolon.headers);
    expect(cols).toMatchObject({ date: 0, time: 1, amount: 2, status: 3, reference: 4, last4: 5 });

    const { rows, problems } = toCardRows(semicolon, cols);
    expect(problems).toEqual([]);
    expect(rows).toEqual([{ atMillis: new Date(2026, 10, 24, 14, 5).getTime(), amountCents: 3500, status: 'Approved', reference: 'A1;2', last4: '1234' }]);
  });

  it('lists rows it cannot read instead of guessing', () => {
    const csv = parseCsv('date,amount\n2026-11-24 10:00,45.00\nnot a date,45.00\n2026-11-24 11:00,n/a\n');
    const { rows, problems } = toCardRows(csv, guessColumns(csv.headers));
    expect(rows).toHaveLength(1);
    expect(problems).toEqual(['row 3: can\'t read the date "not a date"', 'row 4: can\'t read the amount "n/a"']);
  });
});
