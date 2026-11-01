/**
 * Yoco online card payments (Checkout API): the till shows a QR code, the
 * customer pays by card on their own phone, and Yoco's webhook confirms it.
 * Yoco's card-machine SDK only works inside approved native apps, so it is
 * not used. Pure helpers here; the HTTP calls live in functions/src/yoco.ts.
 */

/** businesses/{b}/yocoCheckouts/{checkoutId} – written by functions; staff watch it while the customer pays. */
export interface YocoCheckout {
  id: string;
  /** the till sale this payment is for */
  saleId: string;
  amountCents: number;
  status: 'created' | 'paid' | 'failed';
  redirectUrl: string;
  createdBy: string;
  createdAtMillis: number;
  paidAtMillis?: number;
  paymentId?: string;
  /** set once a sale used this payment, so it can't pay for two sales */
  usedBySale?: string;
  mode: 'live' | 'test' | 'emulator';
}

/** what the app may show: whether card-on-phone is set up */
export interface YocoSettings {
  enabled: boolean;
  mode: 'live' | 'test' | null;
}

export const DEFAULT_YOCO: YocoSettings = { enabled: false, mode: null };

export const YOCO_API = 'https://payments.yoco.com/api';

export function keyMode(secretKey: string): 'live' | 'test' | null {
  return /^sk_live_[A-Za-z0-9]{10,}$/.test(secretKey) ? 'live' : /^sk_test_[A-Za-z0-9]{10,}$/.test(secretKey) ? 'test' : null;
}

/**
 * Standard Webhooks check, as Yoco documents it: HMAC-SHA256 over
 * "<webhook-id>.<webhook-timestamp>.<raw body>" with the base64 key after
 * "whsec_", compared to any "v1,<sig>" entry in webhook-signature.
 * `hmac` is injected so this stays free of Node imports.
 */
export function yocoSignatureOk(
  input: { secret: string; id?: string; timestamp?: string; body: string; signature?: string; nowSeconds: number },
  hmacSha256Base64: (keyBase64: string, content: string) => string,
  equal: (a: string, b: string) => boolean,
): boolean {
  const { secret, id, timestamp, body, signature, nowSeconds } = input;
  if (!secret.startsWith('whsec_') || !id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > 180) return false;
  const expected = hmacSha256Base64(secret.slice('whsec_'.length), `${id}.${timestamp}.${body}`);
  return signature
    .split(' ')
    .map((s) => s.split(',', 2))
    .some(([version, sig]) => version === 'v1' && !!sig && equal(sig, expected));
}

/** Why a checkout can't pay for this sale, or null if it can. */
export function checkoutProblem(c: YocoCheckout | undefined, saleId: string, amountCents: number): string | null {
  if (!c) return 'Card payment not found';
  if (c.saleId !== saleId) return 'That card payment belongs to another sale';
  if (c.usedBySale && c.usedBySale !== saleId) return 'That card payment was already used';
  if (c.status !== 'paid') return 'The customer has not finished paying yet';
  if (c.amountCents !== amountCents) return `The customer paid a different amount – start the card payment again`;
  return null;
}
