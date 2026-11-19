export class MemoryRepository {
  constructor() {
    this.rows = new Map();
    this.failNext = false;
    this.conflicts = 0;
    this.queryReads = 0;
  }
  key(table, row) {
    return `${table}:${JSON.stringify(table === "data" ? { userId: row.userId, recordId: row.recordId } : table === "transactions" ? { ledgerId: row.ledgerId, transactionId: row.transactionId } : table === "recurring" ? { ledgerId: row.ledgerId, recurringId: row.recurringId } : table === "templates" ? { ledgerId: row.ledgerId, templateId: row.templateId } : { ledgerId: row.ledgerId, recordId: row.recordId })}`;
  }
  async get(table, key) {
    const row = this.rows.get(this.key(table, key));
    return row ? structuredClone(row) : undefined;
  }
  async many(table, keys) {
    return (await Promise.all(keys.map((key) => this.get(table, key)))).filter(
      Boolean,
    );
  }
  async query(
    table,
    partition,
    value,
    { prefix, cursor, limit = 50, reverse = false } = {},
  ) {
    this.queryReads++;
    const sort =
      {
        transactions: "transactionId",
        recurring: "recurringId",
        templates: "templateId",
      }[table] || "recordId";
    let rows = [...this.rows.entries()]
      .filter(
        ([key, row]) =>
          key.startsWith(`${table}:`) &&
          row[partition] === value &&
          (!prefix || row[sort].startsWith(prefix)),
      )
      .map(([, row]) => structuredClone(row))
      .sort((a, b) => String(a[sort]).localeCompare(String(b[sort])));
    if (reverse) rows.reverse();
    if (cursor) {
      const index = rows.findIndex((row) => row[sort] === cursor[sort]);
      rows = rows.slice(index + 1);
    }
    const items = rows.slice(0, limit),
      last = items.at(-1);
    return {
      items,
      cursor:
        rows.length > limit
          ? { [partition]: value, [sort]: last[sort] }
          : undefined,
    };
  }
  async transact(actions) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("Injected database failure");
    }
    for (const action of actions) {
      const old = this.rows.get(this.key(action.table, action.item || action.key));
      if (action.type === "delete") {
        if (action.revision === undefined || old?.revision === action.revision) continue;
        const error = new Error("Conditional delete conflict");
        error.name = "TransactionCanceledException";
        throw error;
      }
      if (
        (action.unique && old && old.uid !== action.item.uid) ||
        (action.revision !== undefined &&
          old &&
          (old.revision || 0) !== action.revision)
      ) {
        this.conflicts++;
        const error = new Error("Conditional write conflict");
        error.name = "TransactionCanceledException";
        throw error;
      }
    }
    const next = new Map(this.rows);
    for (const action of actions) {
      const key = this.key(action.table, action.item || action.key);
      if (action.type === "delete") next.delete(key);
      else next.set(key, structuredClone(action.item));
    }
    this.rows = next;
  }
  async releases() {
    return [];
  }
  async ownedTrips(uid, { cursor, limit = 80 } = {}) {
    const orderedKey = row => `${row.ledgerId}\u0000${row.recordId}`;
    const rows = [...this.rows.entries()].filter(([key]) => key.startsWith("ledger:")).map(([, row]) => row).sort((a, b) => orderedKey(a).localeCompare(orderedKey(b)));
    const remaining = cursor ? rows.filter(row => orderedKey(row).localeCompare(orderedKey(cursor)) > 0) : rows;
    const scanned = remaining.slice(0, limit);
    return {
      items: scanned.filter(row => row.ledgerId.startsWith("TRIP#") && row.ownerId === uid).map(row => structuredClone(row)),
      cursor: remaining.length > limit && scanned.length ? { ledgerId: scanned.at(-1).ledgerId, recordId: scanned.at(-1).recordId } : undefined,
    };
  }
}
