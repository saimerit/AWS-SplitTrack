import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import crypto from 'crypto';

// Initialize DynamoDB Document Client
const rawClient = new DynamoDBClient({});
export const dynamoClient = DynamoDBDocumentClient.from(rawClient, {
  marshallOptions: { removeUndefinedValues: true },
});

export const getTableNames = () => ({
  dataTable: process.env.DATA_TABLE || 'SplitTrackData',
  transactionsTable: process.env.TRANSACTIONS_TABLE || 'SplitTrackTransactions',
  recurringTable: process.env.RECURRING_TABLE || 'SplitTrackRecurring',
  templatesTable: process.env.TEMPLATES_TABLE || 'SplitTrackTemplates',
  ledgerDataTable: process.env.LEDGER_DATA_TABLE || 'SplitTrackLedgerData',
  changelogTable: process.env.CHANGELOG_TABLE || 'SplitTrackChangelog',
});

// High-fidelity Timestamp implementation matching Firestore Admin Timestamp
export class Timestamp {
  constructor(seconds, nanoseconds = 0) {
    this.seconds = Number(seconds) || 0;
    this.nanoseconds = Number(nanoseconds) || 0;
  }

  static now() {
    const ms = Date.now();
    return new Timestamp(Math.floor(ms / 1000), (ms % 1000) * 1e6);
  }

  static fromDate(date) {
    const d = date instanceof Date ? date : new Date(date);
    const ms = d.getTime();
    return new Timestamp(Math.floor(ms / 1000), (ms % 1000) * 1e6);
  }

  static fromMillis(ms) {
    return new Timestamp(Math.floor(ms / 1000), (ms % 1000) * 1e6);
  }

  toDate() {
    return new Date(this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6));
  }

  toMillis() {
    return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6);
  }

  toISOString() {
    return this.toDate().toISOString();
  }

  toJSON() {
    return this.toISOString();
  }

  toString() {
    return this.toISOString();
  }
}

export const FieldValue = {
  delete: () => '__FIELD_VALUE_DELETE__',
  serverTimestamp: () => Timestamp.now(),
};

/**
 * Resolves collection or document paths into DynamoDB table and key info.
 * Supported path patterns:
 *  - ledgers/{ledgerId}/transactions[/{id}]
 *  - ledgers/{ledgerId}/recurring[/{id}]
 *  - ledgers/{ledgerId}/templates[/{id}]
 *  - ledgers/{ledgerId}/aggregates/{type}
 *  - ledgers/{ledgerId}/summaries/{type}
 *  - ledgers/{ledgerId}/settings/{type}
 *  - ledgers/{ledgerId}/{collection}[/{id}] (e.g. categories, places, tags, etc.)
 *  - ledgers/{ledgerId}
 */
