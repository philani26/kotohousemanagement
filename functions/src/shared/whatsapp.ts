import { formatZar } from './money';

/**
 * WhatsApp ordering bot: pure conversation logic, no Firebase or network.
 * The webhook function feeds it each incoming message together with the
 * customer's chat state and the menu, and carries out what it returns.
 *
 * Ordering format (simple to type on any phone):
 *   "3x2, 6"   → two of menu item 3 and one of item 6
 *   "note: no atchar" → kitchen note
 *   YES / CANCEL / MENU / STATUS
 */

export interface MenuItem {
  productId: string;
  name: string;
  priceCents: number;
}

export interface DraftLine {
  productId: string;
  name: string;
  quantity: number;
  priceCents: number;
}

export interface ChatState {
  step: 'idle' | 'confirming';
  draft: DraftLine[];
  note: string;
}

export const EMPTY_CHAT: ChatState = { step: 'idle', draft: [], note: '' };

export interface BotContext {
  shopName: string;
  menu: MenuItem[];
  /** shop is trading now and a shift is open */
  open: boolean;
  openingText: string;
  /** most recent order of this customer today, for STATUS */
  lastOrder?: { ticketNo: string; status: string } | null;
}

export interface BotResult {
  replies: string[];
  state: ChatState;
  /** set when the customer confirmed – the caller creates the order */
  placeOrder?: { lines: DraftLine[]; note: string };
}

export const MAX_ITEMS_PER_ORDER = 20;
export const MAX_QTY_PER_LINE = 10;

const YES = /^(yes|y|yebo|ja|confirm|ok|okay)\b/i;
const CANCEL = /^(cancel|stop order|no)\b/i;
const MENU = /^(menu|hi|hello|hey|hallo|sawubona|molo|start|order)\b/i;
const STATUS = /^(status|where|my order)\b/i;
const NOTE = /^note\s*[:\-]?\s*(.+)$/i;

export function menuText(ctx: BotContext): string {
  const lines = ctx.menu.map((m, i) => `${i + 1}. ${m.name} – ${formatZar(m.priceCents)}`);
  return [
    `👋 Welcome to *${ctx.shopName}*! Here's our menu:`,
    '',
    ...lines,
    '',
    'To order, reply with the item number and quantity, e.g. *3x2, 6* (two of item 3 and one of item 6).',
    'Add a note with *note: no atchar*. You pay when you collect.',
  ].join('\n');
}

/**
 * Reads "3x2, 6, 1 x 3" into item numbers and quantities (1-based item numbers).
 * Returns null when the text is not an order.
 */
export function parseOrderText(text: string): { item: number; quantity: number }[] | null {
  const cleaned = text.toLowerCase().replace(/[×*]/g, 'x').trim();
  if (!/^[\d\sx,;.+&and]+$/.test(cleaned) || !/\d/.test(cleaned)) return null;
  const parts = cleaned.split(/[,;+&]|\band\b/).map((p) => p.trim()).filter(Boolean);
  const out: { item: number; quantity: number }[] = [];
  for (const part of parts) {
    const m = /^(\d{1,3})\s*(?:x\s*(\d{1,2}))?$/.exec(part);
    if (!m) return null;
    out.push({ item: Number(m[1]), quantity: m[2] ? Number(m[2]) : 1 });
  }
  return out.length ? out : null;
}

export function orderSummary(lines: DraftLine[], note: string): string {
  const total = lines.reduce((s, l) => s + l.priceCents * l.quantity, 0);
  return [
    ...lines.map((l) => `• ${l.quantity}× ${l.name} – ${formatZar(l.priceCents * l.quantity)}`),
    ...(note ? [`📝 ${note}`] : []),
    `*Total: ${formatZar(total)}* (pay at collection)`,
  ].join('\n');
}

export function draftTotal(lines: DraftLine[]): number {
  return lines.reduce((s, l) => s + l.priceCents * l.quantity, 0);
}

