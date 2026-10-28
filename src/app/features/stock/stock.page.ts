import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { limit, orderBy, query, where } from 'firebase/firestore';
import { isLowStock, reorderQty, waPhone } from '@shared/domain';
import { Ingredient, StockMovement, Supplier } from '@shared/models';
import { parseRandToCents } from '@shared/money';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { BusinessService } from '../../core/business.service';
import { liveQuery } from '../../core/live';
import { ToastService } from '../../core/toast.service';
import { UploadService } from '../../core/upload.service';
import { TsPipe, ZarPipe } from '../../shared/pipes';

type Tab = 'levels' | 'delivery' | 'loss' | 'history';
type LossType = 'wastage' | 'staffMeal' | 'complimentary' | 'adjustment';

interface DeliveryLine {
  ingredientId: string;
  qty: string;
  cost: string;
}

const MOVEMENT_LABELS: Record<StockMovement['type'], string> = {
  opening: 'Opening stock',
  purchase: 'Delivery',
  sale: 'Sold',
  wastage: 'Wastage',
  staffMeal: 'Staff meal',
  complimentary: 'Complimentary',
  adjustment: 'Adjustment',
};

@Component({
  selector: 'app-stock',
  imports: [FormsModule, DatePipe, DecimalPipe, ZarPipe, TsPipe],
  template: `
    <div class="page-head"><h1>Stock</h1></div>
    <div class="tabs">
      <button [class.on]="tab() === 'levels'" (click)="tab.set('levels')">Levels @if (lowCount()) {<span class="badge bad">{{ lowCount() }}</span>}</button>
      <button [class.on]="tab() === 'delivery'" (click)="tab.set('delivery')">Delivery</button>
      <button [class.on]="tab() === 'loss'" (click)="tab.set('loss')">Wastage & meals</button>
      <button [class.on]="tab() === 'history'" (click)="tab.set('history')">History</button>
    </div>

    @switch (tab()) {
      @case ('levels') {
        @if (reorder().length) {
          <div class="card">
            <div class="card-head">
              <h2>Reorder list</h2>
              <span class="tiny">tops each item up to twice its reorder level</span>
            </div>
            @for (group of reorder(); track group.name) {
              <div class="list-item">
                <div class="main">
                  <div class="title">{{ group.name }}</div>
                  @for (line of group.lines; track line.name) {
                    <div class="small">{{ line.qty }} {{ line.unit }} {{ line.name }} <span class="muted">(have {{ line.have | number: '1.0-2' }})</span></div>
                  }
                </div>
                <div class="stack" style="gap: .35rem">
                  <a class="btn small ok" [href]="group.whatsapp" target="_blank" rel="noopener">WhatsApp order</a>
                  <button class="btn small" (click)="copy(group.text)">Copy</button>
                </div>
              </div>
            }
          </div>
        }
        <div class="card">
          <div class="table-wrap">
            <table>
              <thead>
                <tr><th>Item</th><th class="r">In stock</th><th class="r">Reorder at</th>@if (auth.isOwner()) {<th class="r">Value</th>}<th></th><th></th></tr>
              </thead>
              <tbody>
                @for (i of ingredients.data(); track i.id) {
                  <tr>
                    <td>{{ i.name }}</td>
                    <td class="r" [style.color]="max0(i.currentQty) === 0 ? 'var(--bad)' : null">{{ max0(i.currentQty) | number: '1.0-2' }} {{ i.unit }}</td>
                    <td class="r">{{ i.reorderLevel | number: '1.0-2' }}</td>
                    @if (auth.isOwner()) {
                      <td class="r">{{ max0(i.currentQty) * i.unitCostCents | zar }}</td>
                    }
                    <td>
                      @if (max0(i.currentQty) === 0) {
                        <span class="badge bad">Out of stock</span>
                      } @else if (low(i)) {
                        <span class="badge bad">Low</span>
                      }
                    </td>
                    <td class="r"><button class="btn small" (click)="startAdd(i)">+ Add</button></td>
                  </tr>
                } @empty {
                  <tr><td colspan="5" class="empty">No ingredients set up yet</td></tr>
                }
              </tbody>
            </table>
          </div>
          @if (auth.isOwner()) {
            <p class="tiny" style="margin-top: .5rem">Stock value at cost: {{ stockValue() | zar }}. Levels are theoretical (deliveries − recipe usage − losses) until checked with a closing count.</p>
          }
        </div>
      }

      @case ('delivery') {
        <form class="card" (ngSubmit)="saveDelivery()">
          <h2>Record a delivery</h2>
          <label class="field">
            <span>Supplier</span>
            <select name="sup" [(ngModel)]="supplierId">
              <option value="">— Not listed —</option>
              @for (s of suppliers.data(); track s.id) {
                <option [value]="s.id">{{ s.name }}</option>
              }
            </select>
          </label>
          @for (line of lines(); track $index; let i = $index) {
            <div class="row" style="align-items: flex-end; margin-bottom: .5rem">
              <label class="field" style="flex: 2; min-width: 150px; margin: 0">
                <span>Item</span>
                <select [name]="'i' + i" [(ngModel)]="line.ingredientId" (ngModelChange)="prefillCost(line)">
                  <option value="">Choose…</option>
                  @for (ing of ingredients.data(); track ing.id) {
                    <option [value]="ing.id">{{ ing.name }} ({{ ing.unit }})</option>
                  }
                </select>
              </label>
              <label class="field" style="flex: 1; min-width: 80px; margin: 0"><span>Qty</span><input [name]="'q' + i" inputmode="decimal" [(ngModel)]="line.qty" /></label>
              <label class="field" style="flex: 1; min-width: 90px; margin: 0"><span>Cost/unit R <span class="hint">(optional)</span></span><input [name]="'c' + i" inputmode="decimal" [(ngModel)]="line.cost" /></label>
              <button type="button" class="btn small ghost" (click)="removeLine(i)" aria-label="Remove">✕</button>
            </div>
          }
          <button type="button" class="btn small" (click)="addLine()">+ Add item</button>
          <div class="divider"></div>
          <div class="row between"><span class="muted">Delivery total</span><strong class="money">{{ deliveryTotal() | zar }}</strong></div>
          <label class="field" style="margin-top: .75rem">
            <span>Cash paid from the till (R) <span class="hint">– 0 if the owner paid by EFT</span></span>
            <input name="till" inputmode="decimal" [(ngModel)]="tillText" />
          </label>
          <label class="field"><span>Invoice / slip number</span><input name="inv" [(ngModel)]="invoiceRef" /></label>
          <label class="field"><span>Invoice photo</span><input type="file" accept="image/*,application/pdf" capture="environment" (change)="pick($event)" /></label>
          <button class="btn primary block" [disabled]="busy()">Save delivery</button>
        </form>
      }

      @case ('loss') {
        <form class="card" (ngSubmit)="saveLoss()">
          <h2>Record stock used without a sale</h2>
          <div class="seg" style="margin-bottom: 1rem">
            <button type="button" [class.on]="lossType() === 'wastage'" (click)="lossType.set('wastage')">Wastage</button>
            <button type="button" [class.on]="lossType() === 'staffMeal'" (click)="lossType.set('staffMeal')">Staff meal</button>
            <button type="button" [class.on]="lossType() === 'complimentary'" (click)="lossType.set('complimentary')">Free item</button>
            <button type="button" [class.on]="lossType() === 'adjustment'" (click)="lossType.set('adjustment')">Correction</button>
          </div>
          <label class="field">
            <span>Item</span>
            <select name="li" [(ngModel)]="lossIngredient" required>
              <option value="">Choose…</option>
              @for (ing of ingredients.data(); track ing.id) {
                <option [value]="ing.id">{{ ing.name }} ({{ ing.unit }})</option>
              }
            </select>
          </label>
          <label class="field">
            <span>Quantity @if (lossType() === 'adjustment') {<span class="hint">– negative to remove stock, e.g. -2</span>}</span>
            <input name="lq" inputmode="decimal" [(ngModel)]="lossQty" required />
          </label>
          <label class="field"><span>Reason</span><input name="lr" [(ngModel)]="lossReason" required placeholder="e.g. burnt chips, dropped bread" /></label>
          @if (lossType() === 'adjustment' && !auth.isOwner()) {
            <p class="tiny">Corrections are sent to the owner for approval.</p>
          }
          <button class="btn primary block" [disabled]="busy()">Save</button>
        </form>
      }

      @case ('history') {
        <div class="card">
          <div class="table-wrap">
            <table>
              <thead><tr><th>When</th><th>Item</th><th>Type</th><th class="r">Qty</th>@if (auth.isOwner()) {<th class="r">Value</th>}<th>By / reason</th></tr></thead>
              <tbody>
                @for (m of movements.data(); track m.id) {
                  <tr>
                    <td class="small">{{ m.createdAt | ts | date: 'd MMM HH:mm' }}</td>
                    <td>{{ m.ingredientName }}</td>
                    <td><span class="badge" [class.bad]="m.type === 'wastage'" [class.ok]="m.type === 'purchase'">{{ label(m.type) }}</span></td>
                    <td class="r">{{ m.qtyChange > 0 ? '+' : '' }}{{ m.qtyChange | number: '1.0-3' }}</td>
                    @if (auth.isOwner()) {
                      <td class="r">{{ m.valueCents | zar }}</td>
                    }
                    <td class="small">{{ m.createdByName }}@if (m.reason) {<br /><span class="muted">{{ m.reason }}</span>}@if (m.shortfallQty) {<br /><span class="badge bad">{{ m.shortfallQty }} more needed – was out of stock</span>}</td>
                  </tr>
                } @empty {
                  <tr><td colspan="6" class="empty">No stock movements yet</td></tr>
                }
              </tbody>
            </table>
          </div>
        </div>
      }
    }

    @if (adding(); as a) {
      <div class="dialog-backdrop" (click)="adding.set(null)">
        <form class="dialog" (click)="$event.stopPropagation()" (ngSubmit)="saveAdd(a)">
          <h2>Add stock: {{ a.name }}</h2>
          <p class="muted small">The quantity is added on top of what is already there. Nothing is overwritten.</p>
          <label class="field">
            <span>Quantity received ({{ a.unit }})</span>
            <input class="money-input" name="aq" type="number" inputmode="decimal" min="0" step="any" [ngModel]="addQty()" (ngModelChange)="addQty.set($event)" required autofocus />
          </label>
          <div class="confirm-summary">
            <div class="row between"><span>In stock now</span><span class="money">{{ max0(a.currentQty) | number: '1.0-3' }} {{ a.unit }}</span></div>
            <div class="row between"><span>Adding</span><span class="money">+{{ (addQty() || 0) | number: '1.0-3' }} {{ a.unit }}</span></div>
            <div class="row between strong"><span>New level</span><span class="money">{{ max0(a.currentQty) + (addQty() || 0) | number: '1.0-3' }} {{ a.unit }}</span></div>
          </div>
          <label class="field">
            <span>Cost per {{ a.unit }} (R) <span class="hint">– optional. Leave empty to keep the current cost.</span></span>
            <input name="ac" inputmode="decimal" [(ngModel)]="addCost" [placeholder]="auth.isOwner() ? (a.unitCostCents / 100).toFixed(2) : 'Leave empty if unsure'" />
          </label>
          <label class="field">
            <span>Cash paid from the till (R) <span class="hint">– 0 if it was not paid from the till</span></span>
            <input name="at" inputmode="decimal" [(ngModel)]="addTill" />
          </label>
          <label class="field">
            <span>Supplier</span>
            <select name="as" [(ngModel)]="addSupplier">
              <option value="">— Not listed —</option>
              @for (sup of suppliers.data(); track sup.id) {
                <option [value]="sup.id">{{ sup.name }}</option>
              }
            </select>
          </label>
          <label class="field"><span>Invoice / slip number (optional)</span><input name="ai" [(ngModel)]="addInvoice" /></label>
          <div class="confirm-actions">
            <button type="button" class="btn" (click)="adding.set(null)">Cancel</button>
            <button class="btn primary" [disabled]="busy() || !(addQty() > 0)">Add {{ (addQty() || 0) | number: '1.0-3' }} {{ a.unit }}</button>
          </div>
        </form>
      </div>
    }
  `,
})
export class StockPage {
  protected readonly auth = inject(AuthService);
  private readonly biz = inject(BusinessService);
  private readonly api = inject(ApiService);
  private readonly upload = inject(UploadService);
  private readonly toast = inject(ToastService);
  protected readonly tab = signal<Tab>('levels');
  protected readonly busy = signal(false);
  protected readonly lossType = signal<LossType>('wastage');
  protected readonly lines = signal<DeliveryLine[]>([{ ingredientId: '', qty: '', cost: '' }]);
  /** stock never shows below zero (or as "-0") */
  protected readonly max0 = (n: number) => Math.max(0, n) || 0;
  protected supplierId = '';
  protected tillText = '0';
  protected invoiceRef = '';
  protected lossIngredient = '';
  protected lossQty = '';
  protected lossReason = '';
  private file: File | null = null;