export function resolvePath(rawPath, fallbackLedgerId = 'main-ledger') {
  const parts = rawPath.replace(/^\/+|\/+$/g, '').split('/');
  const tables = getTableNames();

  let ledgerId = fallbackLedgerId;
  let cursor = 0;

  if (parts[0] === 'ledgers') {
    if (parts[1] && parts[1] !== 'main-ledger') {
      ledgerId = parts[1];
    } else {
      ledgerId = fallbackLedgerId;
    }
    cursor = 2;
  }

  const segment = parts[cursor] || '';
  const id = parts[cursor + 1] || null;

  if (!segment) {
    // Document: ledgers/{ledgerId}
    return {
      type: 'doc',
      tableName: tables.ledgerDataTable,
      partitionKey: { name: 'ledgerId', value: ledgerId },
      sortKey: { name: 'recordId', value: 'METADATA' },
      ledgerId,
      id: 'METADATA',
      path: rawPath,
    };
  }

  if (segment === 'transactions') {
    if (id) {
      return {
        type: 'doc',
        tableName: tables.transactionsTable,
        partitionKey: { name: 'ledgerId', value: ledgerId },
        sortKey: { name: 'transactionId', value: id },
        ledgerId,
        id,
        path: rawPath,
      };
    }
    return {
      type: 'collection',
      tableName: tables.transactionsTable,
      partitionKey: { name: 'ledgerId', value: ledgerId },
      sortKeyName: 'transactionId',
      ledgerId,
      collectionName: 'transactions',
      path: rawPath,
    };
  }

  if (segment === 'recurring') {
    if (id) {
      return {
        type: 'doc',
        tableName: tables.recurringTable,
        partitionKey: { name: 'ledgerId', value: ledgerId },
        sortKey: { name: 'recurringId', value: id },
        ledgerId,
        id,
        path: rawPath,
      };
    }
    return {
      type: 'collection',
      tableName: tables.recurringTable,
      partitionKey: { name: 'ledgerId', value: ledgerId },
      sortKeyName: 'recurringId',
      ledgerId,
      collectionName: 'recurring',
      path: rawPath,
    };
  }

  if (segment === 'templates') {
    if (id) {
      return {
        type: 'doc',
        tableName: tables.templatesTable,
        partitionKey: { name: 'ledgerId', value: ledgerId },
        sortKey: { name: 'templateId', value: id },
        ledgerId,
        id,
        path: rawPath,
      };
    }
    return {
      type: 'collection',
      tableName: tables.templatesTable,
      partitionKey: { name: 'ledgerId', value: ledgerId },
      sortKeyName: 'templateId',
      ledgerId,
      collectionName: 'templates',
      path: rawPath,
    };
  }

  // Sub-namespaces or other collections in SplitTrackLedgerData:
  // aggregates/{type}, summaries/{type}, settings/{type}, or {collectionName}[/{id}]
  if (['aggregates', 'summaries', 'settings'].includes(segment)) {
    const subType = id || 'default';
    return {
      type: 'doc',
      tableName: tables.ledgerDataTable,
      partitionKey: { name: 'ledgerId', value: ledgerId },
      sortKey: { name: 'recordId', value: `${segment}#${subType}` },
      ledgerId,
      id: subType,
      path: rawPath,
    };
  }

  if (id) {
    return {
      type: 'doc',
      tableName: tables.ledgerDataTable,
      partitionKey: { name: 'ledgerId', value: ledgerId },
      sortKey: { name: 'recordId', value: `${segment}#${id}` },
      ledgerId,
      id,
      path: rawPath,
    };
  }

  return {
    type: 'collection',
    tableName: tables.ledgerDataTable,
    partitionKey: { name: 'ledgerId', value: ledgerId },
    sortKeyName: 'recordId',
    prefix: `${segment}#`,
    ledgerId,
    collectionName: segment,
    path: rawPath,
  };
}

// Convert Firestore Timestamp / Date values recursively for DynamoDB storage
function serializeForDynamo(obj) {
  if (obj === null || obj === undefined) return obj;
  if (obj instanceof Timestamp) {
    return { _type: 'Timestamp', seconds: obj.seconds, nanoseconds: obj.nanoseconds, iso: obj.toISOString() };
  }
  if (obj instanceof Date) {
    return obj.toISOString();
  }
  if (Array.isArray(obj)) {
    return obj.map(serializeForDynamo);
  }
  if (typeof obj === 'object') {
    const res = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === '__FIELD_VALUE_DELETE__') continue;
      res[k] = serializeForDynamo(v);
    }
    return res;
  }
  return obj;
}

// Revive serialized DynamoDB items back to Firestore-friendly structures
function deserializeFromDynamo(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (obj instanceof Timestamp) return obj;
  if (obj instanceof Date) return obj;
  if (obj._type === 'Timestamp' && typeof obj.seconds === 'number') {
    return new Timestamp(obj.seconds, obj.nanoseconds || 0);
  }
  if (typeof obj.seconds === 'number' && typeof obj.nanoseconds === 'number') {
    return new Timestamp(obj.seconds, obj.nanoseconds);
  }
  if (Array.isArray(obj)) {
    return obj.map(deserializeFromDynamo);
  }
  const res = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'timestamp' && typeof v === 'string') {
      // Auto-wrap timestamp string so .toDate() works seamlessly
      const d = new Date(v);
      if (!isNaN(d.getTime())) {
        res[k] = Timestamp.fromDate(d);
        continue;
      }
    }
    if ((k === 'createdAt' || k === 'updatedAt' || k === 'nextDueDate') && typeof v === 'string') {
      const d = new Date(v);
      if (!isNaN(d.getTime())) {
        res[k] = Timestamp.fromDate(d);
        continue;
      }
    }
    res[k] = deserializeFromDynamo(v);
  }
  return res;
}

