import { getDb, Timestamp, LEDGER_ID } from '../config/firebase.js';

const RECURRING_PATH = `ledgers/${LEDGER_ID}/recurring`;
const COLLECTION_PATH = `ledgers/${LEDGER_ID}/transactions`;

export const getRecurringRules = async () => {
  const db = getDb();
  const snap = await db.collection(RECURRING_PATH).get();
  return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
};

export const checkRecurringDue = (recurringData) => {
  if (!recurringData || !recurringData.nextDueDate) return false;
  const nowMillis = Date.now();
  const dueDate = recurringData.nextDueDate.toDate ? recurringData.nextDueDate.toDate() : new Date(recurringData.nextDueDate);
  return dueDate.getTime() <= nowMillis;
};

export const checkDueRecurring = async () => {
  const db = getDb();
  const snap = await db.collection(RECURRING_PATH)
    .where('isActive', '==', true)
    .get();

  const dueItems = [];
  snap.forEach(doc => {
    const data = { id: doc.id, ...doc.data() };
    if (checkRecurringDue(data)) {
      dueItems.push(data);
    }
  });
  return dueItems;
};

export const processRecurringTransaction = async (recurringId, recurringData) => {
  const db = getDb();
  const batch = db.batch();

  const newTxnRef = db.collection(COLLECTION_PATH).doc();
  const txnTimestamp = recurringData.nextDueDate
    ? (recurringData.nextDueDate instanceof Timestamp ? recurringData.nextDueDate : Timestamp.fromDate(new Date(recurringData.nextDueDate)))
    : Timestamp.now();

  const txnType = recurringData.transactionType === 'income' ? 'income' : 'expense';

  const txnData = {
    amount: recurringData.amount,
    category: recurringData.category || 'Recurring',
    expenseName: recurringData.name,
    payer: 'me',
    splits: txnType === 'income' ? {} : { 'me': recurringData.amount },
    timestamp: txnTimestamp,
    type: txnType,
    groupId: recurringData.groupId || 'personal',
    isDeleted: false,
    recurringSourceId: recurringId,
    isRecurring: true,
    recurringType: recurringData.transactionType || 'expense',
    modeOfPayment: recurringData.paymentMode || 'Online',
    tag: recurringData.tag || '',
    place: recurringData.place || ''
  };
  batch.set(newTxnRef, txnData);

  const currentDue = recurringData.nextDueDate.toDate ? recurringData.nextDueDate.toDate() : new Date(recurringData.nextDueDate);
  const nextDue = new Date(currentDue);

  if (recurringData.frequency === 'yearly') {
    nextDue.setFullYear(nextDue.getFullYear() + 1);
  } else {
    nextDue.setMonth(nextDue.getMonth() + 1);
  }

  const recurRef = db.doc(`${RECURRING_PATH}/${recurringId}`);
  batch.update(recurRef, {
    nextDueDate: Timestamp.fromDate(nextDue),
    lastProcessedAt: Timestamp.now()
  });

  await batch.commit();
  return { id: newTxnRef.id, nextDueDate: nextDue };
};

export const skipRecurringTransaction = async (recurringId, currentDueDate, frequency = 'monthly') => {
  const db = getDb();
  const dateObj = currentDueDate.toDate ? currentDueDate.toDate() : new Date(currentDueDate);
  const nextDue = new Date(dateObj);

  if (frequency === 'yearly') {
    nextDue.setFullYear(nextDue.getFullYear() + 1);
  } else {
    nextDue.setMonth(nextDue.getMonth() + 1);
  }

  const recurRef = db.doc(`${RECURRING_PATH}/${recurringId}`);
  await recurRef.update({
    nextDueDate: Timestamp.fromDate(nextDue)
  });
  return { id: recurringId, nextDueDate: nextDue };
};

export const addRecurringTransaction = async (data) => {
  const db = getDb();
  const nextDueDate = data.nextDueDate instanceof Date
    ? Timestamp.fromDate(data.nextDueDate)
    : (data.nextDueDate ? Timestamp.fromDate(new Date(data.nextDueDate)) : Timestamp.now());

  const docRef = await db.collection(RECURRING_PATH).add({
    ...data,
    nextDueDate,
    isActive: true,
    createdAt: Timestamp.now()
  });
  return { id: docRef.id };
};

export const updateRecurringTransaction = async (id, data) => {
  const db = getDb();
  const updateData = { ...data };
  if (updateData.nextDueDate) {
    updateData.nextDueDate = updateData.nextDueDate instanceof Date
      ? Timestamp.fromDate(updateData.nextDueDate)
      : Timestamp.fromDate(new Date(updateData.nextDueDate));
  }

  await db.doc(`${RECURRING_PATH}/${id}`).update(updateData);
  return { id, ...updateData };
};

export const deleteRecurringTransaction = async (id) => {
  const db = getDb();
  await db.doc(`${RECURRING_PATH}/${id}`).delete();
  return { success: true, id };
};
