import crypto from 'node:crypto';
import { ensure, ApiError } from './errors.js';
import { emptyState } from './defaults.js';
import { pairId } from './money.js';

const key = (ledgerId, recordId = 'STATE') => ({ ledgerId, recordId });
const originalId = id => id.startsWith('reversal#') ? id.slice(9) : id;
const generationPrefix = generation => `TX#${String(generation).padStart(6, '0')}#`;

// Claims are authoritative, including consolidated payments and refund debts.
// Follow payment provenance so a partially paid expense remains with its debt.
async function protectedTransactions(service, uid, state) {
  const protectedIds = new Set();
  for (let offset = 0; offset < state.friends.length; offset += 100) {
    const friends = state.friends.slice(offset, offset + 100);
    const pairs = await service.repo.many('ledger', friends.map(friend => key(pairId(uid, friend.id))));
    const byId = new Map(pairs.map(pair => [pair.ledgerId, pair]));
    for (const friend of friends) {
      const claims = (byId.get(pairId(uid, friend.id))?.claims || []).filter(claim => claim.remainingCents > 0 && (claim.creditor === uid || claim.debtor === uid));
      const net = claims.reduce((sum, claim) => sum + (claim.creditor === uid ? claim.remainingCents : -claim.remainingCents), 0);
      ensure(net === friend.netCents, 'An unpaid balance could not be verified. Refresh before clearing settled history.', 409, 'LEDGER_BALANCE_REVIEW_REQUIRED');
      for (const claim of claims) protectedIds.add(originalId(claim.id));
    }
  }
  let frontier = [...protectedIds];
  while (frontier.length) {
    const current = frontier;
    frontier = [];
    for (let offset = 0; offset < current.length; offset += 100) {
      const journals = await service.repo.many('ledger', current.slice(offset, offset + 100).map(id => key(`JOURNAL#${id}`)));
      for (const journal of journals) for (const id of [...(journal.debtSourceIds || []), journal.sourceTransactionId].filter(Boolean)) {
        const source = originalId(id);
        if (!protectedIds.has(source)) { protectedIds.add(source); frontier.push(source); }
      }
    }
  }
  return protectedIds;
}

