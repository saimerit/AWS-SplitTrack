import { ensure } from "./errors.js";

export function cents(value, name = "Amount") {
  ensure(
    value !== null &&
      value !== "" &&
      (typeof value === "number" || typeof value === "string"),
    `${name} must be a number.`,
  );
  const number = Number(value),
    result = Math.round(number * 100);
  ensure(
    Number.isFinite(number) &&
      Number.isSafeInteger(result) &&
      Math.abs(result) <= 10_000_000_000,
    `${name} is outside the supported range.`,
  );
  ensure(
    Math.abs(number * 100 - result) < 0.00001,
    `${name} must have at most two decimal places.`,
  );
  return result;
}
export const amount = (value) => value / 100;
export const alias = (uid, viewer) => (uid === viewer ? "user" : uid);
export const realId = (uid, viewer) =>
  uid === "user" || uid === "me" ? viewer : uid;
export const pairId = (first, second) =>
  `PAIR#${[first, second].sort().join("#")}`;

function distribute(total, weights) {
  const sum = weights.reduce((n, w) => n + w, 0);
  ensure(
    sum > 0 && weights.every((w) => Number.isFinite(w) && w >= 0),
    "Split weights must be non-negative and have a positive total.",
  );
  const exact = weights.map((w) => (total * w) / sum),
    result = exact.map(Math.floor);
  const order = exact
    .map((n, i) => ({ i, remainder: n - result[i] }))
    .sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  for (
    let remaining = total - result.reduce((n, v) => n + v, 0), i = 0;
    remaining > 0;
    remaining--, i++
  )
    result[order[i].i]++;
  return result;
}

export function expenseShares(input, uid) {
  const total = Math.abs(cents(input.amount));
  ensure(total > 0, "Expense amount must be positive.");
  const payer = realId(input.paidBy || input.payer || "user", uid);
  const raw =
    Array.isArray(input.splits) && input.splits.length
      ? input.splits
      : [{ friendId: uid, amount: amount(total) }];
  ensure(raw.length <= 12, "An expense supports up to 12 participants.");
  const ids = raw.map((s) => realId(s.friendId, uid));
  ensure(
    ids.every((id) => typeof id === "string" && id.length > 0) &&
      new Set(ids).size === ids.length,
    "Split participants must be unique valid users.",
  );
  let shares;
  switch (input.splitType || "equal") {
    case "equal":
      shares = distribute(
        total,
        ids.map(() => 1),
      );
      break;
    case "exact":
      shares = raw.map((s) => cents(s.amount, "Split amount"));
      ensure(
        shares.every((n) => n >= 0) &&
          shares.reduce((n, v) => n + v, 0) === total,
        "Exact split amounts must add up to the expense.",
      );
      break;
    case "percentage": {
      const weights = raw.map((s) => Number(s.percentage));
      ensure(
        weights.every((n) => Number.isFinite(n) && n >= 0) &&
          Math.abs(weights.reduce((n, v) => n + v, 0) - 100) < 0.00001,
        "Split percentages must add up to 100.",
      );
      shares = distribute(total, weights);
      break;
    }
    case "shares":
      shares = distribute(
        total,
        raw.map((s) => Number(s.share)),
      );
      break;
    default:
      ensure(false, "Unsupported split type.");
  }
  const participants = ids.map((id, i) => ({
    uid: id,
    shareCents: shares[i],
    paidCents: Math.max(0, cents(raw[i].paidAmount || 0, "Paid amount")),
  }));
  if (!participants.some((p) => p.uid === payer))
    participants.push({ uid: payer, shareCents: 0, paidCents: 0 });
  if (!participants.some((p) => p.uid === uid))
    participants.push({ uid, shareCents: 0, paidCents: 0 });
  ensure(
    participants.length <= 12,
    "An expense supports up to 12 participants.",
  );
  const paidTotal = participants.reduce((n, p) => n + p.paidCents, 0);
  if (paidTotal === 0)
    participants.find((p) => p.uid === payer).paidCents = total;
  else ensure(paidTotal === total, "Payments must add up to the expense.");
  return { total, payer, participants };
}