export class DynamoDocumentSnapshot {
  constructor(ref, data) {
    this.ref = ref;
    this.id = ref.id;
    this._data = data ? deserializeFromDynamo(data) : null;
    this.exists = Boolean(this._data);
  }

  data() {
    return this._data ? { ...this._data } : undefined;
  }
}

export class DynamoDocumentReference {
  constructor(adapter, path) {
    this.adapter = adapter;
    this.path = path;
    this.meta = resolvePath(path, adapter.defaultLedgerId);
    this.id = this.meta.id || path.split('/').filter(Boolean).pop();
  }

  async get() {
    const Key = {
      [this.meta.partitionKey.name]: this.meta.partitionKey.value,
      [this.meta.sortKey.name]: this.meta.sortKey.value,
    };

    try {
      const result = await this.adapter.client.send(
        new GetCommand({
          TableName: this.meta.tableName,
          Key,
        })
      );
      return new DynamoDocumentSnapshot(this, result.Item || null);
    } catch (err) {
      console.error(`[DynamoStore] Get failed for ${this.path}:`, err);
      throw err;
    }
  }

  async set(data, options = {}) {
    const Key = {
      [this.meta.partitionKey.name]: this.meta.partitionKey.value,
      [this.meta.sortKey.name]: this.meta.sortKey.value,
    };

    let itemToSave;
    if (options.merge) {
      const existing = await this.get();
      itemToSave = {
        ...(existing.exists ? existing.data() : {}),
        ...data,
      };
    } else {
      itemToSave = { ...data };
    }

    itemToSave[this.meta.partitionKey.name] = this.meta.partitionKey.value;
    itemToSave[this.meta.sortKey.name] = this.meta.sortKey.value;
    itemToSave.id = this.id;

    await this.adapter.client.send(
      new PutCommand({
        TableName: this.meta.tableName,
        Item: serializeForDynamo(itemToSave),
      })
    );
    return { writeTime: Timestamp.now() };
  }

  async update(updatePayload) {
    const existingSnap = await this.get();
    if (!existingSnap.exists) {
      throw new Error(`Document does not exist: ${this.path}`);
    }
    const current = existingSnap.data();
    const merged = { ...current, ...updatePayload };

    merged[this.meta.partitionKey.name] = this.meta.partitionKey.value;
    merged[this.meta.sortKey.name] = this.meta.sortKey.value;
    merged.id = this.id;

    await this.adapter.client.send(
      new PutCommand({
        TableName: this.meta.tableName,
        Item: serializeForDynamo(merged),
      })
    );
    return { writeTime: Timestamp.now() };
  }

  async delete() {
    const Key = {
      [this.meta.partitionKey.name]: this.meta.partitionKey.value,
      [this.meta.sortKey.name]: this.meta.sortKey.value,
    };
    await this.adapter.client.send(
      new DeleteCommand({
        TableName: this.meta.tableName,
        Key,
      })
    );
    return { writeTime: Timestamp.now() };
  }
}

export class DynamoQuery {
  constructor(adapter, collectionPath) {
    this.adapter = adapter;
    this.collectionPath = collectionPath;
    this.meta = resolvePath(collectionPath, adapter.defaultLedgerId);
    this._filters = [];
    this._orderBys = [];
    this._limit = null;
  }

  where(field, op, val) {
    this._filters.push({ field, op, val });
    return this;
  }

  orderBy(field, dir = 'asc') {
    this._orderBys.push({ field, dir: dir.toLowerCase() });
    return this;
  }

  limit(n) {
    this._limit = Number(n);
    return this;
  }

