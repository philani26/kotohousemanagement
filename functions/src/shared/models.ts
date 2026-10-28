import { Cents } from './money';

/**
 * Firestore data model. Every business-owned collection lives under
 * `businesses/{businessId}/<collection>/{docId}` so that security rules can
 * scope access by the `businessId` custom claim on the user's token.
 *
 * Both the Admin SDK and the web SDK Timestamp classes satisfy TimestampLike.
 */
export interface TimestampLike {
  toMillis(): number;
  toDate(): Date;
}

export type Role = 'owner' | 'employee';
export type PaymentMethod = 'cash' | 'card' | 'eft';
export const PAYMENT_METHODS: readonly PaymentMethod[] = ['cash', 'card', 'eft'];

/**
 * Custom claims set only by trusted backend code.
 * `biz` lists every shop the user belongs to with their role there (an owner
 * may run several kota houses). `businessId`/`role` are the default shop,
 * kept for accounts created before multi-shop support.
 */
export interface UserClaims {
  businessId: string;
  role: Role;
  biz?: Record<string, Role>;
}

/** All shops a token grants access to, including the legacy single-shop claim. */
export function claimMemberships(token: Partial<UserClaims> | undefined | null): Record<string, Role> {
  const out: Record<string, Role> = {};
  if (token?.businessId && token.role) out[token.businessId] = token.role;
  for (const [b, r] of Object.entries(token?.biz ?? {})) if (r === 'owner' || r === 'employee') out[b] = r;
  return out;
}

export const COLLECTIONS = {
  users: 'users', // top level: users/{uid}
  businesses: 'businesses',
  employees: 'employees',
  products: 'products',
  recipes: 'recipes',
  ingredients: 'ingredients',
  stockMovements: 'stockMovements',
  suppliers: 'suppliers',
  purchases: 'purchases',
  sales: 'sales',
  expenses: 'expenses',
  cashSessions: 'cashSessions',
  shifts: 'shifts',
  approvals: 'approvals',
  auditLogs: 'auditLogs',
  notifications: 'notifications',
  businessSettings: 'businessSettings',
  dailyStats: 'dailyStats',
  orders: 'orders',
} as const;

export const SETTINGS_DOC_ID = 'main';

/** users/{uid} – a read-only mirror of the user's claims for the client. */
export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  businessId: string;
  role: Role;
  active: boolean;
  createdAt: TimestampLike;
}

/** businesses/{businessId} */
export interface Business {
  id: string;
  name: string;
  ownerUid: string;
  createdAt: TimestampLike;
}

/** businesses/{b}/employees/{uid} */
export interface Employee {
  uid: string;
  displayName: string;
  email: string;
  phone?: string;
  role: Role;
  active: boolean;
  createdAt: TimestampLike;
  createdBy: string;
}

/** A menu category. `extras` is special: its products stay off the order queue by default. */
export interface ProductCategory {
  id: string;
  name: string;
}

/** businesses/{b}/products/{productId} */
export interface Product {
  id: string;
  name: string;
  /** id of a category in settings.productCategories */
  category: string;
  priceCents: Cents;
  active: boolean;
  sortOrder: number;
  colour?: string;
  /** whether it goes on the kitchen order queue; unset = everything except extras */
  orderQueue?: boolean;
  updatedAt?: TimestampLike;
}

export interface RecipeLine {
  ingredientId: string;
  /** quantity of the ingredient's unit consumed per one product sold */
  quantity: number;
}

/** businesses/{b}/recipes/{productId} – one recipe per product, keyed by product id. */
export interface Recipe {
  productId: string;
  lines: RecipeLine[];
  updatedAt?: TimestampLike;
}

export type IngredientUnit = 'each' | 'kg' | 'g' | 'litre' | 'ml' | 'pack' | 'loaf' | 'slice';

/** businesses/{b}/ingredients/{ingredientId} */
export interface Ingredient {
  id: string;
  name: string;
  unit: IngredientUnit;
  openingQty: number;
  /** theoretical balance, maintained only by backend functions */
  currentQty: number;
  /** cost per one unit, in cents */
  unitCostCents: Cents;
  reorderLevel: number;
  /** high-risk items (e.g. Russians, cheese, drinks) that must be counted at every close */
  countDaily?: boolean;
  supplierId?: string;
  active: boolean;
  updatedAt?: TimestampLike;
}

/** businesses/{b}/suppliers/{supplierId} */
export interface Supplier {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  notes?: string;
  active: boolean;
}

