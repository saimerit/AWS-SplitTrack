import { getDb, Timestamp, LEDGER_ID } from '../config/firebase.js';

const TEMPLATES_PATH = `ledgers/${LEDGER_ID}/templates`;

export const getTemplates = async () => {
  const db = getDb();
  const snap = await db.collection(TEMPLATES_PATH).orderBy('name').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
};

export const addTemplate = async (templateData) => {
  const db = getDb();
  const docRef = await db.collection(TEMPLATES_PATH).add({
    ...templateData,
    createdAt: Timestamp.now(),
    usageCount: 0,
    isPinned: false
  });
  return { id: docRef.id };
};

export const updateTemplate = async (id, data) => {
  const db = getDb();
  await db.doc(`${TEMPLATES_PATH}/${id}`).update(data);
  return { id, ...data };
};

export const deleteTemplate = async (id) => {
  const db = getDb();
  await db.doc(`${TEMPLATES_PATH}/${id}`).delete();
  return { success: true, id };
};
