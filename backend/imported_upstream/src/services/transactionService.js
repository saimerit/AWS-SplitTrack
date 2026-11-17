import { getDb, Timestamp, LEDGER_ID } from '../config/firebase.js';

const COLLECTION_PATH = `ledgers/${LEDGER_ID}/transactions`;
const SUMMARY_PATH = `ledgers/${LEDGER_ID}/summaries/dashboard`;

/**
 * RECTIFIED STATS:
 * Recomputes participant balances and global aggregates from original transaction amounts.
 */
export const rectifyAllStats = async (participants = []) => {
  const db = getDb();
  const snap = await db.collection(COLLECTION_PATH)
    .where("isDeleted", "==", false)
    .get();

  const transactions = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  let myPersonalBalances = {};
  participants.forEach(p => {
    if (p.uniqueId !== 'me') myPersonalBalances[p.uniqueId] = 0;
  });

  transactions.forEach(txn => {
    const payer = txn.payer || 'me';
    const amount = parseFloat(txn.amount) || 0;
    const splits = txn.splits || {};

    if (txn.type === 'income') return;

    if (txn.isReturn) {
      const recipient = txn.participants?.[0];
      if (!recipient || recipient === 'me') return;
      if (payer === 'me') {
        myPersonalBalances[recipient] = (myPersonalBalances[recipient] || 0) + amount;
      } else {
        myPersonalBalances[payer] = (myPersonalBalances[payer] || 0) - amount;
      }
    } else {
      if (payer === 'me') {
        Object.entries(splits).forEach(([uid, share]) => {
          if (uid !== 'me') myPersonalBalances[uid] = (myPersonalBalances[uid] || 0) + share;
        });
      } else if (splits['me']) {
        myPersonalBalances[payer] = (myPersonalBalances[payer] || 0) - splits['me'];
      }
    }
  });

  const totals = {
    totalOwedToMe: 0,
    totalIOWE: 0
  };
  Object.values(myPersonalBalances).forEach(val => {
    if (val > 0) totals.totalOwedToMe += val;
    else totals.totalIOWE += Math.abs(val);
  });

  const statsRef = db.doc(`ledgers/${LEDGER_ID}/aggregates/balances`);
  await statsRef.set({
    ...myPersonalBalances,
    ...totals,
    lastUpdated: Timestamp.now()
  });

  const summaryRef = db.doc(SUMMARY_PATH);
  await summaryRef.set({
    totalOwed: totals.totalOwedToMe,
    totalDebt: totals.totalIOWE,
    netBalance: totals.totalOwedToMe - totals.totalIOWE
  }, { merge: true });

  return { myPersonalBalances, totals };
};

/**
 * HELPER: Parent stats calculation with partial settlement tracking
 */
