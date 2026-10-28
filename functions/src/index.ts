/**
 * Kota House trusted backend. Every financial and inventory change goes
 * through these functions; Firestore security rules block direct client writes
 * to sales, cash, stock ledger, approvals and audit collections.
 */
export { setupBusiness, createEmployee, updateEmployee } from './business';
export { openShift, recordPayout, closeShift } from './shifts';
export { recordSale, requestRefund, verifyPayment } from './sales';
export { submitExpense } from './expenses';
export { recordPurchase, recordStockMovement } from './stock';
export { decideApproval } from './approvals';
export { auditCatalog } from './triggers';
export { monitorActivity } from './scheduled';
