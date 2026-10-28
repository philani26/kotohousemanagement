import { formatZar } from '@shared/money';
import { PaymentMethod } from '@shared/models';

export interface Receipt {
  /** null while the sale is waiting in the offline queue */
  receiptNo: number | null;
  at: number;
  cashier: string;
  lines: { name: string; quantity: number; lineTotalCents: number }[];
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  method: PaymentMethod;
  receivedCents?: number;
  changeCents?: number;
}

/** Plain-text receipt, used for WhatsApp sharing and as the printed layout. */
export function receiptText(r: Receipt, shopName: string): string {
  const when = new Date(r.at).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' });
  const rows = [
    `*${shopName}*`,
    `${r.receiptNo ? `Receipt #${r.receiptNo}` : 'Receipt (saved offline)'} · ${when}`,
    `Served by ${r.cashier}`,
    '',
    ...r.lines.map((l) => `${l.quantity} × ${l.name}  ${formatZar(l.lineTotalCents)}`),
    '',
    ...(r.discountCents ? [`Subtotal  ${formatZar(r.subtotalCents)}`, `Discount  −${formatZar(r.discountCents)}`] : []),
    `*Total  ${formatZar(r.totalCents)}*`,
    `Paid by ${r.method.toUpperCase()}`,
    ...(r.method === 'cash' && r.receivedCents !== undefined
      ? [`Cash  ${formatZar(r.receivedCents)}`, `Change  ${formatZar(r.changeCents ?? 0)}`]
      : []),
    '',
    'Thank you! Ngiyabonga!',
  ];
  return rows.join('\n');
}

/** Opens a narrow printable receipt (works with 58/80 mm Bluetooth printers via the phone's print dialog). */
export function printReceipt(r: Receipt, shopName: string): void {
  const w = window.open('', '_blank', 'width=360,height=640');
  if (!w) return;
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
  const body = esc(receiptText(r, shopName)).replace(/\*(.+?)\*/g, '<b>$1</b>');
  w.document.write(`<!doctype html><title>Receipt</title>
    <style>body{font:13px/1.4 ui-monospace,Consolas,monospace;margin:8px;width:72mm;white-space:pre-wrap}</style>
    <body>${body}<script>window.onload=()=>{window.print();setTimeout(()=>window.close(),300)}</script></body>`);
  w.document.close();
}

export function whatsappReceiptUrl(r: Receipt, shopName: string, phone?: string | null): string {
  return `https://wa.me/${phone ?? ''}?text=${encodeURIComponent(receiptText(r, shopName))}`;
}