export const updateParentStats = async (parentId) => {
  if (!parentId) return;
  const db = getDb();
  const parentRef = db.doc(`${COLLECTION_PATH}/${parentId}`);
  const parentSnap = await parentRef.get();
  if (!parentSnap.exists) return;

  const [snap1, snap2] = await Promise.all([
    db.collection(COLLECTION_PATH)
      .where("parentTransactionId", "==", parentId)
      .where("isDeleted", "==", false)
      .get(),
    db.collection(COLLECTION_PATH)
      .where("parentTransactionIds", "array-contains", parentId)
      .where("isDeleted", "==", false)
      .get()
  ]);

  const uniqueChildrenMap = new Map();
  [...snap1.docs, ...snap2.docs].forEach(d => {
    uniqueChildrenMap.set(d.id, { id: d.id, ...d.data() });
  });
  const children = Array.from(uniqueChildrenMap.values());

  const parentData = parentSnap.data();
  const parentAmount = parseFloat(parentData.amount) || 0;
  const settlementDeficit = parseFloat(parentData.settlementDeficit) || 0;

  let netBalance = 0;
  if (!parentData.isReturn) {
    netBalance = parentAmount;
  } else if (settlementDeficit > 0) {
    netBalance = settlementDeficit;
  } else {
    const baseCredit = parentData.initialOverpaidAmount !== undefined
      ? parentData.initialOverpaidAmount
      : (parentData.overpaidAmount !== undefined ? parentData.overpaidAmount : -parentAmount);
    netBalance = baseCredit;
  }

  let totalSettled = 0;
  const participantRemaining = {};
  const participantStatuses = {};

  if (parentData.splits) {
    Object.entries(parentData.splits).forEach(([uid, share]) => {
      if (uid !== 'me' && share > 0) {
        participantRemaining[uid] = share;
        participantStatuses[uid] = 'pending';
      }
    });
  }

  const participantOverpaid = {};
  if (parentData.isReturn) {
    const initialMap = parentData.initialParticipantOverpaid || parentData.participantOverpaid || {};
    Object.entries(initialMap).forEach(([uid, amt]) => {
      participantOverpaid[uid] = amt;
    });
  }

  const startBalance = netBalance;

  children.forEach(childData => {
    const link = childData.linkedTransactions?.find(l => l.id === parentId);
    let rawLinkAmount = link ? parseFloat(link.amount) : parseFloat(childData.amount);
    if (isNaN(rawLinkAmount)) rawLinkAmount = parseFloat(childData.amount) || 0;

    const childTotal = parseFloat(childData.amount) || 0;
    const isSingleLink = !childData.linkedTransactions || childData.linkedTransactions.length <= 1;

    if (isSingleLink && Math.abs(rawLinkAmount) > Math.abs(childTotal)) {
      rawLinkAmount = childTotal;
    }

    const linkAmount = Math.abs(rawLinkAmount);
    totalSettled += linkAmount;

    if (childData.isReturn) {
      if (startBalance < 0) {
        netBalance += linkAmount;
      } else {
        netBalance -= linkAmount;
      }

      const settlingParticipant = childData.payer !== 'me' ? childData.payer : childData.participants?.[0];
      if (settlingParticipant && participantRemaining[settlingParticipant] !== undefined) {
        let newRem;
        if (startBalance < 0) {
          newRem = participantRemaining[settlingParticipant] + linkAmount;
          if (newRem > 0) newRem = 0;
        } else {
          newRem = participantRemaining[settlingParticipant] - linkAmount;
          if (newRem < 0) newRem = 0;
        }

        participantRemaining[settlingParticipant] = newRem;
        participantStatuses[settlingParticipant] = newRem <= 1 ? 'settled' : 'partial';
      }
    } else {
      netBalance += rawLinkAmount;

      if (childData.splits) {
        Object.entries(childData.splits).forEach(([uid, childShare]) => {
          if (uid !== 'me' && participantRemaining[uid] !== undefined) {
            let newRem = participantRemaining[uid] + childShare;
            if (newRem < 0) newRem = 0;
            participantRemaining[uid] = newRem;
            participantStatuses[uid] = newRem <= 1 ? 'settled' : 'partial';
          }
        });
      }

      if (parentData.isReturn) {
        const participantId = childData.payer !== 'me' ? childData.payer : childData.participants?.[0];
        const targetKey = participantId || Object.keys(participantOverpaid)[0];

        if (targetKey && participantOverpaid[targetKey] !== undefined) {
          let newCredit = participantOverpaid[targetKey] + linkAmount;
          if (newCredit > 0) newCredit = 0;
          participantOverpaid[targetKey] = newCredit;
        }
      }
    }
  });

  const remaining = Math.max(0, netBalance);
  const updateData = {
    settledAmount: totalSettled,
    remainingAmount: remaining,
    hasRefunds: true,
    participantRemaining,
    participantStatuses,
    ...(parentData.isReturn ? {
      overpaidAmount: Math.min(0, netBalance),
      participantOverpaid
    } : {})
  };

  if (remaining <= 1) {
    updateData.settlementStatus = 'settled';
    updateData.remainingAmount = 0;
  } else {
    updateData.settlementStatus = 'partial';
    updateData.remainingAmount = remaining;
  }

  await parentRef.update(updateData);
};