/** One step of the conversation. */
export function handleIncoming(text: string, state: ChatState, ctx: BotContext): BotResult {
  const msg = text.trim();
  const keep = (replies: string[]): BotResult => ({ replies, state });

  if (STATUS.test(msg)) {
    return keep([
      ctx.lastOrder
        ? `Your order #${ctx.lastOrder.ticketNo} is *${statusLabel(ctx.lastOrder.status)}*.`
        : "You don't have an order today. Reply *menu* to order.",
    ]);
  }

  if (!ctx.open) {
    return { replies: [`Sorry, *${ctx.shopName}* is closed right now. ${ctx.openingText}`], state: EMPTY_CHAT };
  }

  if (CANCEL.test(msg)) {
    return { replies: ['Order cancelled. Reply *menu* whenever you want to order.'], state: EMPTY_CHAT };
  }

  const note = NOTE.exec(msg);
  if (note) {
    const next = { ...state, note: note[1].trim().slice(0, 200) };
    return {
      replies: [
        next.draft.length
          ? `Note added.\n\n${orderSummary(next.draft, next.note)}\n\nReply *YES* to place the order.`
          : 'Note saved. Now send your order, e.g. *3x2, 6*.',
      ],
      state: next,
    };
  }

  if (YES.test(msg)) {
    if (state.step !== 'confirming' || !state.draft.length) {
      return keep(["There's nothing to confirm yet. Send your order, e.g. *3x2, 6*, or *menu* to see the menu."]);
    }
    return { replies: [], state: EMPTY_CHAT, placeOrder: { lines: state.draft, note: state.note } };
  }

  const parsed = parseOrderText(msg);
  if (parsed) {
    const merged = new Map<string, DraftLine>();
    for (const { item, quantity } of parsed) {
      const m = ctx.menu[item - 1];
      if (!m) return keep([`There's no item ${item} on the menu. Reply *menu* to see the numbers.`]);
      if (quantity < 1 || quantity > MAX_QTY_PER_LINE) return keep([`Please order between 1 and ${MAX_QTY_PER_LINE} of each item.`]);
      const line = merged.get(m.productId) ?? { productId: m.productId, name: m.name, priceCents: m.priceCents, quantity: 0 };
      line.quantity += quantity;
      merged.set(m.productId, line);
    }
    const draft = [...merged.values()];
    if (draft.reduce((s, l) => s + l.quantity, 0) > MAX_ITEMS_PER_ORDER) {
      return keep([`That's a big order! For more than ${MAX_ITEMS_PER_ORDER} items please call the shop.`]);
    }
    return {
      replies: [`Here's your order:\n\n${orderSummary(draft, state.note)}\n\nReply *YES* to place it, or send a new list to change it.`],
      state: { step: 'confirming', draft, note: state.note },
    };
  }

  // anything else (including "hi" / "menu"): show the menu
  if (MENU.test(msg) || state.step === 'idle') return keep([menuText(ctx)]);
  return keep(["Sorry, I didn't get that. Send your order like *3x2, 6*, reply *YES* to confirm, or *menu* to start again."]);
}

export function statusLabel(status: string): string {
  return ({ new: 'received', preparing: 'being prepared', ready: 'ready to collect', collected: 'collected' } as Record<string, string>)[status] ?? status;
}

/** Messages sent to the customer when staff move the ticket along. */
export function statusMessage(status: string, ticketNo: string | number, shopName: string, totalCents: number, paid: boolean): string | null {
  switch (status) {
    case 'preparing':
      return `👨‍🍳 Your order #${ticketNo} is being prepared.`;
    case 'ready':
      return `✅ Your order #${ticketNo} is *ready to collect* at ${shopName}!${paid ? '' : ` Please pay ${formatZar(totalCents)} when you collect (cash or card).`}`;
    case 'collected':
      return `Thank you for buying at ${shopName}! Enjoy your meal 🙏`;
    default:
      return null;
  }
}

/** Normalises a WhatsApp sender id (digits) for display, e.g. 27821234567 → +27 82 123 4567. */
export function displayPhone(waId: string): string {
  const d = waId.replace(/\D/g, '');
  return /^27\d{9}$/.test(d) ? `+27 ${d.slice(2, 4)} ${d.slice(4, 7)} ${d.slice(7)}` : `+${d}`;
}
