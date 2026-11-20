# AWS SplitTrack

The existing AWS API now accepts Firebase ID tokens and stores real profiles, expenses, trips, payment profiles, shared balances, preferences and analytics. New Firebase users start with an empty ledger and nine configurable expense categories. Existing AWS records are retained.

The Expo application is maintained separately in [AdityaRoy999/splitrack](https://github.com/AdityaRoy999/splitrack). This repository contains `backend/`, the release-note `admin-dashboard/`, and a release helper. The ignored `frontend/` checkout is not part of the deployed backend.

The local `Access/` folder, numbered Firebase registrations, service-account files, AWS credentials and deployment artifacts are ignored. The backend admin key remains in AWS SSM; templates contain only its dynamic reference. The separately maintained `frontend/` checkout is excluded from this repository.

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

Protected routes require a Firebase bearer token. Mutations require a unique `idempotency-key` of 12–100 letters, digits, underscores or hyphens. Reuse the key and exact original payload when retrying. Ordinary request markers last seven days; Mobile transaction creations opting into `duplicateCheck` retain their marker without TTL for durable offline retries. Creation IDs are deterministic from the authenticated UID and request key, and reuse with a different payload returns `409`. Complete-state `PUT`/`POST /state` returns `405`; clients cannot overwrite balances.

Password users can select **Settings → Sync with Google** to link the same Google email to their existing Firebase UID. Both sign-in methods then use the same AWS ledger and offline queue. Email/password signup with an existing email offers sign-in or a different signup account. Google credential collisions require explicit sign-in to the existing provider before linking; financial accounts are never merged by email alone.

Mobile transaction submissions set `duplicateCheck: true`. The server warns with `409 DUPLICATE_TRANSACTION` when an active, caller-visible transaction has the same type, amount in paise and payer, and either the same trip or the same set of split participants. Dates and titles do not affect matching. `details.existingTransaction` supplies the existing entry for the frontend's Continue/Cancel sheet. An explicit Continue creates a new request key and includes `confirmDuplicate: true`; ordinary retries preserve the original key and exact payload. Existing clients without `duplicateCheck` retain their submission behavior. Indices and conditional scope revisions live in the existing ledger table and commit atomically with financial changes; legacy projections are indexed in resumable pages on first use.

All financial calculations use integer paise. Shared transactions, user balances, canonical trip projections, daily/monthly analytics and request markers commit in one DynamoDB transaction with conditional revisions and bounded conflict retries. Equal, exact, percentage and share splits are supported. Partial payments consume outstanding claims. Deleting an expense reverses its effects and restores already-paid portions as refund debts; deleting a payment reverses that payment. Only the creator can delete a transaction.

Trip creators manage membership. Removed members lose trip access and retain their financial history and debts. Display names may repeat, while usernames are claimed atomically. Search exposes public names, usernames and avatars; emails and payment-profile lists remain private. Receiving UPI IDs are visible to linked members. Store only the last four card digits.

Payment profiles are manually entered ledger profiles, not bank integrations. A UPI QR contains the receiving UPI ID and amount. Users confirm payment in their UPI app; marking it paid records that confirmation and does not independently verify bank settlement.

`POST /state/erase` starts a fresh ledger even with unpaid balances or active trips. It clears the caller's payment profiles and relationships, cancels pair claims, removes owned trips (including archived records and their trip history), and leaves joined trips for the other members. Paginated cleanup physically deletes the caller's transaction projections, lookups, private journals, analytics, recurring rules and templates. Shared journals retain the other participants' financial history and detach the reset user's effects, so later deletion cannot recreate an old debt. Sign-in, profile and app preferences stay.

Cleanup commits in bounded transactions and returns `result.needsContinue` when another request is needed. Reuse the same idempotency key; the snapshot's `ledgerResetId` lets the app resume after interruption. Normal financial writes reject with `LEDGER_RESETTING` during cleanup. `GET /state?after=<revision>` returns a small unchanged response when possible, allowing fast foreground reconciliation on the existing HTTP API. No additional AWS services are required.

## Validate and deploy

The latest backend bundle was deployed on **20 November 2026** through reviewed change set `offline-duplicates-20261120-150102`; `splittrack-backend` reached `UPDATE_COMPLETE`. All five existing Lambda code hashes match the validated bundle, with no resource additions, deletions or replacements. Deployment evidence is in ignored `backend/.deployment/deployment-report.md`. Build the separate frontend to receive the new mobile behavior; see [mobile build steps](https://github.com/AdityaRoy999/splitrack/blob/main/docs/mobile-builds.md).

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
