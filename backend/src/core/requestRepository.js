// Financial data is reused only inside one request. A transaction invalidates
// the entire read set so conflict retries always reload current revisions.
export class RequestRepository {
  constructor(repository) {
    this.repository = repository;
    this.reads = new Map();
  }
  key(table, key) {
    return `${table}:${JSON.stringify(Object.entries(key).sort(([a], [b]) => a.localeCompare(b)))}`;
  }
  get(table, key) {
    const id = this.key(table, key);
    if (!this.reads.has(id)) this.reads.set(id, this.repository.get(table, key));
    return this.reads.get(id);
  }
  many(table, keys) {
    const unique = [...new Map(keys.map(key => [this.key(table, key), key])).values()];
    const missing = unique.filter(key => !this.reads.has(this.key(table, key)));
    if (missing.length) {
      const fetched = this.repository.many(table, missing).then(rows => new Map(rows.map(row => {
        const fields = Object.keys(missing[0]);
        return [this.key(table, Object.fromEntries(fields.map(field => [field, row[field]]))), row];
      })));
      for (const key of missing) {
        const id = this.key(table, key);
        this.reads.set(id, fetched.then(rows => rows.get(id)));
      }
    }
    return Promise.all(unique.map(key => this.get(table, key))).then(rows => rows.filter(Boolean));
  }
  query(...args) { return this.repository.query(...args); }
  ownedTrips(...args) { return this.repository.ownedTrips(...args); }
  releases(...args) { return this.repository.releases(...args); }
  forget(table, key) { this.reads.delete(this.key(table, key)); }
  invalidate() { this.reads.clear(); }
  async transact(actions) {
    try { return await this.repository.transact(actions); }
    finally { this.invalidate(); }
  }
}
