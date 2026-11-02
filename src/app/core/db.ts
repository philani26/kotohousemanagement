/**
 * Query builders with the same names the screens used with Firestore
 * (query, where, orderBy, limit, doc). They only describe what to read; the
 * Java backend runs the query and applies who may see what (see LiveService).
 */

export type WhereOp = '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in';

export interface CollectionReference {
  readonly kind: 'collection';
  readonly businessId: string;
  readonly collection: string;
}

export interface DocumentReference {
  readonly kind: 'doc';
  readonly businessId: string;
  readonly collection: string;
  readonly id: string;
}

export interface Query {
  readonly kind: 'query';
  readonly businessId: string;
  readonly collection: string;
  readonly where: [string, WhereOp, unknown][];
  readonly orderBy: [string, 'asc' | 'desc'][];
  readonly limit?: number;
}

type Constraint =
  | { type: 'where'; field: string; op: WhereOp; value: unknown }
  | { type: 'orderBy'; field: string; dir: 'asc' | 'desc' }
  | { type: 'limit'; n: number };

export function collectionRef(businessId: string, collection: string): CollectionReference {
  return { kind: 'collection', businessId, collection };
}

export function where(field: string, op: WhereOp, value: unknown): Constraint {
  return { type: 'where', field, op, value };
}

export function orderBy(field: string, dir: 'asc' | 'desc' = 'asc'): Constraint {
  return { type: 'orderBy', field, dir };
}

export function limit(n: number): Constraint {
  return { type: 'limit', n };
}

export function query(ref: CollectionReference | Query, ...constraints: Constraint[]): Query {
  const base: Query = ref.kind === 'query' ? ref : { kind: 'query', businessId: ref.businessId, collection: ref.collection, where: [], orderBy: [] };
  const q = { ...base, where: [...base.where], orderBy: [...base.orderBy] } as { -readonly [K in keyof Query]: Query[K] };
  for (const c of constraints) {
    if (c.type === 'where') q.where.push([c.field, c.op, c.value]);
    else if (c.type === 'orderBy') q.orderBy.push([c.field, c.dir]);
    else q.limit = c.n;
  }
  return q;
}

/** A record reference; without an id, a new random id (like Firestore's doc(collection)). */
export function doc(col: CollectionReference, id?: string): DocumentReference {
  return { kind: 'doc', businessId: col.businessId, collection: col.collection, id: id ?? newId() };
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

/** Timestamps arrive as {"__ts": millis}; screens use them like Firestore Timestamps. */
export class Timestamp {
  constructor(private readonly millis: number) {}

  static fromMillis(ms: number) {
    return new Timestamp(ms);
  }

  toMillis() {
    return this.millis;
  }

  toDate() {
    return new Date(this.millis);
  }

  get seconds() {
    return Math.floor(this.millis / 1000);
  }

  get nanoseconds() {
    return (this.millis % 1000) * 1_000_000;
  }
}

/** Turns {"__ts": n} markers (anywhere in a record) into Timestamp objects. */
export function revive<T>(value: T): T {
  if (Array.isArray(value)) return value.map(revive) as T;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o['__ts'] === 'number' && Object.keys(o).length === 1) return new Timestamp(o['__ts'] as number) as T;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) out[k] = revive(v);
    return out as T;
  }
  return value;
}
