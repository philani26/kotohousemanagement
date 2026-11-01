import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { orderBy, query, where } from 'firebase/firestore';
import { Ingredient, Order, PaymentMethod, Product, Recipe } from '@shared/models';
import { discountPercent, inOrderQueue } from '@shared/domain';
import { parseRandToCents } from '@shared/money';
import { ApiError, ApiService } from '../../core/api.service';
import { ConfirmService } from '../../core/confirm.service';
import { OrdersService } from '../../core/orders.service';
import { PendingChargeService } from '../../core/pending-charge.service';
import { OutboxService } from '../../core/outbox.service';
import { AuthService } from '../../core/auth.service';
import { BusinessService } from '../../core/business.service';
import { liveQuery } from '../../core/live';
import { ToastService } from '../../core/toast.service';
import { newSaleId } from '../../shared/ids';
import { ZarPipe } from '../../shared/pipes';
import { Receipt, printReceipt, whatsappReceiptUrl } from '../../shared/receipt';
import { OrderQueueComponent } from '../../shared/order-queue.component';

interface CartLine {
  product: Product;
  quantity: number;
}

/** A sale parked with "Save" (e.g. a customer still deciding). Kept on this device only. */
interface SavedSale {
  id: string;
  savedAt: number;
  lines: { productId: string; quantity: number }[];
  note: string;
  totalCents: number;
  summary: string;
}

/** Steps of the charge screen. */
type ChargeStep = 'method' | 'cash' | 'card' | 'eft' | 'processing' | 'done';

const METHODS: { id: PaymentMethod; label: string; ico: string; hint: string }[] = [
  { id: 'card', label: 'Card', ico: '💳', hint: 'Tap, insert or swipe on the card machine' },
  { id: 'cash', label: 'Cash', ico: '💵', hint: 'Enter what the customer hands over' },
  { id: 'eft', label: 'EFT', ico: '🏦', hint: 'Bank transfer or instant EFT' },
];

