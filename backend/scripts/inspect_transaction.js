import { getDb, LEDGER_ID } from '../src/config/firebase.js';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`
SplitTrack Transaction Inspector
Usage:
  node backend/scripts/inspect_transaction.js [searchTerm]

Examples:
  node backend/scripts/inspect_transaction.js nutty
  node backend/scripts/inspect_transaction.js lunch
`);
    process.exit(0);
}

import { getDb, LEDGER_ID } from '../src/config/firebase.js';

const inspect = async (searchTerm = 'nutty') => {
    const db = getDb();
    const snap = await db.collection(`ledgers/${LEDGER_ID}/transactions`).get();

    const matches = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(t => t.expenseName && t.expenseName.toLowerCase().includes(searchTerm.toLowerCase()));

    console.log(`Found ${matches.length} matches for "${searchTerm}":`, JSON.stringify(matches, null, 2));
};

const term = process.argv[2] || 'nutty';
inspect(term);