export async function resetSettledHistory(service, Work, auth, requestId, body = {}) {
  ensure(typeof requestId === 'string' && /^[A-Za-z0-9_-]{12,100}$/.test(requestId), 'A valid idempotency-key is required.');
  ensure(body && typeof body === 'object' && !Array.isArray(body), 'Reset request must be an object.');
  ensure(body.mode === undefined || body.mode === 'settled-only', 'Only settled history can be cleared.');
  await service.bootstrap(auth);
  const startingState = await service.repo.get('ledger', key(auth.uid));
  const startingGeneration = startingState?.generation || 0;
  const observedResetId = startingState?.resetting?.id;
  const hash = crypto.createHash('sha256').update(JSON.stringify({ operation: 'erase' })).digest('hex');
  const markerKey = key(auth.uid, `REQUEST#${requestId}`);
  const marker = await service.repo.get('ledger', markerKey);
  if (marker) {
    ensure(marker.hash === hash, 'This request ID was already used for another operation.', 409, 'IDEMPOTENCY_CONFLICT');
    if (marker.result.erased || !marker.resetId) return { result: marker.result, state: await service.snapshot(auth.uid) };
    const current = await service.repo.get('ledger', key(auth.uid));
    if (current?.resetting?.id !== marker.resetId) return { result: current?.lastLedgerReset?.id === marker.resetId ? current.lastLedgerReset.result : { ...marker.result, erased: true, needsContinue: false }, state: await service.snapshot(auth.uid, current) };
  }
  const step = async callback => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const work = new Work(service.repo, true), state = await work.state(auth.uid);
      const result = await callback(work, state);
      try { await work.commit(); return result; }
      catch (error) {
        if (!service.isConflict(error)) throw error;
        if (attempt === 4) throw new ApiError(409, 'Another device updated this ledger. Please retry.', 'WRITE_CONFLICT');
        await new Promise(resolve => setTimeout(resolve, 20 * 2 ** attempt));
      }
    }
  };
  let protectedIds;
  await step(async (work, state) => {
    protectedIds = undefined;
    if (await work.get('ledger', markerKey)) return;
    ensure(!state.resetting || state.resetting.mode === 'settled-only', 'An older ledger reset needs review before it can continue.', 409, 'LEDGER_RESET_REVIEW_REQUIRED');
    // Another device can finish cleanup while this request retries its initial
    // conditional write. Join that completed reset rather than starting a second
    // generation for an intent that began before the first reset finished.
    if (!state.resetting && state.lastLedgerReset && ((state.generation || 0) !== startingGeneration || observedResetId === state.lastLedgerReset.id)) {
      work.put('ledger', { ...markerKey, revision: 1, hash, resetId: state.lastLedgerReset.id, result: state.lastLedgerReset.result, expiresAt: Math.floor(Date.now() / 1000) + 7 * 86400 }, { revision: 0 });
      return;
    }
    if (!state.resetting) {
      protectedIds = await protectedTransactions(service, auth.uid, state);
      const sourceGeneration = state.generation || 0;
      state.generation = sourceGeneration + 1;
      state.totals = emptyState(auth.uid).totals;
      state.accounts = state.accounts.map(account => ({ ...account, balanceCents: 0, spentCents: 0 }));
      // Keep profiles, membership and pair balances. Cleanup never mutates claims.
      state.resetting = { id: requestId, mode: 'settled-only', sourceGeneration, stage: 0, removedTransactions: 0, retainedTransactions: 0 };
      work.stateChanged(auth.uid);
    }
    work.put('ledger', { ...markerKey, revision: 1, hash, resetId: state.resetting.id,
      result: { erased: false, needsContinue: true, resetMode: 'settled-only' }, expiresAt: Math.floor(Date.now() / 1000) + 7 * 86400 }, { revision: 0 });
  });
  const frozen = await service.repo.get('ledger', key(auth.uid));
  protectedIds ??= await protectedTransactions(service, auth.uid, frozen);
  const deadline = Date.now() + 7000;
  let finished = false;
  do {
    finished = await step(async (work, state) => {
      const reset = state.resetting;
      if (!reset) return true;
      ensure(reset.mode === 'settled-only', 'Only settled history can be cleared.', 409);
      if (reset.stage === 0) {
        const page = await service.repo.query('transactions', 'ledgerId', auth.uid, { prefix: generationPrefix(reset.sourceGeneration), limit: 4 });
        for (const row of page.items) {
          const id = row.id || row.data?.id;
          const journal = id ? await work.get('ledger', key(`JOURNAL#${id}`)) : null;
          if (protectedIds.has(id)) {
            ensure(journal?.effects?.[auth.uid], 'An unpaid transaction could not be read. Retry after reconnecting.', 409);
            const effect = journal.effects[auth.uid];
            effect.generation = state.generation;
            const sortKey = generationPrefix(state.generation) + row.transactionId.slice(generationPrefix(reset.sourceGeneration).length);
            journal.sortKeys[auth.uid] = sortKey;
            work.put('transactions', { ...row, transactionId: sortKey });
            work.put('data', { userId: auth.uid, recordId: `TX#${id}`, id, sortKey });
            if (!row.deleted) { service.applyEffect(state, effect); await service.dailyEffect(work, auth.uid, effect); reset.retainedTransactions++; }
            work.rowChanged(journal);
          } else {
            if (journal) {
              journal.participantIds = journal.participantIds.filter(uid => uid !== auth.uid);
              delete journal.effects[auth.uid]; delete journal.sortKeys[auth.uid];
              journal.flows = journal.flows.filter(flow => flow.creditor !== auth.uid && flow.debtor !== auth.uid);
              if (journal.participantIds.length) work.rowChanged(journal);
              else { service.removeLegacyDuplicateIndex(work, journal.duplicateKeys); work.delete('ledger', key(`JOURNAL#${id}`), { revision: journal.revision }); }
              if (journal.tripId) {
                const tripKey = { ledgerId: `TRIP#${journal.tripId}`, transactionId: journal.sortKey };
                const tripRow = await work.get('transactions', tripKey);
                if (tripRow) work.put('transactions', { ...tripRow, clearedFor: [...new Set([...(tripRow.clearedFor || []), auth.uid])] });
              }
            }
            if (id) work.delete('data', { userId: auth.uid, recordId: `TX#${id}` });
            if (!row.deleted) reset.removedTransactions++;
          }
          work.delete('transactions', { ledgerId: auth.uid, transactionId: row.transactionId });
        }
        if (!page.items.length) reset.stage++;
      } else if (reset.stage === 1) {
        const page = await service.repo.query('ledger', 'ledgerId', `ANALYTICS#${auth.uid}`, { prefix: `DAY#${String(reset.sourceGeneration).padStart(6, '0')}#`, limit: 80 });
        for (const row of page.items) work.delete('ledger', key(row.ledgerId, row.recordId));
        if (!page.items.length) reset.stage++;
      } else if (reset.stage === 2) {
        const page = await service.repo.query('ledger', 'ledgerId', auth.uid, { prefix: 'DAY#', limit: 80 });
        for (const row of page.items) work.delete('ledger', key(auth.uid, row.recordId));
        if (!page.items.length) reset.stage++;
      } else if (reset.stage === 3) {
        const page = await service.repo.query('ledger', 'ledgerId', auth.uid, { prefix: 'BIN#', cursor: reset.cursor, limit: 40 });
        for (const row of page.items) {
          if (protectedIds.has(row.id)) work.put('ledger', { ...row, generation: state.generation });
          else work.delete('ledger', key(auth.uid, row.recordId));
        }
        if (page.cursor) reset.cursor = page.cursor; else { delete reset.cursor; reset.stage++; }
      } else if (reset.stage === 4 || reset.stage === 5) {
        const table = reset.stage === 4 ? 'recurring' : 'templates';
        const sort = reset.stage === 4 ? 'recurringId' : 'templateId';
        const page = await service.repo.query(table, 'ledgerId', auth.uid, { limit: 80 });
        for (const row of page.items) work.delete(table, { ledgerId: auth.uid, [sort]: row[sort] });
        if (!page.items.length) reset.stage++;
      } else {
        const result = { erased: true, needsContinue: false, resetMode: 'settled-only', removedTransactions: reset.removedTransactions, retainedTransactions: reset.retainedTransactions };
        state.lastLedgerReset = { id: reset.id, result };
        delete state.resetting;
        for (const id of new Set([requestId, reset.id])) work.put('ledger', { ...key(auth.uid, `REQUEST#${id}`), revision: 1, hash, result, expiresAt: Math.floor(Date.now() / 1000) + 7 * 86400 });
        work.stateChanged(auth.uid); return true;
      }
      work.stateChanged(auth.uid); return false;
    });
  } while (!finished && Date.now() < deadline);
  const state = await service.snapshot(auth.uid);
  const completedMarker = finished ? await service.repo.get('ledger', markerKey) : null;
  const completedState = finished ? await service.repo.get('ledger', key(auth.uid)) : null;
  const result = finished ? (completedState.lastLedgerReset?.id === completedMarker.resetId ? completedState.lastLedgerReset.result : { ...completedMarker.result, erased: true, needsContinue: false }) : { erased: false, needsContinue: true, resetMode: 'settled-only' };
  return { result, state };
}