@Component({
  selector: 'app-pos',
  imports: [FormsModule, RouterLink, DatePipe, ZarPipe, OrderQueueComponent],
  template: `
    @if (outbox.count()) {
      <div class="alert" [class.warn]="!outbox.failed().length" [class.bad]="outbox.failed().length">
        @if (outbox.pending().length) {
          <strong>{{ outbox.pending().length }} sale(s) saved on this phone, waiting for internet.</strong>
          They will be sent automatically. Keep selling. Do not clear the browser or sign out.
          <button class="btn small" style="margin-left: .5rem" (click)="outbox.flush()">Send now</button>
        }
        @for (f of outbox.failed(); track f.request.saleId) {
          <div style="margin-top: .35rem">
            <strong>Sale of {{ f.request.expectedTotalCents ?? 0 | zar }} was refused:</strong> {{ f.error }}
            <button class="btn small" (click)="outbox.retry(f.request.saleId)">Retry</button>
            <button class="btn small ghost" (click)="discardFailed(f.request.saleId)">Discard</button>
          </div>
        }
      </div>
    }
    @if (!biz.openShiftLoading() && !biz.myOpenShift()) {
      <div class="alert warn">
        @if (biz.openShift()) {
          {{ biz.openShift()!.employeeName }}'s shift is open on this till. Only they (or the owner) can sell.
        } @else {
          <strong>No shift is open.</strong> Count the float and open the shift before selling.
          <a class="btn primary small" routerLink="/shift" style="margin-left: .5rem">Open shift</a>
        }
      </div>
    }

    <div class="register">
      <!-- ================= Catalogue ================= -->
      <section class="register-catalog">
        @if (panel() === 'products') {
          <div class="catalog-top">
            <label class="search">
              <span aria-hidden="true">🔍</span>
              <input type="search" placeholder="Search products" [ngModel]="search()" (ngModelChange)="search.set($event)" name="q" />
            </label>
          </div>
          <div class="chips" role="tablist">
            <button [class.on]="category() === 'all'" (click)="category.set('all')">All</button>
            @for (c of categories(); track c) {
              <button [class.on]="category() === c" (click)="category.set(c)">{{ labels()[c] ?? c }}</button>
            }
          </div>

          <div class="catalog-body">
            @if (products.loading()) {
              <p class="empty">Loading menu…</p>
            } @else if (products.data().length === 0) {
              <div class="empty">
                No products on the menu yet.
                @if (auth.isOwner()) {
                  <br /><a routerLink="/products">Set up the menu</a>
                }
              </div>
            } @else if (!visible().length) {
              <p class="empty">No products match "{{ search() }}"</p>
            }
            <div class="tiles">
              @for (p of visible(); track p.id) {
                <button class="tile" (click)="add(p)" [disabled]="!biz.myOpenShift()" [class.in-sale]="qtyOf(p.id)">
                  <span class="tile-art" [style.background]="tint(p.colour)" [style.color]="tileInk(p.colour)">{{ initials(p.name) }}</span>
                  <span class="tile-name">{{ p.name }}</span>
                  <span class="tile-price">{{ p.priceCents | zar }}</span>
                  @if (outOf().get(p.id); as missing) {
                    <span class="tile-out" title="Stock shows 0 – you can still sell if you have it">Out: {{ missing }}</span>
                  }
                  @if (qtyOf(p.id); as q) {
                    <span class="tile-qty">{{ q }}</span>
                  }
                </button>
              }
            </div>
          </div>
        } @else {
          <div class="catalog-body">
            <app-order-queue />
          </div>
        }

        <div class="catalog-foot">
          <div class="pill-toggle">
            <button [class.on]="panel() === 'products'" (click)="panel.set('products')">Products</button>
            <button [class.on]="panel() === 'orders'" (click)="panel.set('orders')">Orders</button>
          </div>
        </div>
      </section>

      <!-- ================= Current sale ================= -->
      <aside class="register-sale">
        <div class="sale-head">
          <h2>New sale</h2>
          @if (cart().length) {
            <button class="icon-btn" (click)="clear()" title="Clear sale" aria-label="Clear sale">🗑</button>
          }
        </div>
        @if (linkedTicket(); as wa) {
          <div class="wa-banner">
            <span>💬 WhatsApp order <strong>W{{ wa.ticketNo }}</strong> · {{ wa.customerName }}</span>
            <button class="icon-btn" (click)="unlinkTicket()" title="Stop charging this order" aria-label="Unlink">✕</button>
          </div>
        }
        <div class="sale-actions">
          <button class="chip-btn" [class.on]="showNote()" (click)="showNote.set(!showNote())">＋ Note</button>
          <button class="chip-btn" (click)="showSaved.set(true)" [disabled]="!saved().length">Saved ({{ saved().length }})</button>
        </div>
        @if (showNote()) {
          <input class="sale-note" [(ngModel)]="orderNote" name="note" maxlength="200" placeholder="Note for the kitchen, e.g. no atchar" />
        }

        <div class="sale-lines">
          @for (line of cart(); track line.product.id) {
            <div class="sale-line">
              <span class="line-dot" [style.background]="line.product.colour || '#0a8fd6'"></span>
              <div class="line-main">
                <div class="line-name">{{ line.product.name }}</div>
                <div class="line-sub">{{ line.product.priceCents | zar }} each</div>
              </div>
              <div class="line-qty">
                <button (click)="change(line.product.id, -1)" aria-label="One less">−</button>
                <span>{{ line.quantity }}</span>
                <button (click)="change(line.product.id, 1)" aria-label="One more">+</button>
              </div>
              <div class="line-total">{{ line.product.priceCents * line.quantity | zar }}</div>
            </div>
          } @empty {
            <div class="sale-empty">
              <div class="sale-empty-ico">🧾</div>
              Tap a product to add it to the sale
            </div>
          }
        </div>

        <div class="sale-foot">
          @if (showDiscount()) {
            <div class="discount-box">
              <div class="row between"><strong class="small">Discount</strong>
                <button class="icon-btn" (click)="removeDiscount()" aria-label="Remove discount">✕</button></div>
              <div class="row" style="gap: .5rem; flex-wrap: nowrap">
                <input inputmode="decimal" placeholder="R 0.00" [ngModel]="discountText()" (ngModelChange)="discountText.set($event)" name="disc" style="max-width: 110px" />
                <input [(ngModel)]="discountReason" name="discr" placeholder="Reason, e.g. loyal customer" />
              </div>
              @if (!auth.isOwner()) {
                <p class="tiny" style="margin: .35rem 0 0">
                  {{ maxDiscount() > 0 ? 'Up to ' + maxDiscount() + '% without the owner.' : 'Discounts need the owner (Settings).' }}
                </p>
              }
            </div>
          }
          <div class="sale-row">
            <span>Discount</span>
            @if (discountCents()) {
              <span class="neg">−{{ discountCents() | zar }}</span>
            } @else {
              <button class="add-circle" (click)="showDiscount.set(true)" [disabled]="!cart().length" aria-label="Add discount">⊕</button>
            }
          </div>
          <div class="sale-row total"><span>Total</span><span>{{ total() | zar }}</span></div>
          <div class="sale-buttons">
            <button class="btn save-btn" (click)="park()" [disabled]="!cart().length">Save</button>
            <button class="btn charge-btn" (click)="startCharge()" [disabled]="!canCharge()">Charge {{ cart().length ? (total() | zar) : '' }}</button>
          </div>
        </div>
      </aside>
    </div>

    @if (cart().length && !step()) {
      <div class="mobile-charge-bar">
        <button class="mcb-summary" (click)="showSale()">
          <strong>{{ cartCount() }} item{{ cartCount() === 1 ? '' : 's' }}</strong>
          <span class="tiny">View sale ↓</span>
        </button>
        <button class="btn charge-btn" (click)="startCharge()" [disabled]="!canCharge()">Charge {{ total() | zar }}</button>
      </div>
    }

    <!-- ================= Charge flow ================= -->
    @if (step(); as s) {
      <div class="charge-overlay" role="dialog" aria-modal="true" aria-label="Charge">
        <div class="charge-panel">
          @if (s !== 'processing' && s !== 'done') {
            <div class="charge-top">
              <button class="icon-btn" (click)="s === 'method' ? closeCharge() : step.set('method')" [attr.aria-label]="s === 'method' ? 'Close' : 'Back'">
                {{ s === 'method' ? '✕' : '←' }}
              </button>
              <span class="muted small">{{ cartCount() }} item(s)</span>
            </div>
            <div class="charge-amount">
              <div class="tiny">Amount due</div>
              <div class="amount">{{ total() | zar }}</div>
            </div>
          }

          @switch (s) {
            @case ('method') {
              <p class="charge-q">How is the customer paying?</p>
              <div class="method-tiles">
                @for (m of methods; track m.id) {
                  <button class="method-tile" (click)="chooseMethod(m.id)">
                    <span class="ico">{{ m.ico }}</span>
                    <span class="label">{{ m.label }}</span>
                    <span class="tiny">{{ m.hint }}</span>
                  </button>
                }
              </div>
            }

            @case ('cash') {
              <div class="cash-display" [class.short]="receivedCents() !== null && changeCents() === null">
                <div class="tiny">Cash received</div>
                <div class="amount">{{ (receivedCents() ?? 0) | zar }}</div>
                @if (changeCents() !== null) {
                  <div class="change-line">Change <strong>{{ changeCents()! | zar }}</strong></div>
                } @else if (receivedCents()) {
                  <div class="change-line short">{{ total() - (receivedCents() ?? 0) | zar }} still to pay</div>
                }
              </div>
              <div class="quick-amounts">
                <button (click)="setReceived(total())">Exact</button>
                @for (n of quickNotes(); track n) {
                  <button (click)="setReceived(n)">{{ n | zar }}</button>
                }
              </div>
              <div class="keypad">
                @for (k of keys; track k) {
                  <button (click)="press(k)" [attr.aria-label]="k === 'del' ? 'Delete' : k">{{ k === 'del' ? '⌫' : k }}</button>
                }
              </div>
              <button class="btn charge-btn block" [disabled]="changeCents() === null || busy()" (click)="pay()">
                Complete sale
              </button>
            }

            @case ('card') {
              <div class="pay-instruction">
                <div class="big-ico">💳</div>
                <p>Take <strong>{{ total() | zar }}</strong> on the card machine.</p>
                <p class="muted small">Only continue once the machine says <em>Approved</em>.</p>
              </div>
              <label class="field"><span>Slip number (optional)</span><input [(ngModel)]="reference" name="ref" /></label>
              <button class="btn charge-btn block" [disabled]="busy()" (click)="pay()">Payment approved</button>
            }

            @case ('eft') {
              <div class="pay-instruction">
                <div class="big-ico">🏦</div>
                <p>Ask the customer to pay <strong>{{ total() | zar }}</strong> by EFT.</p>
                <p class="muted small">Hand over the food only once the money shows in the account or a proof of payment is confirmed.</p>
              </div>
              <label class="field"><span>Reference (optional)</span><input [(ngModel)]="reference" name="ref" /></label>
              <button class="btn charge-btn block" [disabled]="busy()" (click)="pay()">Payment received</button>
            }

            @case ('processing') {
              <div class="pay-instruction">
                <div class="spinner" aria-hidden="true"></div>
                <p>Saving the sale…</p>
              </div>
            }

            @case ('done') {
              @if (last(); as l) {
                <div class="done">
                  <div class="done-check" [class.offline]="!l.receiptNo">{{ l.receiptNo ? '✓' : '⇅' }}</div>
                  <h2>{{ l.receiptNo ? 'Sale complete' : 'Saved on this phone' }}</h2>
                  <p class="muted small">
                    {{ l.receiptNo ? 'Receipt #' + l.receiptNo : 'No internet – it will be sent automatically' }} ·
                    {{ l.totalCents | zar }} by {{ l.method.toUpperCase() }} · {{ l.at | date: 'HH:mm' }}
                  </p>
                  @if (l.method === 'cash') {
                    <div class="done-change">
                      <div class="tiny">Change due</div>
                      <div class="amount">{{ (l.changeCents ?? 0) | zar }}</div>
                    </div>
                  }
                  <div class="done-receipts">
                    <button class="btn" (click)="print(l)">🖨 Print receipt</button>
                    <a class="btn" [href]="whatsapp(l)" target="_blank" rel="noopener">WhatsApp receipt</a>
                  </div>
                  <button class="btn charge-btn block" (click)="newSale()">New sale</button>
                </div>
              }
            }
          }
        </div>
      </div>
    }

    <!-- ================= Saved sales ================= -->
    @if (showSaved()) {
      <div class="dialog-backdrop" (click)="showSaved.set(false)">
        <div class="dialog" (click)="$event.stopPropagation()">
          <div class="row between"><h2 style="margin: 0">Saved sales</h2>
            <button class="icon-btn" (click)="showSaved.set(false)" aria-label="Close">✕</button></div>
          <p class="muted small">Parked on this device. Tap one to carry on with it.</p>
          <div class="list">
            @for (s of saved(); track s.id) {
              <div class="list-item">
                <div class="main" style="cursor: pointer" (click)="resume(s)">
                  <div class="title">{{ s.totalCents | zar }} · {{ s.savedAt | date: 'HH:mm' }}</div>
                  <div class="small muted">{{ s.summary }}</div>
                  @if (s.note) {
                    <div class="tiny">📝 {{ s.note }}</div>
                  }
                </div>
                <button class="btn small primary" (click)="resume(s)">Open</button>
                <button class="icon-btn" (click)="dropSaved(s.id)" aria-label="Delete saved sale">🗑</button>
              </div>
            } @empty {
              <p class="empty">No saved sales</p>
            }
          </div>
        </div>
      </div>
    }
  `,
})
export class PosPage {
  protected readonly biz = inject(BusinessService);
  protected readonly auth = inject(AuthService);
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  protected readonly outbox = inject(OutboxService);
  private readonly orders = inject(OrdersService);
  private readonly confirm = inject(ConfirmService);
  private readonly pending = inject(PendingChargeService);
  /** WhatsApp order being charged at collection (its ticket already exists) */
  protected readonly linkedTicket = signal<Order | null>(null);
  protected readonly methods = METHODS;
  protected readonly keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', 'del'];