  protected readonly ingredients = liveQuery<Ingredient>(() => query(this.biz.col('ingredients'), where('active', '==', true), orderBy('name')));
  protected readonly suppliers = liveQuery<Supplier>(() => query(this.biz.col('suppliers'), where('active', '==', true)));
  protected readonly movements = liveQuery<StockMovement>(() =>
    this.tab() !== 'history'
      ? null
      : this.auth.isOwner()
        ? query(this.biz.col('stockMovements'), orderBy('createdAt', 'desc'), limit(150))
        : query(this.biz.col('stockMovements'), where('createdBy', '==', this.auth.uid()), orderBy('createdAt', 'desc'), limit(100)),
  );

  protected readonly lowCount = computed(() => this.ingredients.data().filter(isLowStock).length);
  protected readonly stockValue = computed(() => this.ingredients.data().reduce((s, i) => s + Math.max(0, i.currentQty) * i.unitCostCents, 0));
  /** Plain method: delivery lines are mutated by ngModel, so a computed would not see the edits. */
  protected deliveryTotal(): number {
    return this.lines().reduce((s, l) => s + Math.round((Number(l.qty) || 0) * (parseRandToCents(l.cost) ?? 0)), 0);
  }

  protected low = isLowStock;

  /** Low items grouped by supplier, each with a ready-to-send WhatsApp order. */
  protected readonly reorder = computed(() => {
    const suppliers = new Map(this.suppliers.data().map((s) => [s.id, s]));
    const groups = new Map<string, { name: string; phone?: string; lines: { name: string; unit: string; qty: number; have: number }[] }>();
    for (const i of this.ingredients.data().filter(isLowStock)) {
      const qty = reorderQty(i);
      if (!qty) continue;
      const sup = i.supplierId ? suppliers.get(i.supplierId) : undefined;
      const key = sup?.id ?? '';
      const g = groups.get(key) ?? { name: sup?.name ?? 'No supplier set', phone: sup?.phone, lines: [] };
      g.lines.push({ name: i.name, unit: i.unit, qty, have: i.currentQty });
      groups.set(key, g);
    }
    const shop = this.biz.settings().businessName;
    return [...groups.values()].map((g) => {
      const greeting = g.phone || g.name !== 'No supplier set' ? `Hi ${g.name}, order from ${shop}:` : `Order from ${shop}:`;
      const text = [greeting, ...g.lines.map((l) => `• ${l.qty} ${l.unit} ${l.name}`), 'Thank you'].join('\n');
      return { ...g, text, whatsapp: `https://wa.me/${waPhone(g.phone) ?? ''}?text=${encodeURIComponent(text)}` };
    });
  });

