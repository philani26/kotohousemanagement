/** Idempotency key for a sale – kept until the server confirms, so retries never double-charge. */
export function newSaleId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}
