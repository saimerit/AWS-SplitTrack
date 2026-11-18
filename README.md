# AWS SplitTrack

The existing AWS API now accepts Firebase ID tokens and stores real profiles, expenses, trips, payment profiles, shared balances, preferences and analytics. New Firebase users start with an empty ledger and nine configurable expense categories. Existing AWS records are retained.

The Expo application is maintained separately in [AdityaRoy999/splitrack](https://github.com/AdityaRoy999/splitrack). This repository contains `backend/`, the release-note `admin-dashboard/`, and a release helper. The ignored `frontend/` checkout is not part of the deployed backend.

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

Enable Firebase Email/Password and configure the public Firebase web settings in the separate frontend's ignored `.env`. Lambda needs only the public `FirebaseProjectId` parameter, and verifies ID tokens using Google's cached signing certificates. No Firebase service-account key is needed for verification. Google sign-in remains unavailable until the mobile app registrations and OAuth configuration are provided.

Protected routes require a Firebase bearer token. Mutations require a unique `idempotency-key` of 12–100 letters, digits, underscores or hyphens. Reuse the key and exact original payload when retrying. Request markers last seven days, and reuse with a different payload returns `409`. Complete-state `PUT`/`POST /state` returns `405`; clients cannot overwrite balances.

All financial calculations use integer paise. Shared transactions, user balances, canonical trip projections, daily/monthly analytics and request markers commit in one DynamoDB transaction with conditional revisions and bounded conflict retries. Equal, exact, percentage and share splits are supported. Partial payments consume outstanding claims. Deleting an expense reverses its effects and restores already-paid portions as refund debts; deleting a payment reverses that payment. Only the creator can delete a transaction.

Trip creators manage membership. Removed members lose trip access and retain their financial history and debts. Display names may repeat, while usernames are claimed atomically. Search exposes public names, usernames and avatars; emails and payment-profile lists remain private. Receiving UPI IDs are visible to linked members. Store only the last four card digits.

Payment profiles are manually entered ledger profiles, not bank integrations. A UPI QR contains the receiving UPI ID and amount. Users confirm payment in their UPI app; marking it paid records that confirmation and does not independently verify bank settlement.

`POST /state/erase` starts a new private ledger generation after shared balances are settled and trips archived. It hides earlier history and disables prior-generation recurring rules, while retaining the registered profile and existing AWS records. It is not physical historical-record deletion.

## Validate and deploy

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

Trips/expenses support up to 12 participants. Active metadata and outstanding claims have bounded item sizes. Imports accept 1–50 entries and commit individual transactions, so a failed batch may be partially saved; retry its original key or inspect history before importing again. Recurring processing is API-triggered; there is no scheduler, offline financial-write queue or instant push synchronization. Image uploads accept JPEG/PNG/WebP up to 3 MB.

Actual latency and cost depend on traffic, cold starts, network, region and data size. There is no guaranteed latency, zero-cost or credit-lifetime promise.
