# Frontend to Backend Mapping

The separate Expo repository uses `src/auth/AuthContext.tsx` for Firebase sessions, `src/services/api.ts` for authenticated AWS requests and `src/store/SplitTrackStore.tsx` for real cloud state. Snapshots are scoped to the signed-in Firebase UID.

## Environment Variables (`frontend/.env`)

```ini
EXPO_PUBLIC_API_URL=https://e3kt7e3dag.execute-api.ap-south-1.amazonaws.com
EXPO_PUBLIC_FIREBASE_API_KEY=
EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN=
EXPO_PUBLIC_FIREBASE_PROJECT_ID=
EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET=
EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
EXPO_PUBLIC_FIREBASE_APP_ID=
EXPO_PUBLIC_GOOGLE_PLACES_API_KEY=
```

## API Endpoints & Actions Mapping

| Mobile Store Action | API Route | HTTP Method | Server Behavior |
| --- | --- | --- | --- |
| Signup/signin/password reset | Firebase Authentication SDK | SDK | AWS never receives the password. |
| Profile/bootstrap/onboarding | `/api/profile`, `/auth/me` | GET; profile PUT | Registered profile and atomic username claim. |
| Username availability | `/api/users/username?value=handle` | GET | `{ available }`. |
| Real member search | `/api/users/search?q=name-or-@handle` | GET | Public profiles; names can repeat, usernames are unique. |
| Avatar/cover upload | `/api/media` | POST | `{ reference, url }`; JPEG/PNG/WebP, maximum 3 MB, deterministic content key. |
| `addTransaction` | `/transactions` | POST | Atomic expense/income/transfer and server-calculated balances/analytics. |
| `settleWithFriend` | `/api/settlements` | POST | Combined creditor confirms partial/full/excess payment; residual debt moves to this payment. |
| Extract PDF statement | `/api/import/statement/pdf` | POST | `{ base64 }` (3 MiB/100 pages max) → `{ pages: string[] }`; text-only extraction for preview, no financial writes. |
| `importTransactions` | `/transactions/batch` | POST | 1–50 entries; individual transactions and stable per-entry retry keys. |
| Individual transaction | `/transactions/{id}` | GET/DELETE | Caller-visible history; expense payer (other types: creator) controls financial reversal and seven-day bin. |
| Edit transaction | `/api/transactions/{id}` | PUT | Owner-controlled atomic replacement of balances, shares, analytics and trip totals; stable transaction ID. |
| Settle one split member | `/api/transactions/{id}/settle` | POST | `{ friendId, amount, accountId? }`; only the expense payer confirms receipt. |
| Transaction bin | `/api/transactions/bin` | GET | Caller-visible deleted entries and owner-only `canRestore`, with seven-day expiry. |
| Restore transaction | `/api/transactions/{id}/restore` | POST | Owner re-applies financial effects before expiry; ledger-generation checks prevent restoring erased data. |
| Paginated history | `/transactions?limit=50&cursor=...` | GET | `{ items, cursor }`, scoped to caller/current generation. |
| Link/edit/remove member | `/entities/friends/{uid}` | PUT/DELETE | Registered members; deletion requires settled debts and no shared trip. |
| Create/edit/archive trip | `/entities/trips/{id}` | PUT/DELETE | Creator-controlled canonical trip and member projections. |
| Add/remove trip member | `/api/trips/{id}/members/{uid}` | PUT/DELETE | Creator-controlled membership; debts/history remain. |
| Trip history | `/api/trips/{id}/transactions?cursor=...` | GET | Canonical history and historical public profiles; current members only. |
| Payment profiles | `/entities/accounts/{id}` | PUT/DELETE | Create/update/archive; balances are server calculated; last four card digits only. |
| Categories | `/entities/categories/{id}` | PUT/DELETE | User category configuration. |
| Preferences | `/api/settings` | PUT | Selected/receiving profile, theme/privacy/glass; INR ledger. |
| Analytics | `/api/analytics?period=Month&year=2026&month=11` | GET | Real categories/totals/points; also Year and Date with `date=YYYY-MM-DD`. |
| Templates | `/templates`, `/templates/{id}` | GET/POST/PUT/DELETE | User-owned templates; `/api/templates` aliases also supported. |
| Recurring rules | `/recurring`, `/recurring/due`, `/recurring/{id}` | GET/POST/PUT/DELETE | Rules filtered to the current generation. |
| Process/skip recurring | `/recurring/{id}/process`, `/recurring/{id}/skip` | POST | Server-validated due-date advance; processing uses an occurrence key. |
| State hydration | `/state` | GET | Schema-version-2 cloud snapshot. |
| Fresh ledger | `/state/erase`, or DELETE `/state` | POST/DELETE | Resumable settled-only cleanup; preserves unpaid claims, connected transactions/payment history, members, groups and payment profiles. Clears saved rules/templates; regular Delete is unchanged. |
| Health/changelog | `/health`, `/changelog` | GET | Public information. |
| Admin publication | `/admin/changelog` | POST | Existing `x-admin-key`; never expose it in a mobile build. |

## Authentication, responses and storage