/**
 * Add a new transaction with complete settlement chaining logic
 */
export const addTransaction = async (txnData) => {
  const db = getDb();
  if (txnData.isReturn && (!Number.isFinite(Number(txnData.amount)) || Number(txnData.amount) <= 0)) {
    throw new Error('Settlement amount must be greater than zero.');
  }

  const createdAt = Timestamp.now();
  const finalDocData = {
    ...txnData,
    isDeleted: false,
    createdAt
  };

  if (txnData.timestamp && !(txnData.timestamp instanceof Timestamp)) {
    finalDocData.timestamp = Timestamp.fromDate(new Date(txnData.timestamp));
  } else if (!txnData.timestamp) {
    finalDocData.timestamp = createdAt;
  }

  if (!txnData.isReturn && txnData.splits) {
    const participantRemaining = {};
    const participantStatuses = {};

    Object.entries(txnData.splits).forEach(([uid, share]) => {
      if (uid !== 'me' && share !== 0) {
        participantRemaining[uid] = share;
        participantStatuses[uid] = 'pending';
      }
    });

    if (Object.keys(participantRemaining).length > 0) {
      finalDocData.participantRemaining = participantRemaining;
      finalDocData.participantStatuses = participantStatuses;
    }
  }

  if (txnData.isReturn && txnData.basketDiff !== undefined) {
    const diff = parseFloat(txnData.basketDiff);
    const settlingParticipant = txnData.payer !== 'me' ? txnData.payer : txnData.participants?.[0];

    if (diff > 5) {
      finalDocData.settlementStatus = 'settled';
      finalDocData.settlementDeficit = 0;
      finalDocData.remainingAmount = 0;
      finalDocData.overpaidAmount = -diff;

      if (settlingParticipant) {
        finalDocData.participantRemaining = { [settlingParticipant]: -diff };
        finalDocData.participantStatuses = { [settlingParticipant]: 'overpaid' };
        finalDocData.participantOverpaid = { [settlingParticipant]: -diff };
        finalDocData.initialOverpaidAmount = -diff;
        finalDocData.initialParticipantOverpaid = { [settlingParticipant]: -diff };
      }
    } else if (diff < -5) {
      const deficitAmt = Math.abs(diff);
      finalDocData.settlementStatus = 'partial';
      finalDocData.settlementDeficit = deficitAmt;
      finalDocData.remainingAmount = deficitAmt;
      finalDocData.overpaidAmount = 0;

      if (settlingParticipant) {
        finalDocData.participantRemaining = { [settlingParticipant]: deficitAmt };
        finalDocData.participantStatuses = { [settlingParticipant]: 'partial' };
      }
    } else {
      finalDocData.settlementStatus = 'settled';
      finalDocData.remainingAmount = 0;
      finalDocData.overpaidAmount = 0;

      if (settlingParticipant) {
        finalDocData.participantRemaining = { [settlingParticipant]: 0 };
        finalDocData.participantStatuses = { [settlingParticipant]: 'settled' };
      }
    }
  } else if (txnData.isReturn && txnData.parentTransactionIds?.length > 0) {
    const parentDocs = await Promise.all(
      txnData.parentTransactionIds.map(pid => db.doc(`${COLLECTION_PATH}/${pid}`).get())
    );

    let totalDebtToSettle = 0;
    parentDocs.forEach(p => {
      if (p.exists) {
        const pData = p.data();
        if (pData.isReturn && pData.overpaidAmount < -1) {
          totalDebtToSettle += pData.overpaidAmount;
        } else {
          const pRem = pData.remainingAmount !== undefined ? pData.remainingAmount : pData.amount;
          totalDebtToSettle += (parseFloat(pRem) || 0);
        }
      }
    });

    const paymentAmount = parseFloat(txnData.amount) || 0;
    const deficit = totalDebtToSettle - paymentAmount;
    const settlingParticipant = txnData.payer !== 'me' ? txnData.payer : txnData.participants?.[0];

    if (deficit > 5) {
      finalDocData.settlementStatus = 'partial';
      finalDocData.settlementDeficit = deficit;
      finalDocData.remainingAmount = deficit;
      finalDocData.overpaidAmount = 0;

      if (settlingParticipant) {
        finalDocData.participantRemaining = { [settlingParticipant]: deficit };
        finalDocData.participantStatuses = { [settlingParticipant]: 'partial' };
      }
    } else if (deficit < -5) {
      const overpaid = Math.abs(deficit);
      finalDocData.settlementStatus = 'settled';
      finalDocData.remainingAmount = 0;
      finalDocData.overpaidAmount = -overpaid;

      if (settlingParticipant) {
        finalDocData.participantRemaining = { [settlingParticipant]: -overpaid };
        finalDocData.participantStatuses = { [settlingParticipant]: 'overpaid' };
        finalDocData.participantOverpaid = { [settlingParticipant]: -overpaid };
        finalDocData.initialOverpaidAmount = -overpaid;
        finalDocData.initialParticipantOverpaid = { [settlingParticipant]: -overpaid };
      }
    } else {
      finalDocData.settlementStatus = 'settled';
      finalDocData.remainingAmount = 0;
      finalDocData.overpaidAmount = 0;

      if (settlingParticipant) {
        finalDocData.participantRemaining = { [settlingParticipant]: 0 };
        finalDocData.participantStatuses = { [settlingParticipant]: 'settled' };
      }
    }
  }

  const docRef = await db.collection(COLLECTION_PATH).add(finalDocData);

  if (txnData.parentTransactionIds && txnData.parentTransactionIds.length > 0) {
    await Promise.all(txnData.parentTransactionIds.map(pid => updateParentStats(pid)));
  } else if (txnData.parentTransactionId) {
    await updateParentStats(txnData.parentTransactionId);
  }

  // Rectify background stats
  rectifyAllStats().catch(err => console.error('Background rectify failed:', err));

  return { id: docRef.id, ...finalDocData };
};

