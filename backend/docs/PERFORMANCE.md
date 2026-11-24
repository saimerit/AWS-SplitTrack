# Backend latency and growth plan

## Current deployment: 24 November 2026

The app currently has 2–3 users. Keep the existing serverless architecture and pay for actual requests. The 500,000-user requirement is a future capacity target, not capacity that should be purchased today. Every API below 5 ms, including Internet travel, first requests, durable writes and imports, is not a supportable guarantee.

The `splittrack-backend` stack stays in Mumbai (`ap-south-1`). API, State and Auth functions now use 1,024 MB ARM Lambda; Changelog uses 512 MB and Health stays at 256 MB. DynamoDB remains on demand with strongly consistent financial reads, atomic writes, conditional revisions and durable request IDs. No ledger tables or user records were changed during performance verification.

API and State have `live` aliases, and their API Gateway integrations point to those aliases. The template prepares optional provisioned concurrency and target tracking. `EnableWarmConcurrency=false` is the deployed setting: there is no idle provisioned compute charge. Ordinary Lambda scaling still operates within account and service quotas.

## Measurements and changes

The production audit covered 2,643 requests over 48 hours before this change. API Gateway p50 was 23.9 ms, p95 892.5 ms and p99 2,268.6 ms. These percentiles combine routes and cold starts; they are not latency promises for an individual API. Warm State p50 was 14.45 ms and warm API p50 114.62 ms. The particularly slow screenshot interval had only three calls, including two cold starts. DynamoDB transaction service means were 12.4–15.7 ms, before client transport and SDK work.

A temporary, read-only Lambda used the production repository code to retrieve an absent synthetic key. There were six invocations per memory size and 42 subsequent reads per size. No authenticated request, scan, write or user record was involved; the probe was deleted afterward. These are small-sample measurements of an SDK read, excluding API Gateway, authentication, application work and Internet travel:

| ARM Lambda memory | Warm read p50 | Warm read p95 | Warm read p99 | First read in first invocation |
| --- | ---: | ---: | ---: | ---: |
| 256 MB | 19.83 ms | 39.96 ms | 56.11 ms | 258.18 ms |
| 512 MB | 2.94 ms | 19.54 ms | 24.32 ms | 138.97 ms |
| 1,024 MB | 3.08 ms | 6.33 ms | 16.76 ms | 80.39 ms |

1 GB was selected for the interactive functions because its measured tail was lower. Even this narrow warm read did not stay below 5 ms. The probe's invocation compute cost was similar at 256 MB and 1 GB because the larger allocation completed much sooner; the actual app's cost depends on its route durations.

After deployment, 38 authenticated production requests used two temporary Firebase accounts and synthetic wallets/expenses. The test covered refreshes, six own expenses, a shared expense, both member balances, a ten-entry import, and exact expense/import retries. All correctness assertions passed. Both Firebase accounts were deleted and all 88 known test database keys were verified absent afterward. No existing user's ledger was used. API access logs matched all 38 requests:

| Route scenario | Samples | API Gateway p50 | API Gateway p95 | Laptop round-trip p50 |
| --- | ---: | ---: | ---: | ---: |
| Unchanged revision sync | 8 | 19 ms | 26 ms | 48.52 ms |
| Full refresh | 7 | 25 ms | 35 ms | 58.37 ms |
| Own expense save | 6 | 55 ms | 68 ms | 93.65 ms |
| Shared expense | 1 | 72 ms | 72 ms | 101.85 ms |
| Ten-entry import | 1 | 395 ms | 395 ms | 452.47 ms |
| Exact import retry | 1 | 99 ms | 99 ms | 130.03 ms |

These are small-sample functional tests, not load acceptance. A single sample's p95 is the same observation and has no tail-estimation value. First authenticated state/profile requests still reached 733/989 ms at API Gateway (942/1,021 ms from the laptop). A sampled first profile request spent 106.74 ms verifying auth and 430.72 ms in database calls, including a 60.12-ms commit; the 505.86-ms handler duration excludes initialization and overlapping phases. Warm capacity is still needed to reduce that first-use delay when the account quota permits it. The measured APIs do not meet a universal 5-ms target.

Code changes:

