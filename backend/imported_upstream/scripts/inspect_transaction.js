import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

let serviceAccountPath = path.join(__dirname, '../service-account.json');
if (!fs.existsSync(serviceAccountPath)) {
    const rootPath = path.join(__dirname, '../../service-account.json');
    if (fs.existsSync(rootPath)) {
        serviceAccountPath = rootPath;
    }
}

if (!fs.existsSync(serviceAccountPath)) {
    console.error("Error: 'service-account.json' not found in backend or project root directory.");
    console.error("Place your Firebase Admin credentials in backend/service-account.json to use this tool.");
    process.exit(1);
}

if (!getApps().length) {
    const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
    initializeApp({ credential: cert(serviceAccount) });
}

const db = getFirestore();
const LEDGER_ID = 'main-ledger';

const inspect = async (searchTerm = 'nutty') => {
    const snap = await db.collection(`ledgers/${LEDGER_ID}/transactions`).get();

    const matches = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(t => t.expenseName && t.expenseName.toLowerCase().includes(searchTerm.toLowerCase()));

    console.log(`Found ${matches.length} matches for "${searchTerm}":`, JSON.stringify(matches, null, 2));
};

const term = process.argv[2] || 'nutty';
inspect(term);