export function debtFlows(participants) {
  const creditors = participants
    .map((p) => ({ uid: p.uid, left: p.paidCents - p.shareCents }))
    .filter((p) => p.left > 0);
  const debtors = participants
    .map((p) => ({ uid: p.uid, left: p.shareCents - p.paidCents }))
    .filter((p) => p.left > 0);
  const flows = [];
  let i = 0,
    j = 0;
  while (i < creditors.length && j < debtors.length) {
    const value = Math.min(creditors[i].left, debtors[j].left);
    flows.push({
      creditor: creditors[i].uid,
      debtor: debtors[j].uid,
      cents: value,
    });
    creditors[i].left -= value;
    debtors[j].left -= value;
    if (!creditors[i].left) i++;
    if (!debtors[j].left) j++;
  }
  return flows;
}

// Only outstanding claims are kept, so history length does not affect a payment.
export function applyPairFlow(pair, flow, transactionId) {
  let left = flow.cents;
  const next = [];
  for (const claim of pair.claims || []) {
    if (left && claim.creditor === flow.debtor) {
      const consumed = Math.min(left, claim.remainingCents);
      left -= consumed;
      const remainingCents = claim.remainingCents - consumed;
      if (remainingCents) next.push({ ...claim, remainingCents });
    } else next.push({ ...claim });
  }
  if (left)
    next.push({
      id: transactionId,
      creditor: flow.creditor,
      debtor: flow.debtor,
      remainingCents: left,
    });
  pair.claims = next;
  ensure(
    Buffer.byteLength(JSON.stringify(pair)) < 300_000,
    "Settle some outstanding expenses before adding more to this balance.",
    409,
  );
}

export function reversePairFlow(pair, flow, transactionId) {
  let removed = 0;
  pair.claims = (pair.claims || []).filter((claim) => {
    if (claim.id === transactionId) {
      // A settlement may carry the remaining debt in the opposite direction
      // from the payment itself. Remove that vector before reversing cash.
      removed += claim.creditor === flow.creditor ? claim.remainingCents : -claim.remainingCents;
      return false;
    }
    return true;
  });
  const alreadyPaid = flow.cents - removed;
  if (alreadyPaid)
    applyPairFlow(
      pair,
      alreadyPaid > 0
        ? { creditor: flow.debtor, debtor: flow.creditor, cents: alreadyPaid }
        : { ...flow, cents: -alreadyPaid },
      `reversal#${transactionId}`,
    );
}

export function applySettlementFlow(pair, flow, transactionId, sourceId) {
  if (sourceId) pair.claims = [...(pair.claims || []).filter(c => c.id === sourceId), ...(pair.claims || []).filter(c => c.id !== sourceId)];
  const before = new Map((pair.claims || []).map(c => [c.id, c.remainingCents]));
  applyPairFlow(pair, flow, transactionId);
  // Bulk payments consolidate the pair. A transaction payment consolidates
  // its source and any other claims actually reached by an overpayment.
  pair.claims = pair.claims.map(claim => ({ ...claim, id: !sourceId || claim.id === sourceId || (before.has(claim.id) && before.get(claim.id) !== claim.remainingCents) ? transactionId : claim.id }));
  const combined = new Map();
  for (const claim of pair.claims) {
    const key = `${claim.id}:${claim.creditor}:${claim.debtor}`;
    const previous = combined.get(key);
    if (previous) previous.remainingCents += claim.remainingCents;
    else combined.set(key, { ...claim });
  }
  pair.claims = [...combined.values()];
}

export function settlementVector(data, pairs, viewer) {
  const claims = pairs.flatMap(pair => pair.claims || []).filter(claim => claim.id === data.id);
  const members = new Set([...(data.splits || []).map(split => split.friendId), ...claims.flatMap(claim => [claim.creditor, claim.debtor])]);
  members.delete(data.type === 'settlement' ? data.creatorId : data.paidBy);
  return [...members].map(member => {
    const relevant = claims.filter(claim => claim.creditor === member || claim.debtor === member);
    return {
      memberId: alias(member, viewer),
      remainingAmount: amount(relevant.reduce((sum, claim) => sum + claim.remainingCents, 0)),
      balances: relevant.map(claim => ({ creditorId: alias(claim.creditor, viewer), debtorId: alias(claim.debtor, viewer), amount: amount(claim.remainingCents) })),
    };
  });
}