/**
 * Update an existing transaction
 */
export const updateTransaction = async (id, txnData, oldParentId) => {
  const db = getDb();
  if (txnData.isReturn && (!Number.isFinite(Number(txnData.amount)) || Number(txnData.amount) <= 0)) {
    throw new Error('Settlement amount must be greater than zero.');
  }

  const docRef = db.doc(`${COLLECTION_PATH}/${id}`);
  const updatePayload = {
    ...txnData,
    updatedAt: Timestamp.now()
  };

  if (txnData.timestamp && !(txnData.timestamp instanceof Timestamp)) {
    updatePayload.timestamp = Timestamp.fromDate(new Date(txnData.timestamp));
  }

  await docRef.update(updatePayload);

  if (txnData.parentTransactionIds && txnData.parentTransactionIds.length > 0) {
    await Promise.all(txnData.parentTransactionIds.map(pid => updateParentStats(pid)));
  } else if (txnData.parentTransactionId) {
    await updateParentStats(txnData.parentTransactionId);
  }

  if (oldParentId && (!txnData.parentTransactionIds || !txnData.parentTransactionIds.includes(oldParentId))) {
    if (oldParentId !== txnData.parentTransactionId) {
      await updateParentStats(oldParentId);
    }
  }

  rectifyAllStats().catch(err => console.error('Background rectify failed:', err));
  return { id, ...updatePayload };
};

/**
 * Atomic soft delete with dependency verification
 */
