import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { logger } from 'firebase-functions';
import { onCall, onRequest } from 'firebase-functions/v2/https';
import { ApiRequest, ApiResponse } from './shared/api';
import { YOCO_API, YocoCheckout, keyMode, yocoSignatureOk } from './shared/yoco';
import { REGION, audit, col, db, fail, handle, requireCaller, settingsRef } from './common';

/**
 * Card payments on the customer's phone through Yoco's Checkout API.
 * The owner's secret key and the webhook secret live in
 * businesses/{b}/private/yoco, which no app user can read.
 * In the emulator nothing is sent to Yoco: checkouts get a fake link and the
 * webhook secret is fixed, so tests can post signed events.
 */
const inEmulator = () => process.env['FUNCTIONS_EMULATOR'] === 'true';
export const EMULATOR_WEBHOOK_SECRET = `whsec_${Buffer.from('kotahouse-emulator-yoco').toString('base64')}`;

interface YocoPrivate {
  secretKey: string;
  webhookId: string;
  webhookSecret: string;
  mode: 'live' | 'test';
}

const privateRef = (b: string) => col(b, 'private').doc('yoco');

async function yoco<T>(secretKey: string, method: 'POST' | 'DELETE', path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
  const res = await fetch(`${YOCO_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    logger.warn('Yoco API error', { path, status: res.status, body: text.slice(0, 500) });
    const message = (() => {
      try {
        return (JSON.parse(text) as { message?: string }).message;
      } catch {
        return undefined;
      }
    })();
    fail('failed-precondition', res.status === 401 || res.status === 403 ? 'Yoco did not accept the secret key' : `Yoco: ${message ?? `error ${res.status}`}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

function webhookUrl(b: string): string {
  return `https://${REGION}-${process.env['GCLOUD_PROJECT']}.cloudfunctions.net/yocoWebhook?b=${encodeURIComponent(b)}`;
}

/** Owner connects their Yoco account: checks the key and registers the payment webhook with Yoco. */
export const connectYoco = onCall<ApiRequest<'connectYoco'>, Promise<ApiResponse<'connectYoco'>>>((req) =>
  handle(async () => {
    const owner = await requireCaller(req, ['owner']);
    const b = owner.businessId;
    const secretKey = String(req.data.secretKey ?? '').trim();
    const mode = keyMode(secretKey);
    if (!mode) fail('invalid-argument', 'Paste the secret key from the Yoco portal – it starts with sk_live_ or sk_test_');

    const old = (await privateRef(b).get()).data() as YocoPrivate | undefined;
    let webhook: { id: string; secret: string };
    if (inEmulator()) {
      webhook = { id: 'emulator', secret: EMULATOR_WEBHOOK_SECRET };
    } else {
      webhook = await yoco<{ id: string; secret: string }>(secretKey, 'POST', '/webhooks', { name: `Kota House ${b}`.slice(0, 60), url: webhookUrl(b) });
      if (old?.webhookId) {
        await yoco(old.secretKey, 'DELETE', `/webhooks/${old.webhookId}`).catch((err) => logger.warn('Could not remove old Yoco webhook', err));
      }
    }
    await privateRef(b).set({ secretKey, webhookId: webhook.id, webhookSecret: webhook.secret, mode } satisfies YocoPrivate);
    await settingsRef(b).set({ yoco: { enabled: true, mode } }, { merge: true });
    const batch = db.batch();
    audit(batch, b, owner, 'yoco.connected', 'businessSettings', 'yoco', { mode });
    await batch.commit();
    return { mode };
  }),
);

export const disconnectYoco = onCall<ApiRequest<'disconnectYoco'>, Promise<ApiResponse<'disconnectYoco'>>>((req) =>
  handle(async () => {
    const owner = await requireCaller(req, ['owner']);
    const b = owner.businessId;
    const old = (await privateRef(b).get()).data() as YocoPrivate | undefined;
    if (old?.webhookId && !inEmulator()) {
      await yoco(old.secretKey, 'DELETE', `/webhooks/${old.webhookId}`).catch((err) => logger.warn('Could not remove Yoco webhook', err));
    }
    await privateRef(b).delete();
    await settingsRef(b).set({ yoco: { enabled: false, mode: null } }, { merge: true });
    const batch = db.batch();
    audit(batch, b, owner, 'yoco.disconnected', 'businessSettings', 'yoco', {});
    await batch.commit();
    return { ok: true };
  }),
);

/** Till: starts a card payment for the card part of a sale; the app shows its link as a QR code. */
export const createYocoCheckout = onCall<ApiRequest<'createYocoCheckout'>, Promise<ApiResponse<'createYocoCheckout'>>>((req) =>
  handle(async () => {
    const caller = await requireCaller(req);
    const b = caller.businessId;
    const saleId = String(req.data.saleId ?? '');
    const amountCents = Number(req.data.amountCents);
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(saleId)) fail('invalid-argument', 'Invalid sale id');
    if (!Number.isSafeInteger(amountCents) || amountCents < 200 || amountCents > 5_000_000) fail('invalid-argument', 'Card payments on a phone must be between R2 and R50,000');
    const keys = (await privateRef(b).get()).data() as YocoPrivate | undefined;
    if (!keys) fail('failed-precondition', 'Card payment on the phone is not set up – the owner connects Yoco under Settings');

    // Re-use an unpaid or paid checkout for the same sale and amount (e.g. the cashier tapped twice).
    const existing = await col(b, 'yocoCheckouts').where('saleId', '==', saleId).get();
    const same = existing.docs.map((d) => d.data() as YocoCheckout).find((c) => c.amountCents === amountCents && c.status !== 'failed' && !c.usedBySale);
    if (same) return { checkoutId: same.id, redirectUrl: same.redirectUrl };

    let checkout: { id: string; redirectUrl: string };
    if (inEmulator()) {
      const id = `ch_emu_${randomBytes(8).toString('hex')}`;
      checkout = { id, redirectUrl: `https://pay.yoco.com/emulator/${id}` };
    } else {
      checkout = await yoco<{ id: string; redirectUrl: string }>(
        keys.secretKey,
        'POST',
        '/checkouts',
        { amount: amountCents, currency: 'ZAR', externalId: saleId, metadata: { businessId: b, saleId } },
        `${saleId}-${amountCents}`,
      );
    }
    const doc: YocoCheckout = {
      id: checkout.id,
      saleId,
      amountCents,
      status: 'created',
      redirectUrl: checkout.redirectUrl,
      createdBy: caller.uid,
      createdAtMillis: Date.now(),
      mode: inEmulator() ? 'emulator' : keys.mode,
    };
    await col(b, 'yocoCheckouts').doc(checkout.id).set(doc);
    return { checkoutId: checkout.id, redirectUrl: checkout.redirectUrl };
  }),
);

interface YocoEvent {
  type?: string;
  payload?: { id?: string; amount?: number; status?: string; mode?: string; metadata?: { checkoutId?: string } };
}

/** Yoco calls this when a customer's card payment succeeds or fails. Registered per shop by connectYoco. */
export const yocoWebhook = onRequest(async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }
  const b = String(req.query['b'] ?? '');
  const keys = /^[A-Za-z0-9_-]{1,128}$/.test(b) ? ((await privateRef(b).get()).data() as YocoPrivate | undefined) : undefined;
  const ok =
    !!keys &&
    yocoSignatureOk(
      {
        secret: keys.webhookSecret,
        id: req.get('webhook-id'),
        timestamp: req.get('webhook-timestamp'),
        signature: req.get('webhook-signature'),
        body: req.rawBody?.toString('utf8') ?? '',
        nowSeconds: Math.floor(Date.now() / 1000),
      },
      (key, content) => createHmac('sha256', Buffer.from(key, 'base64')).update(content).digest('base64'),
      (x, y) => x.length === y.length && timingSafeEqual(Buffer.from(x), Buffer.from(y)),
    );
  if (!ok) {
    res.status(403).send('Bad signature');
    return;
  }
  const event = req.body as YocoEvent;
  const checkoutId = event.payload?.metadata?.checkoutId;
  if ((event.type === 'payment.succeeded' || event.type === 'payment.failed') && checkoutId) {
    const ref = col(b, 'yocoCheckouts').doc(checkoutId);
    await db.runTransaction(async (tx) => {
      const c = (await tx.get(ref)).data() as YocoCheckout | undefined;
      if (!c || c.status === 'paid') return; // not ours, or already handled (Yoco retries)
      if (event.type === 'payment.failed') {
        tx.update(ref, { status: 'failed' });
      } else if (event.payload?.amount !== c.amountCents) {
        logger.error('Yoco payment amount does not match the checkout', { b, checkoutId, paid: event.payload?.amount, expected: c.amountCents });
        tx.update(ref, { status: 'failed' });
      } else {
        tx.update(ref, { status: 'paid', paidAtMillis: Date.now(), paymentId: String(event.payload?.id ?? '') });
      }
    });
  }
  res.status(200).send('ok');
});