  async get() {
    const pkName = this.meta.partitionKey.name;
    const pkVal = this.meta.partitionKey.value;

    let KeyConditionExpression = `${pkName} = :pk`;
    const ExpressionAttributeValues = { ':pk': pkVal };

    if (this.meta.prefix) {
      KeyConditionExpression += ` AND begins_with(${this.meta.sortKeyName}, :prefix)`;
      ExpressionAttributeValues[':prefix'] = this.meta.prefix;
    }

    const items = [];
    let ExclusiveStartKey;

    do {
      const response = await this.adapter.client.send(
        new QueryCommand({
          TableName: this.meta.tableName,
          KeyConditionExpression,
          ExpressionAttributeValues,
          ExclusiveStartKey,
        })
      );
      if (response.Items) {
        items.push(...response.Items);
      }
      ExclusiveStartKey = response.LastEvaluatedKey;
    } while (ExclusiveStartKey);

    let deserialized = items.map((item) => {
      const revived = deserializeFromDynamo(item);
      const docId = revived.id || revived[this.meta.sortKeyName] || '';
      const docPath = `${this.collectionPath}/${docId}`;
      const docRef = new DynamoDocumentReference(this.adapter, docPath);
      return new DynamoDocumentSnapshot(docRef, revived);
    });

    // Apply where filters in memory
    for (const filter of this._filters) {
      const { field, op, val } = filter;
      deserialized = deserialized.filter((snap) => {
        const item = snap.data() || {};
        const fieldVal = item[field];

        if (op === '==' || op === '===') {
          return fieldVal === val;
        }
        if (op === '!=') {
          return fieldVal !== val;
        }
        if (op === '>') {
          return fieldVal > val;
        }
        if (op === '>=') {
          return fieldVal >= val;
        }
        if (op === '<') {
          return fieldVal < val;
        }
        if (op === '<=') {
          return fieldVal <= val;
        }
        if (op === 'array-contains') {
          return Array.isArray(fieldVal) && fieldVal.includes(val);
        }
        return true;
      });
    }

    // Apply sorting
    if (this._orderBys.length > 0) {
      deserialized.sort((aSnap, bSnap) => {
        const a = aSnap.data() || {};
        const b = bSnap.data() || {};
        for (const order of this._orderBys) {
          const { field, dir } = order;
          let valA = a[field];
          let valB = b[field];

          if (valA && typeof valA.toDate === 'function') valA = valA.toDate().getTime();
          else if (valA instanceof Date) valA = valA.getTime();

          if (valB && typeof valB.toDate === 'function') valB = valB.toDate().getTime();
          else if (valB instanceof Date) valB = valB.getTime();

          if (valA === valB) continue;
          if (valA === undefined || valA === null) return 1;
          if (valB === undefined || valB === null) return -1;

          if (dir === 'desc') {
            return valA < valB ? 1 : -1;
          }
          return valA > valB ? 1 : -1;
        }
        return 0;
      });
    }

    if (this._limit && this._limit > 0) {
      deserialized = deserialized.slice(0, this._limit);
    }

    return {
      docs: deserialized,
      empty: deserialized.length === 0,
      size: deserialized.length,
      forEach: (fn) => deserialized.forEach(fn),
    };
  }
}

export class DynamoCollectionReference extends DynamoQuery {
  doc(id) {
    const cleanId = id || crypto.randomUUID();
    const docPath = `${this.collectionPath}/${cleanId}`;
    return new DynamoDocumentReference(this.adapter, docPath);
  }

  async add(data) {
    const newId = data.id || `doc_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const docRef = this.doc(newId);
    await docRef.set({ ...data, id: newId });
    return docRef;
  }
}

export class DynamoBatch {
  constructor(adapter) {
    this.adapter = adapter;
    this.operations = [];
  }

  set(docRef, data, options = {}) {
    this.operations.push({ type: 'set', docRef, data, options });
    return this;
  }

  update(docRef, data) {
    this.operations.push({ type: 'update', docRef, data });
    return this;
  }

  delete(docRef) {
    this.operations.push({ type: 'delete', docRef });
    return this;
  }

  async commit() {
    for (const op of this.operations) {
      if (op.type === 'set') {
        await op.docRef.set(op.data, op.options);
      } else if (op.type === 'update') {
        await op.docRef.update(op.data);
      } else if (op.type === 'delete') {
        await op.docRef.delete();
      }
    }
    return { writeTime: Timestamp.now() };
  }
}

export class DynamoFirestoreAdapter {
  constructor(ledgerId = 'main-ledger', client = dynamoClient) {
    this.defaultLedgerId = ledgerId;
    this.client = client;
  }

  collection(path) {
    return new DynamoCollectionReference(this, path);
  }

  doc(path) {
    return new DynamoDocumentReference(this, path);
  }

  batch() {
    return new DynamoBatch(this);
  }

  async runTransaction(updateFunction) {
    const transaction = {
      get: (ref) => ref.get(),
      set: (ref, data, opts) => ref.set(data, opts),
      update: (ref, data) => ref.update(data),
      delete: (ref) => ref.delete(),
    };
    return updateFunction(transaction);
  }
}
