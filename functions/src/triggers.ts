import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { COLLECTIONS, Employee, Ingredient } from './shared/models';
import { FieldValue, Timestamp, audit, col, db, readSettings, todayKey } from './common';

/**
 * Owners edit catalogue data (products, recipes, ingredients, suppliers and
 * settings) directly, guarded by security rules that require `updatedBy` and
 * `updatedAt` on every client write. These triggers record each change in the
 * audit log. Writes made by backend functions (stock balances, receipt
 * counters) do not touch `updatedAt` and are therefore not logged twice.
 */
const AUDITED = ['products', 'recipes', 'ingredients', 'suppliers', 'businessSettings'] as const;

function changedFields(before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys].filter((k) => k !== 'updatedAt' && JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k]));
}

function pick(data: Record<string, unknown> | undefined, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((k) => data && k in data).map((k) => [k, data![k]]));
}

/** Exported as a group: deployed as auditCatalog-products, auditCatalog-recipes, … */
export const auditCatalog = Object.fromEntries(
  AUDITED.map((name) => [
    name,
    onDocumentWritten(`${COLLECTIONS.businesses}/{businessId}/${COLLECTIONS[name]}/{docId}`, async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    const { businessId, docId } = event.params;
    const beforeAt = (before?.['updatedAt'] as Timestamp | undefined)?.toMillis();
    const afterAt = (after?.['updatedAt'] as Timestamp | undefined)?.toMillis();
    if (before && after && beforeAt === afterAt) return; // system write

    const fields = changedFields(before, after);
    if (fields.length === 0) return;
    const actorUid = String((after ?? before)?.['updatedBy'] ?? 'unknown');
    const emp = (await col(businessId, 'employees').doc(actorUid).get()).data() as Employee | undefined;
    const actor = emp ? { uid: actorUid, name: emp.displayName, role: emp.role } : 'system';
    const action = `${name}.${!before ? 'created' : !after ? 'deleted' : 'updated'}`;

    const batch = db.batch();
    audit(batch, businessId, actor, action, name, docId, {
      fields,
      before: pick(before, fields),
      after: pick(after, fields),
    });

    // Opening stock is recorded in the stock ledger when an ingredient is created.
    if (name === 'ingredients' && !before && after) {
      const ing = { ...(after as Ingredient), id: docId };
      if (ing.openingQty > 0) {
        const settings = await readSettings(businessId);
        const ref = col(businessId, 'stockMovements').doc();
        batch.set(ref, {
          id: ref.id,
          ingredientId: docId,
          ingredientName: ing.name,
          type: 'opening',
          qtyChange: ing.openingQty,
          unitCostCents: ing.unitCostCents,
          valueCents: Math.round(ing.openingQty * ing.unitCostCents),
          reason: 'Opening stock',
          refType: 'ingredient',
          refId: docId,
          shiftId: null,
          createdBy: actorUid,
          createdByName: emp?.displayName ?? 'Owner',
          createdAt: FieldValue.serverTimestamp(),
          dayKey: todayKey(settings),
        });
      }
    }
    await batch.commit();
  }),
  ]),
);