export type StockMovementType =
  | 'opening'
  | 'purchase'
  | 'sale'
  | 'wastage'
  | 'staffMeal'
  | 'complimentary'
  | 'adjustment';

/** Movement types an employee may record directly. */
export const EMPLOYEE_STOCK_TYPES: readonly StockMovementType[] = ['wastage', 'staffMeal', 'complimentary'];

/** businesses/{b}/stockMovements/{id} – append-only ledger of every stock change. */
export interface StockMovement {
  id: string;
  ingredientId: string;
  ingredientName: string;
  type: StockMovementType;
  /** signed change in the ingredient's unit (negative = stock out) */
  qtyChange: number;
  unitCostCents: Cents;
  /** absolute value of the movement at unit cost */
  valueCents: Cents;
  reason?: string;
  /** quantity that could not be taken because stock had run out */
  shortfallQty?: number;
  refType?: 'sale' | 'purchase' | 'approval' | 'ingredient';
  refId?: string;
  shiftId?: string | null;
  createdBy: string;
  createdByName: string;
  createdAt: TimestampLike;
  dayKey: string;
}

export interface PurchaseLine {
  ingredientId: string;
  ingredientName: string;
  quantity: number;
  unitCostCents: Cents;
  lineTotalCents: Cents;
}

/** businesses/{b}/purchases/{id} – a stock delivery. */
export interface Purchase {
  id: string;
  supplierId?: string;
  supplierName?: string;
  lines: PurchaseLine[];
  totalCents: Cents;
  /** cash taken from the till to pay for this delivery (reduces expected cash) */
  paidFromTillCents: Cents;
  invoiceRef?: string;
  receiptPath?: string;
  shiftId?: string | null;
  createdBy: string;
  createdByName: string;
  createdAt: TimestampLike;
  dayKey: string;
}

export interface SaleLine {
  productId: string;
  name: string;
  quantity: number;
  unitPriceCents: Cents;
  lineTotalCents: Cents;
}

export type SaleStatus = 'completed' | 'refundPending' | 'refunded';

export interface SalePayment {
  method: PaymentMethod;
  amountReceivedCents?: Cents; // cash only
  changeCents?: Cents; // cash only
  reference?: string; // card slip / EFT reference
  verified?: boolean; // card/EFT matched against bank or terminal records
  verifiedBy?: string;
  verifiedAt?: TimestampLike;
}

/** businesses/{b}/sales/{saleId} – saleId is the client-generated idempotency key. */
export interface Sale {
  id: string;
  receiptNo: number;
  shiftId: string;
  employeeId: string;
  employeeName: string;
  lines: SaleLine[];
  subtotalCents: Cents;
  discountCents: Cents;
  discountReason?: string;
  totalCents: Cents;
  /** estimated ingredient cost from recipes at time of sale */
  costCents: Cents;
  payment: SalePayment;
  status: SaleStatus;
  /** when the sale actually happened; differs from createdAt for sales synced after being offline */
  soldAt?: TimestampLike;
  offline?: boolean;
  refund?: {
    reason: string;
    requestedBy: string;
    requestedAt: TimestampLike;
    approvalId: string;
    decidedBy?: string;
    decidedAt?: TimestampLike;
  };
  createdAt: TimestampLike;
  dayKey: string;
}

export type OrderStatus = 'new' | 'preparing' | 'ready' | 'collected';
export const ORDER_STATUSES: readonly OrderStatus[] = ['new', 'preparing', 'ready', 'collected'];

/**
 * businesses/{b}/orders/{saleId} – the kitchen ticket for a paid sale.
 * Operational only (no prices): staff create it at the till and move it
 * through the queue. Money lives in `sales`, which stays locked.
 * Written from the device so the queue keeps working offline.
 */
export interface Order {
  id: string;
  /** receipt number once the sale has reached the server */
  receiptNo?: number | null;
  lines: { name: string; quantity: number }[];
  note?: string;
  status: OrderStatus;
  /** device time, so offline orders sort correctly before they sync */
  createdAtMillis: number;
  createdBy: string;
  createdByName: string;
  dayKey: string;
  preparingAt?: number;
  readyAt?: number;
  collectedAt?: number;
  updatedBy: string;
  updatedAt: TimestampLike;
}

export type ExpenseStatus = 'submitted' | 'approved' | 'rejected';