  /** category id → name, from the owner's category list */
  protected readonly labels = computed<Record<string, string | undefined>>(() =>
    Object.fromEntries(this.biz.settings().productCategories.map((c) => [c.id, c.name])),
  );

  protected readonly products = liveQuery<Product>(() => query(this.biz.col('products'), where('active', '==', true), orderBy('sortOrder')));
  private readonly recipes = liveQuery<Recipe>(() => this.biz.col('recipes'));
  private readonly stockItems = liveQuery<Ingredient>(() => query(this.biz.col('ingredients'), where('active', '==', true)));
  /** product id → names of its ingredients that are at 0 (still sellable – the app's stock may be missing a delivery) */
  protected readonly outOf = computed(() => {
    const empty = new Map(this.stockItems.data().filter((i) => i.currentQty <= 0).map((i) => [i.id, i.name]));
    const out = new Map<string, string>();
    if (!empty.size) return out;
    for (const r of this.recipes.data()) {
      const names = r.lines.filter((l) => l.quantity > 0 && empty.has(l.ingredientId)).map((l) => empty.get(l.ingredientId)!);
      if (names.length) out.set(r.productId, names.join(', '));
    }
    return out;
  });

  protected readonly panel = signal<'products' | 'orders'>('products');
  protected readonly search = signal('');
  protected readonly category = signal<string>('all');
  /** chips in the owner's order; only categories that have products for sale */
  protected readonly categories = computed(() => {
    const used = new Set(this.products.data().map((p) => p.category));
    const ordered = this.biz.settings().productCategories.map((c) => c.id).filter((id) => used.has(id));
    return [...ordered, ...[...used].filter((id) => !ordered.includes(id))];
  });
  protected readonly visible = computed(() => {
    const c = this.category();
    const q = this.search().trim().toLowerCase();
    return this.products.data().filter((p) => (c === 'all' || p.category === c) && (!q || p.name.toLowerCase().includes(q)));
  });