All protected routes require `Authorization: Bearer <Firebase ID token>`. Mutations require a unique `idempotency-key` and the exact same payload on retries; ordinary mutation markers last seven days, while `durableRetry: true` transaction-creation markers have no TTL. Firebase web settings are public app configuration. Never include service-account private keys, AWS credentials, admin keys or refresh tokens in `EXPO_PUBLIC_*`. Both mobile workflows receive their build configuration through GitHub Actions Secrets; local development uses ignored `.env`. Shared API keys and fixed user IDs no longer authenticate mobile requests.

Mutation responses normally contain `{ result, state }`. Snapshots include `schemaVersion: 2`, `userId`, `revision`, `profile`, `accounts`, `friends`, `trips`, `categories`, `transactions`, `transactionCursor`, `settings`, `resetPolicy: "settled-only"`, and all-time/category/month `summary` aggregates. Reset completion includes `removedTransactions` and `retainedTransactions`; requests may explicitly send `{ mode: "settled-only" }`. API amounts are rupees; calculations/storage use integer paise. `user` aliases the authenticated caller; other IDs must identify registered members. Caller-controlled `x-user-id` is ignored.

A ₹70.30 expense split equally between two people produces a ₹35.15 debt. A combined-creditor-confirmed ₹30.15 payment clears older pair vectors and carries the remaining ₹5 on the payment. Receiving ₹8 next creates a reversed ₹3 debt on the new payment. Individual settlement clears the selected member's source vector and any other claims reached by excess payment; unrelated members remain outstanding. Transaction details expose `settlementVector` with per-member remaining amounts and creditor/debtor directions. Deletion immediately reverses balances and moves all participant projections to the bin; restore re-applies them atomically. Complete-state PUT/POST is rejected with `405`; legacy `/auth/signup`, `/auth/signin`, `/auth/google` routes are retired in favor of Firebase.

Errors return `{ message, code, details? }` with their HTTP status. Clients refresh tokens after 401 and retry transient failures using the original key. Mobile expense/income/transfer creations, settlement receipts and imports use a durable, per-UID offline outbox containing the exact serialized request and key. Pending entries appear locally and synchronize serially at startup, foreground and connection polling. The last authoritative snapshot is retained separately, and pending effects are rebased after server updates. Queued settlements send `/transactions` with `type: settlement`, `targetFriendId`, optional `sourceTransactionId`, and an explicit captured amount. Their balance effects wait for server validation of outstanding claims. Mobile auth profile caching unlocks an existing session offline; a first sign-in/onboarding still needs a connection. Both iOS and Android use the shared auth and offline queue; visual/component optimization remains Android-only. Other mutations continue to require current server validation.

Mobile transaction inputs include `durableRetry: true` and `ledgerGeneration`. Independently keyed transactions always remain separate, including identical statement rows and expenses with matching amounts, dates, titles, payers, groups or split participants. There is no `DUPLICATE_TRANSACTION` content heuristic, history backfill or matching-scope lock. Older queued payloads containing `duplicateCheck` and `confirmDuplicate` are accepted unchanged; `duplicateCheck: true` only preserves their durable retry contract. Do not rewrite a serialized queued payload or replace its key during an ordinary retry. Permanent validation failures retain the draft with a review message. `LEDGER_GENERATION_CHANGED` prevents unsynced drafts from repopulating an erased ledger.

`durableRetry: true` creation request markers have no TTL, and creation IDs derive from UID plus request key. Projections include `clientRequestId` for pending reconciliation. A retry after a lost reply, app restart, expired ordinary marker, deletion or ledger reset returns the original result without a second write. Reusing its key with a different body returns `IDEMPOTENCY_CONFLICT`. Server batch imports retain the existing partial-save contract; Mobile imports queue individual stable requests instead.

Existing table usage: `SplitTrackData` holds profiles, username/search rows and transaction lookups; `SplitTrackLedgerData` holds user state, canonical trips, outstanding pair claims, journals, analytics, bin entries and request markers; `SplitTrackTransactions` holds user/trip projections with generation prefixes. The existing recurring/template/changelog tables retain their respective features. Queries and batch reads avoid scanning financial history for snapshots. Conditional revisions and DynamoDB transactions protect balances/projections together. TTL on the three existing data tables uses `expiresAt` for request markers and deleted journals, lookups, projections and bin entries. Deleted transactions become unavailable for restore exactly at seven days; DynamoDB physically removes expired records asynchronously afterward. Active history has no expiry.


PDF extraction runs after Firebase authentication in the existing API Lambda. Base64 must encode a PDF header and at most 3 MiB of raw bytes; URLs/passwords are not accepted. Text is emitted as one string per page, preserving row order for client statement parsers. Parsing runs in a terminable worker with an eight-second timeout, 100-page and 500,000-character caps, a bounded V8 heap, PDF.js evaluation disabled and no image rendering. The build packages the worker beside the shared API bundle. Documents are never persisted. `PDF_PASSWORD_REQUIRED`, `PDF_NO_TEXT`, `INVALID_PDF`, `PDF_TOO_LARGE`, `PDF_TOO_MANY_PAGES` and `PDF_EXTRACTION_TIMEOUT` let clients show actionable errors. Parsing does not require an idempotency key because only later reviewed/imported transactions mutate the ledger.