/** businesses/{b}/expenses/{id} */
export interface Expense {
  id: string;
  amountCents: Cents;
  category: string;
  description: string;
  date: string; // YYYY-MM-DD the expense was incurred
  paidFromTill: boolean;
  receiptPath?: string;
  status: ExpenseStatus;
  shiftId?: string | null;
  submittedBy: string;
  submittedByName: string;
  createdAt: TimestampLike;
  approvalId: string;
  decision?: { by: string; byName: string; at: TimestampLike; note?: string };
}

export interface ChecklistAnswer {
  item: string;
  done: boolean;
}

export interface StockCountLine {
  ingredientId: string;
  ingredientName: string;
  unit: IngredientUnit;
  theoreticalQty: number;
  countedQty: number;
  varianceQty: number;
  varianceCents: Cents;
}

export type ShiftStatus = 'open' | 'closed';

/** businesses/{b}/shifts/{shiftId} */
export interface Shift {
  id: string;
  employeeId: string;
  employeeName: string;
  status: ShiftStatus;
  openedAt: TimestampLike;
  closedAt?: TimestampLike;
  dayKey: string;
  cashSessionId: string;
  openingChecklist: ChecklistAnswer[];
  closingChecklist?: ChecklistAnswer[];
  stockCounts?: StockCountLine[];
  lastSaleAt?: TimestampLike;
  notes?: string;
}

export interface CashPayout {
  amountCents: Cents;
  reason: string;
  by: string;
  byName: string;
  at: number; // millis (arrays can't hold server timestamps)
}

/**
 * businesses/{b}/cashSessions/{shiftId} – one per shift.
 * Running totals are maintained by backend functions only. Employees cannot
 * read this document (blind cash count).
 */
export interface CashSession {
  id: string;
  shiftId: string;
  employeeId: string;
  employeeName: string;
  status: ShiftStatus;
  dayKey: string;
  openingFloatCents: Cents;
  cashSalesCents: Cents;
  cashRefundsCents: Cents;
  approvedCashExpensesCents: Cents;
  pendingCashExpensesCents: Cents;
  cashPayoutsCents: Cents;
  payouts: CashPayout[];
  cardSalesCents: Cents;
  eftSalesCents: Cents;
  openedAt: TimestampLike;
  closedAt?: TimestampLike;
  // set at close
  expectedCashCents?: Cents;
  countedCashCents?: Cents;
  differenceCents?: Cents;
  explanation?: string;
  cardTerminalTotalCents?: Cents | null;
  cardDifferenceCents?: Cents | null;
}

export type ApprovalType = 'refund' | 'expense' | 'stockAdjustment';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

/** businesses/{b}/approvals/{id} – every restricted action awaiting the owner. */
export interface Approval {
  id: string;
  type: ApprovalType;
  status: ApprovalStatus;
  refId: string;
  summary: string;
  amountCents: Cents;
  payload: Record<string, unknown>;
  requestedBy: string;
  requestedByName: string;
  requestedAt: TimestampLike;
  decidedBy?: string;
  decidedByName?: string;
  decidedAt?: TimestampLike;
  note?: string;
}

/** businesses/{b}/auditLogs/{id} – written only by backend code. */
export interface AuditLog {
  id: string;
  action: string;
  entity: string;
  entityId: string;
  actorUid: string;
  actorName: string;
  actorRole: Role | 'system';
  details: Record<string, unknown>;
  at: TimestampLike;
  dayKey: string;
}

export type NotificationType =
  | 'cashDiscrepancy'
  | 'lowStock'
  | 'refundRequest'
  | 'largeDiscount'
  | 'excessiveWastage'
  | 'missingClose'
  | 'noSales'
  | 'pendingExpense'
  | 'stockVariance'
  | 'shiftClosed'
  | 'tillPurchase'
  | 'cashPayout'
  | 'notOpened'
  | 'priceMismatch'
  | 'outOfStock';

export type Severity = 'info' | 'warning' | 'critical';

/** businesses/{b}/notifications/{id} – owner-facing alerts. */
export interface AppNotification {
  id: string;
  type: NotificationType;
  severity: Severity;
  title: string;
  message: string;
  /** the full picture: amounts, people, times, reasons – shown when the alert is opened */
  details?: NotificationDetail[];
  /** who caused it (cashier name), or "System" for scheduled checks */
  actorName?: string;
  /** what the owner should do about it */
  action?: string;
  link?: string;
  read: boolean;
  createdAt: TimestampLike;
}

export interface NotificationDetail {
  label: string;
  value: string;
  /** colour the value: bad = loss/shortage, good = surplus/ok */
  tone?: 'bad' | 'good' | 'warn';
}