  // ---- current sale ----
  protected readonly cart = signal<CartLine[]>([]);
  protected readonly cartCount = computed(() => this.cart().reduce((s, l) => s + l.quantity, 0));
  protected readonly method = signal<PaymentMethod>('cash');
  protected readonly receivedText = signal('');
  protected readonly showDiscount = signal(false);
  protected readonly showNote = signal(false);
  protected readonly busy = signal(false);
  protected readonly last = signal<Receipt | null>(null);
  protected readonly discountText = signal('');
  protected discountReason = '';
  protected reference = '';
  protected orderNote = '';
  /** Idempotency key for the current order; only replaced after the server confirms. */
  private saleId = newSaleId();

  protected readonly subtotal = computed(() => this.cart().reduce((s, l) => s + l.product.priceCents * l.quantity, 0));
  protected readonly discountCents = computed(() =>
    this.showDiscount() ? Math.min(parseRandToCents(this.discountText() || '0') ?? 0, this.subtotal()) : 0,
  );
  protected readonly total = computed(() => this.subtotal() - this.discountCents());
  protected readonly receivedCents = computed(() => parseRandToCents(this.receivedText()));
  protected readonly changeCents = computed(() => {
    const r = this.receivedCents();
    return r !== null && r >= this.total() ? r - this.total() : null;
  });
  protected readonly maxDiscount = computed(() => this.biz.settings().maxEmployeeDiscountPercent);
  protected readonly canCharge = computed(() => !this.busy() && !!this.biz.myOpenShift() && this.cart().length > 0);
  /** note values just above the total, e.g. R50, R100, R200 for a R45 sale */
  protected readonly quickNotes = computed(() => {
    const t = this.total();
    return [2000, 5000, 10000, 20000, 50000].filter((n) => n > t).slice(0, 3);
  });

