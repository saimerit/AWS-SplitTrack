# Frontend to Backend Mapping

The Expo app (`frontend/`) uses an offline-first architecture powered by `@react-native-async-storage/async-storage` with automatic, non-blocking cloud persistence to AWS DynamoDB via `frontend/src/services/splitTrackApi.ts`.

## Environment Variables (`frontend/.env`)

```ini
EXPO_PUBLIC_API_URL=<YOUR_API_GATEWAY_URL>
EXPO_PUBLIC_API_KEY=<YOUR_SPLITTRACK_API_KEY>
EXPO_PUBLIC_USER_ID=user_sobha
```

## API Endpoints & Actions Mapping

| Mobile Store Action | API Route | HTTP Method | Server Behavior |
| --- | --- | --- | --- |
| `addTransaction` | `/transactions` | `POST` | Applies ledger rules in `backend/src/domain/ledger.js`. Updates account balance/spend, friend balances for equal/exact/percentage/shares splits, and trip spends. |
| `settleWithFriend` | `/transactions` | `POST` | Creates settlement transaction record, updates payer/receiver account balance and resets friend net balance to 0. |
| `importTransactions` (multi-app import) | `/transactions/batch` | `POST` | Processes batch array of imported JSON/XLSX transactions and atomically persists up to 25 items per DynamoDB chunk with retry backoff. |
| `deleteTransaction` | `/transactions/{transactionId}` | `DELETE` | Removes transaction from DynamoDB. |
| `addFriend`, `updateFriend` | `/entities/friends/{id}` | `PUT` | Persists friend record in DynamoDB. |
| `deleteFriend` | `/entities/friends/{id}` | `DELETE` | Removes friend record from DynamoDB. |
| `addTrip`, `addMemberToTrip` | `/entities/trips/{id}` | `PUT` | Persists trip record in DynamoDB. |
| `deleteTrip` | `/entities/trips/{id}` | `DELETE` | Removes trip record from DynamoDB. |
| `addUpiAccount` | `/entities/accounts/{id}` | `PUT` | Persists UPI / card account record in DynamoDB. |
| `deleteUpiAccount` | `/entities/accounts/{id}` | `DELETE` | Removes account record from DynamoDB. |
| `addCategory`, `updateCategory` | `/entities/categories/{id}` | `PUT` | Persists custom category in DynamoDB. |
| `deleteCategory` | `/entities/categories/{id}` | `DELETE` | Removes category record from DynamoDB. |
| State Hydration | `/state` | `GET` | Paginated DynamoDB query returning `{ accounts, friends, trips, categories, transactions }`. |
| Full Cloud Sync | `/state` | `PUT` / `POST` | Batch synchronizes complete local state to DynamoDB. |
| `eraseAllData` (Fresh Start) | `/state/erase` | `POST` / `DELETE` | Batch deletes all stored entities and transactions for the user. |
| Service Health | `/health` | `GET` | Health check endpoint returning status and API version. |
| View Changelog | `/changelog` | `GET` | Returns list of published release notes. |
| Admin Publish Changelog | `/admin/changelog` | `POST` | Publishes new release notes (protected by `x-admin-key`). |

## Architecture & Cost Optimization ($200 Credit Efficiency)

1. **Amazon API Gateway HTTP API (v2)**:
   - 70% cheaper than REST API ($1.00 per million requests).
   - Built-in CORS and sub-millisecond overhead.
2. **AWS Lambda (arm64 Graviton2)**:
   - 20% lower cost per ms with faster cold-starts on Node.js 22.x.
   - 256MB memory allocation.
   - Perpetual AWS Free Tier: 1,000,000 invocations and 3.2M seconds free each month.
3. **Amazon DynamoDB (Pay-Per-Request)**:
   - $0.00 idle cost (no provisioned read/write capacity charges).
   - Free Tier perpetual allowance: 25GB storage, 25 RCU/WCU.
4. **AWS Systems Manager (SSM) Parameter Store**:
   - Standard tier parameters for API keys (`/splittrack/api-key` and `/splittrack/admin-api-key`) with zero maintenance cost.
5. **Idle Monthly Cost**: **$0.00**. $200 credits will easily last for years under typical production usage.