export interface AlertThresholds {
  /** alert when |counted − expected| exceeds this */
  cashDiscrepancyCents: Cents;
  refundAlertCents: Cents;
  discountAlertPercent: number;
  /** daily wastage value that triggers an alert */
  wastageAlertCents: Cents;
  /** stock count variance value that triggers an alert */
  stockVarianceAlertCents: Cents;
  /** minutes without a sale during trading hours before alerting */
  noSaleMinutes: number;
  /** minutes after closing time before a missing close is reported */
  missingCloseGraceMinutes: number;
}

/** businesses/{b}/businessSettings/main */
export interface BusinessSettings {
  businessName: string;
  currency: 'ZAR';
  timezone: string;
  /** 24h local hours, e.g. 9 and 20 */
  openingHour: number;
  closingHour: number;
  /** days the shop trades, 0 = Sunday … 6 = Saturday */
  tradingDays: number[];
  /** employees may discount up to this % of the order without approval; 0 = never */
  maxEmployeeDiscountPercent: number;
  thresholds: AlertThresholds;
  expenseCategories: string[];
  /** menu categories, in the order shown on the Sell screen; managed by the owner */
  productCategories: ProductCategory[];
  openingChecklist: string[];
  closingChecklist: string[];
  notifications: {
    email: boolean;
    emailTo: string[];
    /** WhatsApp requires an approved WhatsApp Business API provider – off until configured. */
    whatsapp: boolean;
    whatsappTo: string[];
  };
  cctv: {
    provider: string;
    /** deep link / web URL of the recorder's secure remote viewing app */
    viewerUrl: string;
    androidAppUrl: string;
    iosAppUrl: string;
    notes: string;
  };
  receiptCounter?: number;
  updatedAt?: TimestampLike;
}

/** businesses/{b}/dailyStats/{YYYY-MM-DD} – aggregate counters maintained by functions. */
export interface DailyStats {
  dayKey: string;
  grossSalesCents: Cents; // after discounts, before refunds
  discountsCents: Cents;
  refundsCents: Cents;
  orders: number;
  refundCount: number;
  byMethod: Record<PaymentMethod, Cents>;
  cogsCents: Cents;
  refundedCogsCents: Cents;
  operatingExpensesCents: Cents; // approved, non-inventory expenses
  inventoryPurchasesCents: Cents;
  wastageCostCents: Cents;
  staffMealCostCents: Cents;
  /** signed value of approved stock adjustments (negative = unexplained loss) */
  stockAdjustmentCents: Cents;
  products: Record<string, { name: string; qty: number; revenueCents: Cents }>;
  hourly: Record<string, Cents>;
}

export const EXPENSE_INVENTORY_CATEGORY = 'Ingredients & stock';

export const DEFAULT_SETTINGS: BusinessSettings = {
  businessName: 'Kota House',
  currency: 'ZAR',
  timezone: 'Africa/Johannesburg',
  openingHour: 9,
  closingHour: 20,
  tradingDays: [0, 1, 2, 3, 4, 5, 6],
  maxEmployeeDiscountPercent: 0,
  thresholds: {
    cashDiscrepancyCents: 2000,
    refundAlertCents: 10000,
    discountAlertPercent: 10,
    wastageAlertCents: 5000,
    stockVarianceAlertCents: 5000,
    noSaleMinutes: 120,
    missingCloseGraceMinutes: 60,
  },
  productCategories: [
    { id: 'kota', name: 'Kotas' },
    { id: 'sides', name: 'Chips & sides' },
    { id: 'drinks', name: 'Drinks' },
    { id: 'extras', name: 'Extras' },
    { id: 'other', name: 'Other' },
  ],
  expenseCategories: [
    EXPENSE_INVENTORY_CATEGORY,
    'Gas',
    'Electricity',
    'Transport',
    'Cleaning supplies',
    'Packaging',
    'Equipment repairs',
    'Other',
  ],
  openingChecklist: [
    'Counted opening float',
    'Fryer and stove checked',
    'Work surfaces cleaned',
    'Stock looks correct',
  ],
  closingChecklist: [
    'Fryer switched off and cleaned',
    'Gas closed',
    'Cash counted and locked away',
    'Floors and counters cleaned',
    'Doors and windows locked',
  ],
  notifications: { email: false, emailTo: [], whatsapp: false, whatsappTo: [] },
  cctv: { provider: '', viewerUrl: '', androidAppUrl: '', iosAppUrl: '', notes: '' },
};
