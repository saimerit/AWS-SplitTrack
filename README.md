# AWS SplitTrack

Production-grade, ultra-cost-optimized AWS serverless backend and offline-first mobile app for SplitTrack.

## Deployed Architecture & Endpoints

- **API Base URL**: `https://cwzc799nji.execute-api.ap-south-1.amazonaws.com`
- **Region**: `ap-south-1` (Mumbai)
- **API Key**: `<YOUR_SPLITTRACK_API_KEY>`
- **Admin Key (SSM `/splittrack/admin-api-key`)**: `fb213c671d6e3b1515b72e4c63e24d3304131cf7960fde08`
- **DynamoDB Data Table**: `SplitTrackData` (Pay-per-request, On-Demand)
- **DynamoDB Changelog Table**: `SplitTrackChangelog` (Pay-per-request, On-Demand)

## Cost Optimization Highlights

- **$0.00 Idle Cost**: Zero EC2 instances, zero RDS databases, zero NAT gateways.
- **Pay-Per-Request DynamoDB**: Free tier covers up to 25GB storage and 2.5 million reads / 1 million writes monthly.
- **Graviton2 (arm64) Lambda Functions**: 20% cheaper and lower latency than x86_64.
- **HTTP API Gateway v2**: 70% cheaper than REST API v1.
- **Credit Longevity**: The $200 AWS credit will last for years under normal usage.

## Layout

- `frontend/` — Up to date clone of `AdityaRoy999/splitrack` with offline-first local storage and automatic background sync to AWS.
- `backend/` — Node 22 AWS serverless backend (HTTP API, Lambda arm64, DynamoDB).
- `admin-dashboard/` — Static release and changelog dashboard.
- `scripts/` — Automated release workflows.

## How to Test Frontend

1. Ensure `frontend/.env` contains:
   ```ini
   EXPO_PUBLIC_API_URL=https://cwzc799nji.execute-api.ap-south-1.amazonaws.com
   EXPO_PUBLIC_API_KEY=<YOUR_SPLITTRACK_API_KEY>
   EXPO_PUBLIC_USER_ID=user_sobha
   ```
2. Start the Expo app:
   ```bash
   cd frontend
   npx expo start -c
   ```
3. Press `w` to open in browser (web mode), or scan QR code with Expo Go on your mobile device (iOS / Android).
