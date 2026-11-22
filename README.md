# AWS SplitTrack

The existing AWS API now accepts Firebase ID tokens and stores real profiles, expenses, trips, payment profiles, shared balances, preferences and analytics. New Firebase users start with an empty ledger and nine configurable expense categories. Existing AWS records are retained.

The Expo application is maintained separately in [AdityaRoy999/splitrack](https://github.com/AdityaRoy999/splitrack). This repository contains `backend/`, the release-note `admin-dashboard/`, and a release helper. The local workspace at `C:\projects\AWS-SplitTrack` has independent `frontend-ios`, `frontend-android` and `backend` checkouts; the frontend code is outside this backend repository and its deployment bundle.

The local `Access/` folder, numbered Firebase registrations, service-account files, AWS credentials and deployment artifacts are ignored. The backend admin key remains in AWS SSM; templates contain only its dynamic reference. Each local checkout retains its existing GitHub origin and branch tracking.

## Existing resources

| Resource | Deployment |
| --- | --- |
| Region and stack | `ap-south-1`, `splittrack-backend` |
| HTTP API | `e3kt7e3dag`, [API base URL](https://e3kt7e3dag.execute-api.ap-south-1.amazonaws.com) |
| Lambdas | Existing API, Auth, State, Health and Changelog functions; Node.js 22, arm64, 256 MB, 15 seconds |
| DynamoDB | `SplitTrackData`, `SplitTrackLedgerData`, `SplitTrackTransactions`, `SplitTrackRecurring`, `SplitTrackTemplates`, `SplitTrackChangelog` |
| Private S3 bucket | `splittrack-deployments-726016642280-ap-south-1`; app images use `app-media/{firebaseUid}/` and expiring signed URLs |
| Admin authentication | Existing SSM `/splittrack/admin-api-key`; never include it in the mobile app |

The integration updates these resources in place without adding AWS services. The old API-key/JWT SSM parameters remain, but no longer authenticate mobile requests.

## Authentication and financial integrity

Enable Firebase Email/Password and configure the public Firebase web settings in the separate frontend's ignored `.env`. Both mobile platforms read all six Firebase client settings from ignored local `.env` or GitHub Actions Secrets. Lambda needs only the public `FirebaseProjectId` parameter, and verifies ID tokens using Google's cached signing certificates. No Firebase service-account key is needed for verification. Both mobile Google sign-in flows exchange a Google credential with Firebase. The supplied iOS registration matches the existing bundle and callback scheme; Android also requires its package and APK signing SHA-1 registered with Firebase. The supplied Google configuration contains a web OAuth client but no Android certificate registration. See [Google sign-in setup](https://github.com/AdityaRoy999/splitrack/blob/main/docs/android-google-sign-in.md) before device validation.

Protected routes require a Firebase bearer token. Mutations require a unique `idempotency-key` of 12–100 letters, digits, underscores or hyphens. Reuse the key and exact original payload when retrying. Ordinary request markers last seven days; mobile transaction creations with `durableRetry: true` retain their marker without TTL for durable offline retries. The legacy `duplicateCheck: true` flag is accepted only as a retry-durability alias for already-queued payloads. Creation IDs are deterministic from the authenticated UID and request key, and reuse with a different payload returns `409`. Complete-state `PUT`/`POST /state` returns `405`; clients cannot overwrite balances.

Password users can select **Settings → Sync with Google** to link the same Google email to their existing Firebase UID. Both sign-in methods then use the same AWS ledger and offline queue. Email/password signup with an existing email offers sign-in or a different signup account. Google credential collisions require explicit sign-in to the existing provider before linking; financial accounts are never merged by email alone.

Mobile transaction submissions set `durableRetry: true` and `ledgerGeneration`. Every independently keyed submission is a distinct transaction, even when its type, amount, payer, trip, people, title or date matches an earlier entry. Content-based duplicate rejection, scope locks and legacy index backfills have been removed from the financial write path. Exact-payload retries still reuse the original key and are applied once; changing its payload returns `IDEMPOTENCY_CONFLICT`. Old serialized `duplicateCheck`/`confirmDuplicate` fields remain accepted without any content matching so durable offline drafts retain their original hashes. Stored retired index pointers are removed opportunistically on edit/delete/reset; they are never rebuilt.

Authenticated `POST /api/import/statement/pdf` accepts `{ base64 }` for a text-based PDF (maximum 3 MiB and 100 pages) and returns `{ pages: string[] }` in page/row order for the existing import preview. This is extraction only: it does not store the document or write transactions, and needs no idempotency key. A bounded, text-only PDF.js worker runs within the existing API Lambda, with code evaluation disabled, an eight-second deadline, memory limits and a 500,000-character output cap. Password-protected, invalid and image-only/scanned PDFs return clear validation errors. No new AWS service is required.

All financial calculations use integer paise. Shared transactions, user balances, canonical trip projections, daily/monthly analytics and request markers commit in one DynamoDB transaction with conditional revisions and bounded conflict retries. Equal, exact, percentage and share splits are supported. Partial payments consume outstanding claims. Deleting an expense reverses its effects and restores already-paid portions as refund debts; deleting a payment reverses that payment. Only the creator can delete a transaction.

Trip creators manage membership. Removed members lose trip access and retain their financial history and debts. Display names may repeat, while usernames are claimed atomically. Search exposes public names, usernames and avatars; emails and payment-profile lists remain private. Receiving UPI IDs, payment names and app/bank branding are visible only in the owner's profile and linked-member snapshots, so both users' payment QRs use the same receiving identity. Public search excludes these receiving fields. Selecting a bank card preserves the receiving UPI profile; changing or removing that profile updates or clears its branding. Store only the last four card digits.

Payment profiles are manually entered ledger profiles, not bank integrations. A UPI QR contains the receiving UPI ID and amount. Users confirm payment in their UPI app; marking it paid records that confirmation and does not independently verify bank settlement.

`POST /state/erase` starts a fresh ledger by clearing settled history only. Outstanding claims, both owed and owing balances, their transactions and linked payment provenance are preserved. Members, payment profiles, groups, categories, sign-in and preferences stay. Retained transactions and their accounting effects move into the new ledger generation; stale unsynced drafts are still rejected. Saved recurring rules and templates are cleared. Shared settled history is removed only from the caller's view, preserving other participants' financial records. Regular transaction Delete retains its existing behavior.

Cleanup commits in bounded transactions and returns `result.needsContinue` when another request is needed. Reuse the same idempotency key; the snapshot's `ledgerResetId` lets the app resume after interruption. Completed responses include `removedTransactions` and `retainedTransactions` counts. Snapshots advertise `resetPolicy: "settled-only"`; updated apps verify it with a fresh read before clearing history so an older backend cannot erase debts. Normal financial writes reject with `LEDGER_RESETTING` during cleanup. `GET /state?after=<revision>` returns a small unchanged response when possible. No additional AWS services are required.

## Validate and deploy

The latest backend bundle was deployed on **23 November 2026 (IST)** through reviewed change set `reset-route-fix-20261122`; `splittrack-backend` reached `UPDATE_COMPLETE`. The reset endpoint now parses the request body before invoking settled-history cleanup, fixing the `ReferenceError` that returned HTTP 500. All five existing Lambda code hashes match the validated bundle. The same 44 resources and API definitions remain; only Lambda code changed. The 60 non-PDF backend tests passed, the five PDF tests passed when run separately, and the bundle build and packaged reset endpoint passed. Deployment evidence is in ignored `backend/.deployment/reset-route-fix-20261122/deployment-report.json`. Live health and unauthenticated state/reset route guards passed without creating or clearing user records. Authenticated real-user reset and native device flows remain to be checked from the app; see [mobile build steps](https://github.com/AdityaRoy999/splitrack/blob/main/docs/mobile-builds.md).

From `backend/`, run `npm ci` and `npm run validate`. Validation runs financial, concurrency, privacy and Firebase-token tests, then builds one ESM bundle with five small Lambda entry files in ignored `.build/`. The duplicate reference servers and custom password/JWT implementation were retired. See [FRONTEND_BACKEND_MAPPING.md](FRONTEND_BACKEND_MAPPING.md) for the API contract.

Package into the existing bucket and review a change set for the existing stack:

```powershell
New-Item -ItemType Directory -Force .deployment
aws cloudformation package --template-file template.yaml --s3-bucket splittrack-deployments-726016642280-ap-south-1 --output-template-file .deployment/packaged.yaml --region ap-south-1
aws cloudformation validate-template --template-body file://.deployment/packaged.yaml --region ap-south-1
aws cloudformation create-change-set --stack-name splittrack-backend --change-set-name REVIEWED_CHANGE_NAME --change-set-type UPDATE --template-body file://.deployment/packaged.yaml --parameters file://.deployment/parameters.json --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND --region ap-south-1
```

Create the ignored parameter file locally with `FirebaseProjectId` and `MediaBucketName`, preserving deployed values on later updates. Inspect `describe-change-set` before execution: all actions must modify existing resources without replacement. Under the current deployment constraints, do not execute additions, deletions or replacements. Confirm `UPDATE_COMPLETE`, health, authenticated requests and cross-user isolation afterward.

The admin dashboard continues to read `/changelog` and publish `/admin/changelog` with `x-admin-key`. Changelog fields remain `version`, `message` and `notes`. Keep the admin key local and out of Git.

## Performance and limits

Clients cache per-user snapshots and sync on startup, foregrounding and periodic refresh. Tab changes use loaded data. The server batches profile reads, paginates history, stores analytics aggregates and caches signing keys and signed image URLs inside warm Lambdas.

Trips/expenses support up to 12 participants. Active metadata and outstanding claims have bounded item sizes. Server batch imports accept 1–50 entries and commit individual transactions, so a failed batch may be partially saved; retry its original key or inspect history before importing again. The separate mobile frontend instead persists individual expense/income/transfer submissions, settlement receipts and imports in a per-user offline outbox, displays pending entries locally, and serially syncs them on reconnect/foreground refresh. It retains the server snapshot separately from optimistic balances. Settlement receipts capture an explicit amount and wait for server validation before changing balances. A stale `ledgerGeneration` rejects an unsynced draft after a ledger reset rather than recreating erased data. Edits, membership changes and media uploads still require a connection to validate current server data. Recurring processing is API-triggered; there is no scheduler or instant push synchronization. Image uploads accept JPEG/PNG/WebP up to 3 MB.

Actual latency and cost depend on traffic, cold starts, network, region and data size. There is no guaranteed latency, zero-cost or credit-lifetime promise.

The five existing Lambda log groups use 30-day retention to bound future diagnostic storage. Application records, offline request markers, authentication, DynamoDB on-demand billing, Lambda memory and private images are unaffected. Recheck the deployment with `node backend/scripts/configure-log-retention.mjs` from the repository root; it defaults to a dry run. Add `--apply` to configure only the five stack-owned log groups after account, logging destination and history checks. The script stops before any write if reducing retention would discard known events older than 30 days. Sanitized audit reports are saved in ignored `backend/.deployment/log-retention/`.
