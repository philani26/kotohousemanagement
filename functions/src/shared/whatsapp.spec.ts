import { describe, expect, it } from 'vitest';
import { BotContext, EMPTY_CHAT, displayPhone, handleIncoming, parseOrderText, statusMessage } from './whatsapp';

const ctx: BotContext = {
  shopName: 'Mzansi Kota',
  open: true,
  openingText: 'We open at 9:00.',
  menu: [
    { productId: 'basic', name: 'Basic Kota', priceCents: 3000 },
    { productId: 'russian', name: 'Russian Kota', priceCents: 4500 },
    { productId: 'drink', name: 'Cold drink', priceCents: 1500 },
  ],
};

describe('parseOrderText', () => {
  it('reads item numbers with quantities', () => {
    expect(parseOrderText('2x2, 3')).toEqual([{ item: 2, quantity: 2 }, { item: 3, quantity: 1 }]);
    expect(parseOrderText('1 x 3 and 3')).toEqual([{ item: 1, quantity: 3 }, { item: 3, quantity: 1 }]);
    expect(parseOrderText('2×2')).toEqual([{ item: 2, quantity: 2 }]);
  });
  it('ignores ordinary chat', () => {
    expect(parseOrderText('hello')).toBeNull();
    expect(parseOrderText('can I get a kota')).toBeNull();
    expect(parseOrderText('')).toBeNull();
  });
});

describe('handleIncoming', () => {
  it('greets with the numbered menu', () => {
    const r = handleIncoming('Hi', EMPTY_CHAT, ctx);
    expect(r.replies[0]).toContain('1. Basic Kota');
    expect(r.replies[0]).toContain('3. Cold drink');
  });

  it('builds a draft, shows the total and asks to confirm', () => {
    const r = handleIncoming('2x2, 3', EMPTY_CHAT, ctx);
    expect(r.state.step).toBe('confirming');
    expect(r.state.draft).toEqual([
      { productId: 'russian', name: 'Russian Kota', priceCents: 4500, quantity: 2 },
      { productId: 'drink', name: 'Cold drink', priceCents: 1500, quantity: 1 },
    ]);
    expect(r.replies[0]).toMatch(/Total: R\s?105,00/);
    expect(r.replies[0]).toContain('YES');
  });

  it('places the order on YES, with the note', () => {
    let s = handleIncoming('2x2', EMPTY_CHAT, ctx).state;
    s = handleIncoming('note: no atchar', s, ctx).state;
    const r = handleIncoming('yes', s, ctx);
    expect(r.placeOrder).toEqual({ lines: [{ productId: 'russian', name: 'Russian Kota', priceCents: 4500, quantity: 2 }], note: 'no atchar' });
    expect(r.state).toEqual(EMPTY_CHAT);
  });

  it('does nothing on YES without an order', () => {
    expect(handleIncoming('yes', EMPTY_CHAT, ctx).placeOrder).toBeUndefined();
  });

  it('rejects unknown items and silly quantities', () => {
    expect(handleIncoming('9', EMPTY_CHAT, ctx).replies[0]).toContain('no item 9');
    expect(handleIncoming('1x50', EMPTY_CHAT, ctx).replies[0]).toContain('between 1 and');
  });

  it('cancels', () => {
    const s = handleIncoming('1', EMPTY_CHAT, ctx).state;
    expect(handleIncoming('cancel', s, ctx).state).toEqual(EMPTY_CHAT);
  });

  it('says when the shop is closed but still answers STATUS', () => {
    const closed = { ...ctx, open: false };
    expect(handleIncoming('2x2', EMPTY_CHAT, closed).replies[0]).toContain('closed');
    expect(handleIncoming('status', EMPTY_CHAT, { ...closed, lastOrder: { ticketNo: 4, status: 'ready' } }).replies[0]).toContain('#4 is *ready to collect*');
  });
});

describe('status messages', () => {
  it('tells the customer what to pay when ready', () => {
    expect(statusMessage('ready', 12, 'Mzansi Kota', 10500, false)).toMatch(/#12 is \*ready to collect\*.*R\s?105,00/);
    expect(statusMessage('ready', 12, 'Mzansi Kota', 10500, true)).not.toMatch(/pay/);
    expect(statusMessage('new', 12, 'x', 0, false)).toBeNull();
  });
  it('formats SA numbers', () => {
    expect(displayPhone('27821234567')).toBe('+27 82 123 4567');
  });
});