export const deleteTransaction = async (id, parentId) => {
  const db = getDb();
  const txnRef = db.doc(`${COLLECTION_PATH}/${id}`);

  const txnSnap = await txnRef.get();
  if (!txnSnap.exists) throw new Error("Transaction not found.");
  const txnData = txnSnap.data();

  await db.runTransaction(async (transaction) => {
    const txnDoc = await transaction.get(txnRef);
    if (!txnDoc.exists) throw new Error("Document does not exist.");

    const [snap1, snap2] = await Promise.all([
      db.collection(COLLECTION_PATH)
        .where("parentTransactionIds", "array-contains", id)
        .where("isDeleted", "==", false)
        .get(),
      db.collection(COLLECTION_PATH)
        .where("parentTransactionId", "==", id)
        .where("isDeleted", "==", false)
        .get()
    ]);

    if (!snap1.empty || !snap2.empty) {
      throw new Error("Cannot delete: Active linked refunds/repayments exist.");
    }

    transaction.update(txnRef, {
      isDeleted: true,
      deletedAt: Timestamp.now()
    });
  });

  const allParentIds = new Set();
  if (parentId) allParentIds.add(parentId);
  if (txnData?.parentTransactionId) allParentIds.add(txnData.parentTransactionId);
  if (txnData?.parentTransactionIds?.length > 0) {
    txnData.parentTransactionIds.forEach(pid => allParentIds.add(pid));
  }
  if (txnData?.linkedTransactions?.length > 0) {
    txnData.linkedTransactions.forEach(link => allParentIds.add(link.id));
  }

  if (allParentIds.size > 0) {
    await Promise.all([...allParentIds].map(pid => updateParentStats(pid)));
  }

  rectifyAllStats().catch(err => console.error('Background rectify failed:', err));
  return { success: true, id };
};

/**
 * Restore soft-deleted transaction
 */
export const restoreTransaction = async (id) => {
  const db = getDb();
  const txnRef = db.doc(`${COLLECTION_PATH}/${id}`);
  await txnRef.update({ isDeleted: false, deletedAt: null });

  const restored = await txnRef.get();
  const data = restored.exists ? restored.data() : null;
  const parentIds = new Set([
    data?.parentTransactionId,
    ...(data?.parentTransactionIds || []),
    ...(data?.linkedTransactions || []).map(link => link.id)
  ].filter(Boolean));

  await Promise.all([...parentIds].map(updateParentStats));
  rectifyAllStats().catch(err => console.error('Background rectify failed:', err));
  return { success: true, id };
};

/**
 * Permanent hard delete
 */
export const permanentDeleteTransaction = async (id) => {
  const db = getDb();
  const [childrenByArray, childrenByLegacy] = await Promise.all([
    db.collection(COLLECTION_PATH).where("parentTransactionIds", "array-contains", id).get(),
    db.collection(COLLECTION_PATH).where("parentTransactionId", "==", id).get()
  ]);

  if (!childrenByArray.empty || !childrenByLegacy.empty) {
    throw new Error('Cannot permanently delete a transaction that has linked settlements. Remove the linked records first.');
  }

  await db.doc(`${COLLECTION_PATH}/${id}`).delete();
  return { success: true, id };
};

/**
 * Bulk update transactions (categories, tags, etc.)
 */
export const bulkUpdateTransactions = async (ids, updateData) => {
  if (!ids || ids.length === 0) return { updated: 0 };
  const db = getDb();
  const batch = db.batch();

  ids.forEach(id => {
    const docRef = db.doc(`${COLLECTION_PATH}/${id}`);
    batch.update(docRef, {
      ...updateData,
      updatedAt: Timestamp.now()
    });
  });

  await batch.commit();
  return { updated: ids.length };
};

/**
 * Recalibrate all settlements and balances across the entire ledger
 */
export const repairAllTransactionStats = async () => {
  const db = getDb();
  const snap = await db.collection(COLLECTION_PATH)
    .where("isDeleted", "==", false)
    .get();

  const transactions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  let processed = 0;

  for (const txn of transactions) {
    if (txn.type === 'expense' || txn.amount > 0) {
      await updateParentStats(txn.id);
    }
    processed++;
  }

  await rectifyAllStats();
  return { processed };
};
