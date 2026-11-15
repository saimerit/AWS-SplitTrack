const rounded = (value) => Math.round((Number(value) || 0) * 100) / 100;

export function applyTransaction(state, transaction) {
  const accounts = (state.accounts || []).map((a) => ({ ...a }));
  const friends = (state.friends || []).map((f) => ({ ...f }));
  const trips = (state.trips || []).map((t) => ({ ...t }));
  const categories = state.categories || [];

  const rawAmount = Number(transaction.amount) || 0;
  const absAmount = Math.abs(rawAmount);
  const normalized = {
    ...transaction,
    id: transaction.id || `tx-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    amount: rawAmount,
    settled: transaction.settled ?? true,
  };

  const isPaidByUser = normalized.paidBy === 'user' || !normalized.paidBy;
  const payerFriendId = isPaidByUser ? null : normalized.paidBy;
  const targetAccountId = normalized.upiAccountId || accounts[0]?.id;

  // 1. Account balance and totalSpent updates
  const nextAccounts = accounts.map((account) => {
    if (account.id !== targetAccountId) return account;

    let balanceDelta = 0;
    let spentDelta = 0;

    if (normalized.type === 'income') {
      balanceDelta = absAmount;
    } else if (normalized.type === 'settlement') {
      // If user received settlement (amount > 0 or paidBy is friend), balance increases.
      // If user paid settlement (amount < 0 or paidBy === 'user'), balance decreases.
      balanceDelta = rawAmount;
    } else if (normalized.type === 'transfer') {
      balanceDelta = rawAmount; // Depends on direction
    } else if (isPaidByUser) {
      // Default: expense paid by user
      balanceDelta = -absAmount;
      spentDelta = absAmount;
    }

    return {
      ...account,
      balance: rounded(account.balance + balanceDelta),
      totalSpent: rounded(account.totalSpent + spentDelta),
    };
  });

  // 2. Friend netBalance updates
  let nextFriends = friends;
  const targetFriendId = normalized.targetFriendId || (normalized.paidBy === 'user'
    ? normalized.splits?.[0]?.friendId
    : normalized.paidBy);

  if (normalized.type === 'settlement') {
    // Settle with friend directly
    if (targetFriendId && targetFriendId !== 'user') {
      nextFriends = friends.map((friend) => {
        if (friend.id !== targetFriendId) return friend;
        // If user received payment (rawAmount > 0), friend's debt to user decreases (-absAmount)
        // If user paid friend (rawAmount < 0), user's debt to friend decreases (+absAmount towards 0)
        const netDelta = rawAmount > 0 ? -absAmount : absAmount;
        return {
          ...friend,
          netBalance: rounded(friend.netBalance + netDelta),
        };
      });
    }
  } else {
    // Expense with splits
    const userSplit = normalized.splits?.find((s) => s.friendId === 'user');
    const userShare = userSplit
      ? Number(userSplit.amount) || 0
      : (payerFriendId && (!normalized.splits || normalized.splits.length === 0) ? absAmount : 0);

    nextFriends = friends.map((friend) => {
      let delta = 0;

      if (isPaidByUser) {
        // User paid for friend => friend owes user more
        const splitForFriend = normalized.splits?.find((s) => s.friendId === friend.id);
        if (splitForFriend) {
          delta = Number(splitForFriend.amount) || 0;
        }
      } else if (friend.id === payerFriendId) {
        // Friend paid for user => user owes friend (friend's net balance decreases towards negative)
        // If friend owed user money, their debt reduces by userShare.
        // If friend was settled, user now owes friend userShare.
        delta = -userShare;
      }

      if (delta === 0) return friend;
      return {
        ...friend,
        netBalance: rounded(friend.netBalance + delta),
      };
    });
  }

  // 3. Trip spend updates
  const nextTrips = trips.map((trip) => {
    if (trip.id !== normalized.tripId) return trip;
    const tripSpendDelta = normalized.type === 'expense' ? absAmount : 0;
    return {
      ...trip,
      totalSpend: rounded(trip.totalSpend + tripSpendDelta),
    };
  });

  // 4. Update settled state on affected transactions
  let nextExistingTransactions = (state.transactions || []).map((t) => ({ ...t }));
  if (normalized.type === 'settlement') {
    if (normalized.settledTransactionId) {
      nextExistingTransactions = nextExistingTransactions.map((t) =>
        t.id === normalized.settledTransactionId ? { ...t, settled: true } : t
      );
    } else if (targetFriendId) {
      nextExistingTransactions = nextExistingTransactions.map((t) => {
        const involvesTarget =
          t.paidBy === targetFriendId ||
          t.splits?.some((s) => s.friendId === targetFriendId);
        return involvesTarget ? { ...t, settled: true } : t;
      });
    }
  }

  return {
    ...state,
    accounts: nextAccounts,
    friends: nextFriends,
    trips: nextTrips,
    categories,
    transactions: [normalized, ...nextExistingTransactions],
  };
}

export function applyTransactions(state, transactionsList) {
  let currentState = state;
  for (const tx of transactionsList) {
    currentState = applyTransaction(currentState, tx);
  }
  return currentState;
}