- Prefer SDK ESM exports during bundling, reducing the main bundle from 808,557 to approximately 558,000 bytes while retaining pinned, packaged dependencies.
- Share pending and completed reads within a single request. Cache misses as well as rows; clear the read set after successful or failed commits. Financial data is never cached across users or requests.
- Start marker/state reads together. After observing an existing request marker, reread state so a racing retry cannot return a precommit revision.
- Read initial state before its profile, and refresh a bootstrap profile before mutation revision reads. Preserve another device's profile changes and avoid returning stale profile data with a newer revision.
- Build one final snapshot for `/transactions/batch`; each entry still commits atomically and retains its own durable retry marker. An interrupted batch can be retried with its original key without duplicate entries.
- Overlap optional version-adoption telemetry with state work, while awaiting it inside the request lifetime.
- During provisioned initialization, fetch Firebase signing keys and establish the database connection using the same caches and clients that serve requests.
- Record sampled authentication, database, commit, snapshot, telemetry and serialization timings with SDK retry counts. API access logs correlate integration and gateway timings without names, IDs from route paths, credentials or financial payloads.

A local synthetic benchmark used the real handler/service with delayed in-memory repository operations. At a configured 20 ms read/commit delay, eight samples showed median reductions of approximately 15% for own income, 12% for shared expenses and 32% for a ten-entry import. An import's history queries fell from 11 to 1. These timings reflect Windows timer scheduling and simulated I/O; they are not AWS latency, throughput or a 500,000-user load test. Twenty concurrent synthetic snapshots did not improve in that run. Use the operation-count changes and production timings to evaluate the result.

## Warm capacity when the account permits it

The regional Lambda account quota is currently 10 concurrent executions. Increase request `556944b94e67430fb4820368d584f99b0chslVzU` asks for 1,000 and remains `CASE_OPENED` at verification. This request does not purchase capacity. AWS requires provisioned concurrency to leave 100 unreserved executions, so the present reduced quota cannot support the warm configuration.

From the repository root, inspect the plan:

```powershell
node backend/scripts/configure-warm-capacity.mjs
```

The script verifies the AWS account, stack, ARM architecture, aliases, existing regional allocations and quotas. It defaults to a dry run. With the current defaults, each alias starts with one ready environment and may scale to two at 70% utilization. At 1 GB, the two aliases together cost about **$18.66–$37.31 per 30 days for provisioned capacity alone**, using AWS's Mumbai quote on 24 November 2026. Requests, execution duration, database, logging, bandwidth and taxes are additional. This is recurring spending from a finite credit balance.

Once the quota allows it and that recurring spend fits the budget:

```powershell
node backend/scripts/configure-warm-capacity.mjs --apply
```

The script creates and reviews a CloudFormation change set affecting only the two aliases and four optional scaling resources, then starts its execution. Verify `UPDATE_COMPLETE`, provisioned status `READY`, and the API Gateway alias integrations afterward. Disable through the same stack:

```powershell
node backend/scripts/configure-warm-capacity.mjs --disable --apply
```

`WarmMinConcurrency` and `WarmMaxConcurrency` can be increased later, from a measured request rate and approved quota/budget. The defaults are small to serve current usage. A warm-capacity maximum limits idle provisioned capacity; it is not an AWS bill cap, total concurrency cap, or a guarantee against cold spillover. Reactive scaling takes time; prepare capacity ahead of a known burst. Auth, Health and Changelog remain on demand.

## What must change before 500,000 active users

Simultaneous users and requests per second are different quantities. The current mobile store polls about every five seconds while foregrounded, with retries backing off. It also periodically requests a complete snapshot. At 500,000 foreground users, unchanged polling alone would generate approximately **100,000 requests/second**. Extending the interval alone cannot make this workload inexpensive:

| Interval, continuously active users | Poll requests/second | HTTP API request cost over 30 days |
| --- | ---: | ---: |
| 5 seconds | 100,000 | $246,270 |
| 30 seconds | 16,667 | $41,070 |
| 60 seconds | 8,333 | $20,550 |

These are illustrative API Gateway request costs using Mumbai tiered pricing, before Lambda, database or bandwidth. They assume all 500,000 users are active continuously for 30 days. They describe the future scenario, not today's 2–3-user bill.

Proceed in stages:

1. **Current small audience:** deploy measured CPU/bundle/read improvements, keep request-driven billing, and collect route p50/p95/p99 plus errors, retries, cold starts and costs. Keep tab changes local. Verify expenses and settlements on both devices after rollout.
2. **Before broad release:** introduce adaptive polling with jitter and revision checks, retain immediate refresh on foreground/manual refresh/mutation, and avoid unconditional full snapshots when the revision is unchanged. This requires a separately validated mobile release on both branches. Set spending alerts at amounts that fit the remaining credits; alerts do not stop bills.
3. **Growing active audience:** introduce authorized, per-user change notifications over managed realtime connections. Keep the persisted offline outbox and authoritative reconciliation; never trust a notification as the committed balance. A database-stream/outbox design must tolerate retries and out-of-order events. In-app realtime does not require iOS APNs, but cannot keep an app running indefinitely while iOS suspends it.
4. **Large bursts:** load test an isolated environment with realistic users, ledger sizes, groups, read/write ratios and traffic ramp. Lambda's synchronous request quota, scaling ramp and account concurrency, HTTP API RPS quota, DynamoDB per-table maximums/previous peak and hot partitions, and realtime connection limits all need independent checks. Current API Gateway quota is 10,000 RPS; a Lambda increase to 1,000 is not a 100,000-RPS approval.
5. **Data paths at scale:** the reset-only `ownedTrips` discovery currently scans the ledger table and filters by owner. Replace this with a maintained owner index before the shared ledger becomes large. Version-adoption telemetry updates a per-day/build aggregate; use sharded aggregates or asynchronous processing before a simultaneous upgrade concentrates writes on one item. A popular shared trip still contends on conditional trip/state records. Profile search partitions by initial character and large analytics/reset/import operations need their own throughput and latency budgets. Keep maintenance and PDF work out of interactive request capacity as volume grows.
6. **Capacity acceptance:** test peak RPS rather than only registered-user count. A useful example is 500,000 connected users each making one interactive request/minute: about 8,333 RPS before background work. Measure normal, hot-group, reconnect-storm, dependency slowdown and throttling cases. Validate correctness and recovery as well as latency. Only claim the traffic profile actually tested.

Use separate latency objectives for warm revision reads, full snapshots, durable mutations and imports. If an internal sub-5-ms read target remains essential, evaluate a correctly invalidated in-memory read projection near always-running compute. It adds operational cost and does not make Internet round trips or durable ledger transactions universally sub-5-ms. A Go rewrite alone cannot remove those dependencies.

## Verification and evidence

All 85 checks pass: 80 financial, Firebase, request-cache, retry, provisioned-initialization and capacity-plan checks, plus five PDF checks. PDF extraction checks were run separately because the existing PDF.js worker can intermittently crash the Windows Node process when tests run together. The packaged Lambda was checked for Firebase signature validation, route guards and PDF worker loading. Mobile lint and TypeScript checks also pass; this change contains no mobile code.

The isolated memory benchmark, synthetic experiment and authenticated test report are in ignored `backend/.deployment/latency-optimization-20261124/`. Rollback template and both reviewed change sets are saved there. Live health/guard checks passed, and all 19 interactive integrations use the `live` aliases on version 2. The deployed archive checksum and core bundle match the validated build. Authenticated native-device rendering and peak-traffic acceptance still need dedicated validation; the synthetic-account test does not establish sustained production p95 or load capacity.

Run a synthetic comparison against an archived baseline source directory:

```powershell
node backend/scripts/benchmark-latency.mjs --baseline=.deployment/latency-optimization-20261124/baseline/src --read-ms=20 --commit-ms=20 --samples=8 --output=.deployment/latency-optimization-20261124/synthetic-benchmark-final.json
```

Request timings sample 1% by default and always record responses taking at least 500 ms and 5xx errors. `PERFORMANCE_LOG_SAMPLE_RATE` and `PERFORMANCE_SLOW_MS` control those thresholds. Phase totals may overlap and are not additive; `durationMs` is handler wall time and excludes Lambda initialization. API access logs are retained for seven days; Lambda log groups retain their existing 30-day policy.

## References

- [Lambda CPU allocation](https://docs.aws.amazon.com/lambda/latest/dg/configuration-memory.html), [concurrency/RPS/scaling quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html).
- [Provisioned concurrency, initialization and alias requirements](https://docs.aws.amazon.com/lambda/latest/dg/provisioned-concurrency.html), [Application Auto Scaling](https://docs.aws.amazon.com/autoscaling/application/userguide/services-that-can-integrate-lambda.html).
- [DynamoDB transaction semantics](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html), [on-demand scaling](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/on-demand-capacity-mode.html).
- [HTTP API metrics](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-metrics.html), [gateway quotas](https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html), [access-log fields](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-logging-variables.html).
- [Lambda pricing](https://aws.amazon.com/lambda/pricing/), [API Gateway pricing](https://aws.amazon.com/api-gateway/pricing/), [DynamoDB on-demand pricing](https://aws.amazon.com/dynamodb/pricing/on-demand/).