  async copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      this.toast.ok('Order copied');
    } catch {
      this.toast.error('Could not copy – long-press to select the text instead');
    }
  }
  protected label(t: StockMovement['type']) {
    return MOVEMENT_LABELS[t];
  }

  addLine() {
    this.lines.update((l) => [...l, { ingredientId: '', qty: '', cost: '' }]);
  }
  removeLine(i: number) {
    this.lines.update((l) => l.filter((_, idx) => idx !== i));
  }
  prefillCost(line: DeliveryLine) {
    const ing = this.ingredients.data().find((i) => i.id === line.ingredientId);
    if (ing && !line.cost) line.cost = (ing.unitCostCents / 100).toFixed(2);
  }
  pick(event: Event) {
    this.file = (event.target as HTMLInputElement).files?.[0] ?? null;
  }

  async saveDelivery() {
    const lines = this.lines().filter((l) => l.ingredientId);
    // An empty cost keeps the item's current cost; a typed cost must be valid.
    const parsed = lines.map((l) => ({
      ingredientId: l.ingredientId,
      quantity: Number(l.qty),
      unitCostCents: l.cost.trim() ? parseRandToCents(l.cost) : null,
      badCost: !!l.cost.trim() && parseRandToCents(l.cost) === null,
    }));
    if (!parsed.length || parsed.some((l) => !(l.quantity > 0) || l.badCost)) {
      return this.toast.error('Each item needs a quantity (cost is optional, but must be a valid amount if entered)');
    }
    const till = parseRandToCents(this.tillText || '0');
    if (till === null) return this.toast.error('Cash from till is not a valid amount');
    await this.run(async () => {
      const receiptPath = this.file ? await this.upload.uploadReceipt(this.file) : undefined;
      await this.api.call('recordPurchase', {
        supplierId: this.supplierId || undefined,
        lines: parsed.map(({ ingredientId, quantity, unitCostCents }) => ({ ingredientId, quantity, unitCostCents })),
        paidFromTillCents: till,
        invoiceRef: this.invoiceRef || undefined,
        receiptPath,
      });
      this.toast.ok('Delivery saved – stock updated');
      this.lines.set([{ ingredientId: '', qty: '', cost: '' }]);
      this.tillText = '0';
      this.invoiceRef = '';
      this.file = null;
      this.tab.set('levels');
    });
  }

  // ---- quick "+ Add" on a stock row: adds on top, never overwrites ----
  protected readonly adding = signal<Ingredient | null>(null);
  protected readonly addQty = signal<number>(0);
  protected addCost = '';
  protected addTill = '0';
  protected addSupplier = '';
  protected addInvoice = '';

  startAdd(i: Ingredient) {
    this.adding.set(i);
    this.addQty.set(0);
    this.addCost = '';
    this.addTill = '0';
    this.addSupplier = i.supplierId ?? '';
    this.addInvoice = '';
  }

  async saveAdd(i: Ingredient) {
    const quantity = Number(this.addQty());
    if (!(quantity > 0)) return this.toast.error('Enter the quantity received');
    const cost = this.addCost.trim() ? parseRandToCents(this.addCost) : null;
    if (this.addCost.trim() && cost === null) return this.toast.error('Cost is not a valid amount');
    const till = parseRandToCents(this.addTill || '0');
    if (till === null) return this.toast.error('Cash from till is not a valid amount');
    await this.run(async () => {
      await this.api.call('recordPurchase', {
        supplierId: this.addSupplier || undefined,
        lines: [{ ingredientId: i.id, quantity, unitCostCents: cost }],
        paidFromTillCents: till,
        invoiceRef: this.addInvoice.trim() || undefined,
      });
      this.toast.ok(`Added ${quantity} ${i.unit} ${i.name}`);
      this.adding.set(null);
    });
  }

  async saveLoss() {
    const quantity = Number(this.lossQty);
    if (!this.lossIngredient || !quantity) return this.toast.error('Choose an item and quantity');
    await this.run(async () => {
      const res = await this.api.call('recordStockMovement', {
        ingredientId: this.lossIngredient,
        type: this.lossType(),
        quantity,
        reason: this.lossReason,
      });
      this.toast.ok(res.approvalId ? 'Sent to the owner for approval' : 'Saved');
      this.lossQty = '';
      this.lossReason = '';
    });
  }

  private async run(fn: () => Promise<void>) {
    this.busy.set(true);
    try {
      await fn();
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }
}