  // ---- charge flow ----
  protected readonly step = signal<ChargeStep | null>(null);

  // ---- saved (parked) sales, per user and shop on this device ----
  protected readonly saved = signal<SavedSale[]>([]);
  protected readonly showSaved = signal(false);
  private readonly savedKey = computed(() => `kotahouse.saved.${this.auth.uid()}.${this.auth.businessId()}`);

  constructor() {
    effect(() => {
      const key = this.savedKey();
      untracked(() => this.saved.set(readJson<SavedSale[]>(key) ?? []));
    });
    // A WhatsApp order sent here from the queue: load it once the menu is available.
    effect(() => {
      const ticket = this.pending.ticket();
      const products = this.products.data();
      if (!ticket || this.products.loading()) return;
      untracked(() => this.loadTicket(this.pending.take()!, products));
    });
  }

  private loadTicket(ticket: Order, products: Product[]) {
    const byId = new Map(products.map((p) => [p.id, p]));
    const items = ticket.items ?? [];
    const lines = items.filter((i) => byId.has(i.productId)).map((i) => ({ product: byId.get(i.productId)!, quantity: i.quantity }));
    if (lines.length < items.length) this.toast.info('Some items are no longer on the menu and were left out');
    this.clear();
    this.cart.set(lines);
    this.orderNote = ticket.note ?? '';
    this.showNote.set(!!ticket.note);
    this.linkedTicket.set(ticket);
    if (ticket.totalCents !== undefined && ticket.totalCents !== this.subtotal()) {
      this.toast.info("Prices changed since the customer ordered – the till uses today's prices");
    }
  }

