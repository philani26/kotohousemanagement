import { createHmac, timingSafeEqual } from 'node:crypto';
import { logger } from 'firebase-functions';
import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { onCall, onRequest } from 'firebase-functions/v2/https';
import { ApiRequest, ApiResponse } from './shared/api';
import { inOrderQueue, localHour, localWeekday, requireText } from './shared/domain';
import { formatZar } from './shared/money';
import { BusinessSettings, Order, Product } from './shared/models';
import { BotContext, ChatState, EMPTY_CHAT, MenuItem, displayPhone, draftTotal, handleIncoming, statusMessage } from './shared/whatsapp';
import { FieldValue, audit, col, db, fail, handle, notify, readSettings, requireCaller, todayKey } from './common';

/**
 * WhatsApp ordering through the WhatsApp Business Platform (Cloud API).
 * Configuration (functions/.env.<alias>, never in git):
 *   WHATSAPP_TOKEN         – permanent access token of the Meta system user
 *   WHATSAPP_APP_SECRET    – Meta app secret, used to verify webhook signatures
 *   WHATSAPP_VERIFY_TOKEN  – any long random string, also entered in the Meta app's webhook settings
 * Without WHATSAPP_TOKEN every outgoing message is only logged ("dry-run"), so
 * the whole flow can be tried in the emulator. See docs/WHATSAPP.md.
 */
const GRAPH = 'https://graph.facebook.com/v21.0';
const NUMBERS = 'whatsappNumbers'; // top level: phoneNumberId → businessId

const env = (k: string) => process.env[k] ?? '';
/** WhatsApp orders are numbered W1, W2… so they never clash with till orders on the board. */
export const waLabel = (n: number | undefined) => `W${n ?? 0}`;
const inEmulator = () => process.env['FUNCTIONS_EMULATOR'] === 'true';

