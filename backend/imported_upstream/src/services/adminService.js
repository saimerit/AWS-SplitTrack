import { getDb, Timestamp, LEDGER_ID } from '../config/firebase.js';

const COLLECTIONS = [
  'transactions',
  'categories',
  'places',
  'tags',
  'modesOfPayment',
  'templates',
  'goals',
  'groups',
  'participants',
  'recurring'
];

export const exportFullBackup = async () => {
  const db = getDb();
  const backup = {
    exportedAt: new Date().toISOString(),
    ledgerId: LEDGER_ID,
    collections: {}
  };

  for (const col of COLLECTIONS) {
    const snap = await db.collection(`ledgers/${LEDGER_ID}/${col}`).get();
    backup.collections[col] = snap.docs.map(d => {
      const data = d.data();
      if (data.timestamp && data.timestamp.toDate) {
        data.timestamp = data.timestamp.toDate().toISOString();
      }
      return { id: d.id, ...data };
    });
  }

  const settingsSnap = await db.doc(`ledgers/${LEDGER_ID}`).get();
  backup.settings = settingsSnap.exists ? settingsSnap.data() : {};

  return backup;
};

export const nukeCollection = async (collectionName) => {
  const db = getDb();
  const colRef = db.collection(`ledgers/${LEDGER_ID}/${collectionName}`);
  const snap = await colRef.limit(500).get();

  if (snap.empty) return { deleted: 0 };

  const batch = db.batch();
  snap.docs.forEach(doc => batch.delete(doc.ref));
  await batch.commit();

  return { deleted: snap.size };
};

export const importFromBackup = async (backupData) => {
  const db = getDb();
  const results = {};

  if (backupData.collections) {
    for (const [colName, items] of Object.entries(backupData.collections)) {
      if (!Array.isArray(items) || items.length === 0) continue;

      const colRef = db.collection(`ledgers/${LEDGER_ID}/${colName}`);
      const BATCH_SIZE = 400;

      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const batch = db.batch();
        const chunk = items.slice(i, i + BATCH_SIZE);

        chunk.forEach(item => {
          const { id, ...data } = item;
          if (data.timestamp && typeof data.timestamp === 'string') {
            data.timestamp = Timestamp.fromDate(new Date(data.timestamp));
          }
          const docRef = id ? colRef.doc(id) : colRef.doc();
          batch.set(docRef, data, { merge: true });
        });

        await batch.commit();
      }
      results[colName] = items.length;
    }
  }

  if (backupData.settings) {
    await db.doc(`ledgers/${LEDGER_ID}`).set(backupData.settings, { merge: true });
    results.settings = true;
  }

  return results;
};
