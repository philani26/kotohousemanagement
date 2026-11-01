import { Cents } from './money';
import { DeviceStatus, Span } from './devices';
import { CartItem } from './domain';
import { ChecklistAnswer, PaymentMethod, Role, StockCountLine, StockMovementType } from './models';

/**
 * Request/response contracts for the callable Cloud Functions.
 * The Angular ApiService and the backend both import these types.
 */
export interface Api {
  setupBusiness: [{ businessName: string; displayName: string }, { businessId: string }];
  createEmployee: [
    { email: string; password: string; displayName: string; phone?: string; role: Role },
    { uid: string },
  ];
  updateEmployee: [{ uid: string; active?: boolean; displayName?: string; phone?: string; password?: string }, { ok: true }];

  openShift: [{ openingFloatCents: Cents; checklist: ChecklistAnswer[] }, { shiftId: string }];
  recordPayout: [{ amountCents: Cents; reason: string }, { ok: true }];
  closeShift: [
    {
      shiftId: string;
      countedCashCents: Cents;
      cardTerminalTotalCents?: Cents | null;
      explanation?: string;
      checklist: ChecklistAnswer[];
      stockCounts: { ingredientId: string; countedQty: number }[];
      notes?: string;
    },
    {
      expectedCashCents: Cents;
      differenceCents: Cents;
      cardDifferenceCents: Cents | null;
      stockVariances: StockCountLine[];
    },
  ];

  recordSale: [
    {
      /** client-generated UUID; repeating a call with the same id never creates a second sale */
      saleId: string;
      items: CartItem[];
      discountCents?: Cents;
      discountReason?: string;
      /** split payments: cashCents in cash, the rest by method (card/EFT) */
      payment: { method: PaymentMethod; amountReceivedCents?: Cents; cashCents?: Cents; reference?: string };
      /** set by the offline queue: when the sale was rung up on the device */
      soldAtMillis?: number;
      /** total the cashier charged; flags price changes between an offline sale and its sync */
      expectedTotalCents?: Cents;
    },
    { saleId: string; receiptNo: number; totalCents: Cents; changeCents: Cents; duplicate: boolean },
  ];
  requestRefund: [{ saleId: string; reason: string }, { approvalId: string }];
  verifyPayment: [{ saleId: string; verified: boolean }, { ok: true }];

  submitExpense: [
    {
      amountCents: Cents;
      category: string;
      description: string;
      date: string;
      paidFromTill: boolean;
      receiptPath?: string;
    },
    { expenseId: string },
  ];

  recordPurchase: [
    {
      supplierId?: string;
      /** unitCostCents may be left out: the item's current cost is used and stays unchanged */
      lines: { ingredientId: string; quantity: number; unitCostCents?: Cents | null }[];
      paidFromTillCents: Cents;
      invoiceRef?: string;
      receiptPath?: string;
    },
    { purchaseId: string },
  ];
  recordStockMovement: [
    {
      ingredientId: string;
      type: Extract<StockMovementType, 'wastage' | 'staffMeal' | 'complimentary' | 'adjustment'>;
      /** positive quantity for losses; signed for adjustments */
      quantity: number;
      reason: string;
    },
    { movementId?: string; approvalId?: string },
  ];

  deviceHeartbeat: [
    {
      deviceId: string;
      userAgent: string;
      batteryPct?: number | null;
      charging?: boolean | null;
      spans?: Span[];
      location?: { lat: number; lng: number; accuracyM: number } | null;
    },
    { status: DeviceStatus; code: string; shareLocation: boolean },
  ];
  createDeviceInvite: [{ label: string }, { code: string; expiresAtMillis: number }];
  pairDevice: [{ code: string; deviceId: string; userAgent: string }, { status: DeviceStatus; label: string }];
  setDevice: [{ deviceId: string; status?: DeviceStatus; label?: string }, { ok: true }];
  checkIn: [
    { lat: number; lng: number; accuracyM: number },
    { ok: boolean; distanceM?: number; reason?: 'inaccurate' | 'outside' | 'not-configured'; until?: number },
  ];
  linkWhatsapp: [{ ordering: boolean; phoneNumberId: string; displayNumber: string }, { ok: true }];
  decideApproval: [{ approvalId: string; approve: boolean; note?: string }, { ok: true }];
}

export type ApiName = keyof Api;
export type ApiRequest<K extends ApiName> = Api[K][0];
export type ApiResponse<K extends ApiName> = Api[K][1];