/** Sends a text message (or logs it in dry-run mode) and keeps a copy in the shop's message log. */
export async function sendWhatsapp(businessId: string, phoneNumberId: string, to: string, text: string): Promise<void> {
  const token = env('WHATSAPP_TOKEN');
  let status: 'sent' | 'dry-run' | 'failed' = token ? 'sent' : 'dry-run';
  let error: string | undefined;
  if (token && phoneNumberId) {
    try {
      const res = await fetch(`${GRAPH}/${phoneNumberId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text, preview_url: false } }),
      });
      if (!res.ok) {
        status = 'failed';
        error = (await res.text()).slice(0, 500);
      }
    } catch (err) {
      status = 'failed';
      error = String(err).slice(0, 500);
    }
  }
  if (status === 'failed') logger.error('WhatsApp send failed', { businessId, error });
  await col(businessId, 'whatsappMessages').add({
    direction: 'out',
    waId: to,
    text,
    status,
    ...(error ? { error } : {}),
    at: FieldValue.serverTimestamp(),
  });
}

/** Meta signs every webhook call with the app secret (X-Hub-Signature-256). */
function signatureOk(rawBody: Buffer | undefined, header: string | undefined): boolean {
  const secret = env('WHATSAPP_APP_SECRET');
  if (!secret) return inEmulator(); // fail closed in production
  if (!rawBody || !header?.startsWith('sha256=')) return false;
  const expected = Buffer.from('sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex'));
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

interface Incoming {
  phoneNumberId: string;
  from: string;
  name: string;
  text: string;
  messageId: string;
}

/** Pulls text messages out of a Cloud API webhook payload. */
function readPayload(body: unknown): Incoming[] {
  const out: Incoming[] = [];
  const entries = (body as { entry?: unknown[] })?.entry ?? [];
  for (const entry of entries as { changes?: { value?: Record<string, unknown> }[] }[]) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      const phoneNumberId = String((value['metadata'] as { phone_number_id?: string } | undefined)?.phone_number_id ?? '');
      const contacts = (value['contacts'] as { wa_id?: string; profile?: { name?: string } }[] | undefined) ?? [];
      for (const m of (value['messages'] as Record<string, unknown>[] | undefined) ?? []) {
        const from = String(m['from'] ?? '');
        const text =
          (m['text'] as { body?: string } | undefined)?.body ??
          (m['button'] as { text?: string } | undefined)?.text ??
          (m['interactive'] as { button_reply?: { title?: string }; list_reply?: { title?: string } } | undefined)?.button_reply?.title ??
          '';
        if (!from || !phoneNumberId) continue;
        out.push({
          phoneNumberId,
          from,
          name: contacts.find((c) => c.wa_id === from)?.profile?.name ?? '',
          text: String(text).slice(0, 1000),
          messageId: String(m['id'] ?? ''),
        });
      }
    }
  }
  return out;
}

function isOpenNow(settings: BusinessSettings, now = new Date()): boolean {
  const hour = localHour(now, settings.timezone);
  return settings.tradingDays.includes(localWeekday(now, settings.timezone)) && hour >= settings.openingHour && hour < settings.closingHour;
}

async function processMessage(msg: Incoming): Promise<void> {
  const link = (await db.collection(NUMBERS).doc(msg.phoneNumberId).get()).data() as { businessId?: string } | undefined;
  const b = link?.businessId;
  if (!b) return logger.warn('WhatsApp message for an unlinked number', { phoneNumberId: msg.phoneNumberId });

  // WhatsApp may deliver the same message more than once: handle each id once.
  if (msg.messageId) {
    try {
      await col(b, 'whatsappInbound').doc(msg.messageId).create({ at: FieldValue.serverTimestamp() });
    } catch {
      return;
    }
  }
  await col(b, 'whatsappMessages').add({ direction: 'in', waId: msg.from, name: msg.name, text: msg.text, at: FieldValue.serverTimestamp() });

  const settings = await readSettings(b);
  if (!settings.whatsapp.ordering) {
    await sendWhatsapp(b, msg.phoneNumberId, msg.from, `Thanks for your message! ${settings.businessName} is not taking WhatsApp orders at the moment.`);
    return;
  }

  const today = todayKey(settings);
  const [productsSnap, openShift, chatSnap, todaysOrders] = await Promise.all([
    col(b, 'products').where('active', '==', true).orderBy('sortOrder').get(),
    col(b, 'shifts').where('status', '==', 'open').limit(1).get(),
    col(b, 'whatsappChats').doc(msg.from).get(),
    col(b, 'orders').where('customerPhone', '==', msg.from).where('dayKey', '==', today).get(),
  ]);
  const products = productsSnap.docs.map((d) => ({ ...(d.data() as Product), id: d.id }));
  const menu: MenuItem[] = products.map((p) => ({ productId: p.id, name: p.name, priceCents: p.priceCents }));
  const last = todaysOrders.docs.map((d) => d.data() as Order).sort((x, y) => y.createdAtMillis - x.createdAtMillis)[0];
  const ctx: BotContext = {
    shopName: settings.businessName,
    menu,
    open: isOpenNow(settings) && !openShift.empty,
    openingText: `We take orders from ${settings.openingHour}:00 to ${settings.closingHour}:00.`,
    lastOrder: last ? { ticketNo: waLabel(last.ticketNo), status: last.status } : null,
  };
  const state = (chatSnap.data()?.['state'] as ChatState | undefined) ?? EMPTY_CHAT;
  const result = handleIncoming(msg.text, state, ctx);

  if (result.placeOrder) {
    const byId = new Map(products.map((p) => [p.id, p]));
    const items = result.placeOrder.lines.filter((l) => byId.has(l.productId));
    const totalCents = draftTotal(items);
    const ticketNo = await db.runTransaction(async (tx) => {
      const counterRef = col(b, 'orderCounters').doc(today);
      const n = (((await tx.get(counterRef)).get('n') as number | undefined) ?? 0) + 1;
      tx.set(counterRef, { n }, { merge: true });
      const ref = col(b, 'orders').doc();
      const order: Omit<Order, 'updatedAt'> = {
        id: ref.id,
        receiptNo: null,
        ticketNo: n,
        lines: items.filter((l) => inOrderQueue(byId.get(l.productId)!)).map((l) => ({ name: l.name, quantity: l.quantity })),
        ...(result.placeOrder!.note ? { note: result.placeOrder!.note } : {}),
        status: 'new',
        source: 'whatsapp',
        customerPhone: msg.from,
        customerName: msg.name || displayPhone(msg.from),
        items: items.map((l) => ({ productId: l.productId, name: l.name, quantity: l.quantity, priceCents: l.priceCents })),
        totalCents,
        paid: false,
        createdAtMillis: Date.now(),
        createdBy: 'whatsapp',
        createdByName: `WhatsApp · ${msg.name || displayPhone(msg.from)}`,
        dayKey: today,
        updatedBy: 'whatsapp',
      };
      tx.set(ref, { ...order, updatedAt: FieldValue.serverTimestamp() });
      notify(tx, b, settings, {
        type: 'whatsappOrder',
        severity: 'info',
        title: `WhatsApp order ${waLabel(n)}: ${formatZar(totalCents)}`,
        message: `${order.customerName} ordered ${items.map((l) => `${l.quantity}× ${l.name}`).join(', ')}.`,
        details: [
          { label: 'Customer', value: `${order.customerName} (${displayPhone(msg.from)})` },
          { label: 'Items', value: items.map((l) => `${l.quantity}× ${l.name}`).join(', ') },
          { label: 'Total to collect', value: formatZar(totalCents) },
          ...(order.note ? [{ label: 'Note', value: order.note }] : []),
        ],
        actorName: 'WhatsApp',
        link: '/orders',
      });
      return n;
    });
    result.replies.push(
      `✅ Order *#${waLabel(ticketNo)}* received! Total *${formatZar(totalCents)}*, pay when you collect.\nWe'll message you here when it's ready. Reply *status* any time.`,
    );
  }

  await col(b, 'whatsappChats').doc(msg.from).set(
    { state: result.state, name: msg.name, lastAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  for (const reply of result.replies) await sendWhatsapp(b, msg.phoneNumberId, msg.from, reply);
}

/** Webhook URL to enter in the Meta app: https://<region>-<project>.cloudfunctions.net/whatsappWebhook */
export const whatsappWebhook = onRequest(async (req, res) => {
  if (req.method === 'GET') {
    // Meta's one-time verification handshake
    const ok = req.query['hub.mode'] === 'subscribe' && env('WHATSAPP_VERIFY_TOKEN') && req.query['hub.verify_token'] === env('WHATSAPP_VERIFY_TOKEN');
    res.status(ok ? 200 : 403).send(ok ? String(req.query['hub.challenge'] ?? '') : 'Forbidden');
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }
  if (!signatureOk(req.rawBody, req.get('x-hub-signature-256'))) {
    res.status(403).send('Bad signature');
    return;
  }
  try {
    for (const msg of readPayload(req.body)) await processMessage(msg);
  } catch (err) {
    logger.error('WhatsApp webhook failed', err);
  }
  // Always acknowledge, otherwise Meta keeps re-sending the same messages.
  res.status(200).send('ok');
});

/** Tells the customer when staff move their WhatsApp order along the queue. */
export const whatsappOrderStatus = onDocumentUpdated('businesses/{businessId}/orders/{orderId}', async (event) => {
  const before = event.data?.before.data() as Order | undefined;
  const after = event.data?.after.data() as Order | undefined;
  if (!before || !after || after.source !== 'whatsapp' || !after.customerPhone || before.status === after.status) return;
  const b = event.params.businessId;
  const settings = await readSettings(b);
  const text = statusMessage(after.status, waLabel(after.ticketNo), settings.businessName, after.totalCents ?? 0, !!after.paid);
  if (text && settings.whatsapp.phoneNumberId) await sendWhatsapp(b, settings.whatsapp.phoneNumberId, after.customerPhone, text);
});

/** Owner links the shop's WhatsApp Business number and turns ordering on or off. */
export const linkWhatsapp = onCall<ApiRequest<'linkWhatsapp'>, Promise<ApiResponse<'linkWhatsapp'>>>((req) =>
  handle(async () => {
    const owner = await requireCaller(req, ['owner']);
    const d = req.data;
    const phoneNumberId = String(d.phoneNumberId ?? '').trim();
    if (phoneNumberId && !/^\d{6,25}$/.test(phoneNumberId)) fail('invalid-argument', 'The phone number ID is the long number from Meta (digits only)');
    const displayNumber = d.displayNumber ? requireText(d.displayNumber, 'WhatsApp number', 6, 30) : '';
    if (d.ordering && !phoneNumberId) fail('invalid-argument', 'Enter the phone number ID before turning ordering on');
    const b = owner.businessId;

    await db.runTransaction(async (tx) => {
      const settings = await readSettings(b, tx);
      const ref = phoneNumberId ? db.collection(NUMBERS).doc(phoneNumberId) : null;
      const existing = ref ? (await tx.get(ref)).data() : undefined;
      if (existing && existing['businessId'] !== b) fail('already-exists', 'That WhatsApp number is linked to another shop');
      const previous = settings.whatsapp.phoneNumberId;
      if (previous && previous !== phoneNumberId) tx.delete(db.collection(NUMBERS).doc(previous));
      if (ref) tx.set(ref, { businessId: b, updatedAt: FieldValue.serverTimestamp() });
      tx.set(
        col(b, 'businessSettings').doc('main'),
        { whatsapp: { ordering: !!d.ordering, phoneNumberId, displayNumber } },
        { merge: true },
      );
      audit(tx, b, owner, 'whatsapp.linked', 'businessSettings', 'main', { ordering: !!d.ordering, phoneNumberId, displayNumber });
    });
    return { ok: true };
  }),
);

