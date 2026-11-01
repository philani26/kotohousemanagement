import { createHmac, timingSafeEqual } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { YocoCheckout, checkoutProblem, keyMode, yocoSignatureOk } from './yoco';

const hmac = (key: string, content: string) => createHmac('sha256', Buffer.from(key, 'base64')).update(content).digest('base64');
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const secret = `whsec_${Buffer.from('test-secret-bytes-1234').toString('base64')}`;

describe('yocoSignatureOk', () => {
  const body = '{"type":"payment.succeeded"}';
  const now = 1_800_000_000;
  const sig = `v1,${hmac(secret.slice(6), `msg_1.${now}.${body}`)}`;
  const ok = (over: Partial<Parameters<typeof yocoSignatureOk>[0]>) =>
    yocoSignatureOk({ secret, id: 'msg_1', timestamp: String(now), body, signature: sig, nowSeconds: now, ...over }, hmac, equal);

  it('accepts a correctly signed event, also among several signatures', () => {
    expect(ok({})).toBe(true);
    expect(ok({ signature: `v1,bm9wZQ== ${sig}` })).toBe(true);
  });
  it('rejects a changed body, wrong id, old timestamp, missing headers or wrong secret', () => {
    expect(ok({ body: body + ' ' })).toBe(false);
    expect(ok({ id: 'msg_2' })).toBe(false);
    expect(ok({ nowSeconds: now + 600 })).toBe(false);
    expect(ok({ signature: undefined })).toBe(false);
    expect(ok({ secret: `whsec_${Buffer.from('other').toString('base64')}` })).toBe(false);
  });
});

describe('checkoutProblem', () => {
  const paid: YocoCheckout = { id: 'ch_1', saleId: 's1', amountCents: 3000, status: 'paid', redirectUrl: '', createdBy: 'u', createdAtMillis: 0, mode: 'test' };
  it('only lets a paid checkout of the right amount pay its own sale, once', () => {
    expect(checkoutProblem(paid, 's1', 3000)).toBeNull();
    expect(checkoutProblem({ ...paid, status: 'created' }, 's1', 3000)).toMatch(/not finished/);
    expect(checkoutProblem(paid, 's2', 3000)).toMatch(/another sale/);
    expect(checkoutProblem(paid, 's1', 3500)).toMatch(/different amount/);
    expect(checkoutProblem({ ...paid, usedBySale: 's9' }, 's1', 3000)).toMatch(/another sale|already used/);
    expect(checkoutProblem(undefined, 's1', 3000)).toMatch(/not found/);
  });
  it('recognises live and test keys', () => {
    expect(keyMode('sk_test_abcdef123456')).toBe('test');
    expect(keyMode('sk_live_abcdef123456')).toBe('live');
    expect(keyMode('pk_test_abcdef123456')).toBeNull();
  });
});