  unlinkTicket() {
    this.linkedTicket.set(null);
  }

  /** "Russian Kota" → RK, "Chips (small)" → CS: letters and digits only */
  protected initials(name: string) {
    const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (!words.length) return '?';
    return (words.length > 1 ? words[0][0] + words[1][0] : words[0].slice(0, 2)).toUpperCase();
  }

  /** product colour for the initials, darkened when it is too pale to read on its tint */
  protected tileInk(colour?: string) {
    const hex = /^#([0-9a-f]{6})$/i.exec(colour ?? '')?.[1];
    if (!hex) return '#0a8fd6';
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const light = (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62;
    return light ? `rgb(${Math.round(r * 0.55)}, ${Math.round(g * 0.55)}, ${Math.round(b * 0.55)})` : colour!;
  }

  /** phones: jump from the product list to the sale */
  protected showSale() {
    document.querySelector('.register-sale')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /** soft background from the product colour */
  protected tint(colour?: string) {
    return colour ? `${colour}22` : '#e6f4fc';
  }

  qtyOf(id: string): number {
    return this.cart().find((l) => l.product.id === id)?.quantity ?? 0;
  }

  add(product: Product) {
    this.cart.update((lines) => {
      const found = lines.find((l) => l.product.id === product.id);
      return found ? lines.map((l) => (l === found ? { ...l, quantity: l.quantity + 1 } : l)) : [...lines, { product, quantity: 1 }];
    });
  }

  change(id: string, delta: number) {
    this.cart.update((lines) => lines.map((l) => (l.product.id === id ? { ...l, quantity: l.quantity + delta } : l)).filter((l) => l.quantity > 0));
  }

  removeDiscount() {
    this.showDiscount.set(false);
    this.discountText.set('');
    this.discountReason = '';
  }

  clear() {
    this.cart.set([]);
    this.receivedText.set('');
    this.removeDiscount();
    this.reference = '';
    this.orderNote = '';
    this.showNote.set(false);
    this.linkedTicket.set(null);
    this.saleId = newSaleId();
  }

  // ---- charge flow ----
  startCharge() {
    const discount = this.discountCents();
    if (discount > 0 && !this.discountReason.trim()) return this.toast.error('Give a reason for the discount');
    if (discount > 0 && !this.auth.isOwner() && discountPercent(discount, this.subtotal()) > this.maxDiscount()) {
      return this.toast.error(`Discounts above ${this.maxDiscount()}% need the owner`);
    }
    this.receivedText.set('');
    this.reference = '';
    this.step.set('method');
  }

  chooseMethod(m: PaymentMethod) {
    this.method.set(m);
    this.step.set(m);
  }

  closeCharge() {
    if (!this.busy()) this.step.set(null);
  }

  setReceived(cents: number) {
    this.receivedText.set((cents / 100).toFixed(2));
  }

  /** keypad types cents from the right, like a card machine: 4-5-0-0 → R45.00 */
  press(key: string) {
    const digits = String(this.receivedCents() ?? 0).replace(/^0+/, '');
    const next = key === 'del' ? digits.slice(0, -1) : (digits + key).slice(0, 8);
    this.setReceived(Number(next || '0'));
  }

  newSale() {
    this.step.set(null);
    this.last.set(null);
  }

  async pay() {
    const discount = this.discountCents();
    const request = {
      saleId: this.saleId,
      items: this.cart().map((l) => ({ productId: l.product.id, quantity: l.quantity })),
      discountCents: discount,
      discountReason: discount ? this.discountReason.trim() : undefined,
      payment: {
        method: this.method(),
        amountReceivedCents: this.method() === 'cash' ? (this.receivedCents() ?? undefined) : undefined,
        reference: this.reference.trim() || undefined,
      },
      soldAtMillis: Date.now(),
      expectedTotalCents: this.total(),
    };
    const receipt: Receipt = {
      receiptNo: null,
      at: request.soldAtMillis,
      cashier: this.auth.displayName(),
      lines: this.cart().map((l) => ({ name: l.product.name, quantity: l.quantity, lineTotalCents: l.product.priceCents * l.quantity })),
      subtotalCents: this.subtotal(),
      discountCents: discount,
      totalCents: this.total(),
      method: this.method(),
      receivedCents: request.payment.amountReceivedCents,
      changeCents: this.changeCents() ?? undefined,
    };
    // Extras and other non-kitchen items stay off the order queue.
    const ticketLines = this.cart()
      .filter((l) => inOrderQueue(l.product))
      .map((l) => ({ name: l.product.name, quantity: l.quantity }));
    const previous = this.step();
    this.busy.set(true);
    this.step.set('processing');
    try {
      const res = await this.api.call('recordSale', request);
      const linked = this.linkedTicket();
      if (linked) {
        // WhatsApp order: its ticket already exists – just mark it paid.
        this.orders.markPaid(linked.id, request.saleId, res.receiptNo);
      } else if (!res.duplicate && ticketLines.length) {
        // A duplicate means this sale (and its ticket) already exists – don't reset the ticket to "new".
        this.orders.create(request.saleId, ticketLines, this.orderNote, res.receiptNo);
      }
      if (res.duplicate) this.toast.info(`This order was already saved as receipt #${res.receiptNo}`);
      this.last.set({ ...receipt, receiptNo: res.receiptNo, totalCents: res.totalCents, changeCents: res.changeCents });
      this.clear();
      this.step.set('done');
    } catch (err) {
      if (err instanceof ApiError && err.network) {
        // No internet: keep the sale on this phone; the outbox sends it (same saleId) when the network is back.
        this.outbox.enqueue(request);
        const linked = this.linkedTicket();
        if (linked) this.orders.markPaid(linked.id, request.saleId, null);
        else if (ticketLines.length) this.orders.create(request.saleId, ticketLines, this.orderNote, null);
        this.last.set(receipt);
        this.clear();
        this.step.set('done');
      } else {
        // Keep the cart and saleId: retrying is safe, it can never be recorded twice.
        this.toast.error(err);
        this.step.set(previous === 'processing' ? 'method' : previous);
      }
    } finally {
      this.busy.set(false);
    }
  }

  print(r: Receipt) {
    printReceipt(r, this.biz.settings().businessName);
  }

  whatsapp(r: Receipt) {
    return whatsappReceiptUrl(r, this.biz.settings().businessName);
  }

  // ---- saved sales ----
  park() {
    if (!this.cart().length) return;
    const entry: SavedSale = {
      id: newSaleId(),
      savedAt: Date.now(),
      lines: this.cart().map((l) => ({ productId: l.product.id, quantity: l.quantity })),
      note: this.orderNote,
      totalCents: this.total(),
      summary: this.cart().map((l) => `${l.quantity}× ${l.product.name}`).join(', '),
    };
    this.writeSaved([entry, ...this.saved()].slice(0, 30));
    this.clear();
    this.toast.ok('Sale saved – open it again from "Saved"');
  }

  async resume(s: SavedSale) {
    if (this.cart().length) {
      const ok = await this.confirm.ask({
        title: 'Replace the current sale?',
        message: 'The items in the current sale will be cleared. Save it first if you still need it.',
        confirmText: 'Replace',
      });
      if (!ok) return;
    }
    const byId = new Map(this.products.data().map((p) => [p.id, p]));
    const lines = s.lines.filter((l) => byId.has(l.productId)).map((l) => ({ product: byId.get(l.productId)!, quantity: l.quantity }));
    if (lines.length < s.lines.length) this.toast.info('Some items are no longer on the menu and were left out');
    this.clear();
    this.cart.set(lines);
    this.orderNote = s.note;
    this.showNote.set(!!s.note);
    this.dropSaved(s.id);
    this.showSaved.set(false);
  }

  dropSaved(id: string) {
    this.writeSaved(this.saved().filter((s) => s.id !== id));
  }

  private writeSaved(list: SavedSale[]) {
    this.saved.set(list);
    try {
      localStorage.setItem(this.savedKey(), JSON.stringify(list));
    } catch {
      // storage blocked: saved sales last until the page reloads
    }
  }

  async discardFailed(saleId: string) {
    const ok = await this.confirm.ask({
      title: 'Discard this sale?',
      message: 'It will be removed from this phone and will NOT be in the records. Tell the owner so they can record it.',
      confirmText: 'Discard sale',
      tone: 'danger',
    });
    if (ok) this.outbox.discard(saleId);
  }
}

function readJson<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') as T | null;
  } catch {
    return null;
  }
}
