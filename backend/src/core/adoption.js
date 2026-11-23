import { createHash } from 'node:crypto';
import { DynamoDBClient, TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb';
const client = new DynamoDBClient({ maxAttempts: 1 });
const seen = new Map();
export function adoptionWrite(uid, version, table, now = Date.now()) {
  const match = /^(android|ios)\/([1-9]\d{0,8})\/(\d+\.\d+\.\d+)$/.exec(version ?? '');
  if (!table || !uid || !match) return null;
  const [, platform, rawBuild] = match, build = Number(rawBuild), day = new Date(now).toISOString().slice(0, 10);
  const hash = createHash('sha256').update(`${uid}:${day}:${platform}:${build}`).digest('hex');
  const expires = String(Math.floor(now / 1000) + 8 * 86400);
  return { key: `${day}:${platform}:${build}:${hash}`, command: {
    TransactItems: [
      { Put: { TableName: table, Item: { platform: { S: `SEEN#${day}#${platform}#${build}` }, build_number: { N: String(parseInt(hash.slice(0, 13), 16)) }, expires_at: { N: expires } }, ConditionExpression: 'attribute_not_exists(platform)' } },
      { Update: { TableName: table, Key: { platform: { S: `ADOPTION#${day}` }, build_number: { N: String(build * 2 + (platform === 'ios' ? 1 : 0)) } }, UpdateExpression: 'SET target_platform = :p, app_build = :b, expires_at = :e ADD active_users :one', ExpressionAttributeValues: { ':p': { S: platform }, ':b': { N: String(build) }, ':e': { N: expires }, ':one': { N: '1' } } } }
    ]
  } };
}
export async function recordAdoption(uid, version) {
  const write = adoptionWrite(uid, version, process.env.ADOPTION_TABLE);
  if (!write || (seen.get(write.key) ?? 0) > Date.now()) return;
  // Optional telemetry is bounded and never changes financial request results.
  try { await client.send(new TransactWriteItemsCommand(write.command), { abortSignal: AbortSignal.timeout(200) }); seen.set(write.key, Date.now() + 3600000); }
  catch (e) { if (e.name === 'TransactionCanceledException') seen.set(write.key, Date.now() + 3600000); }
  if (seen.size > 1000) { for (const [key, expiry] of seen) if (expiry < Date.now()) seen.delete(key); if (seen.size > 1000) seen.delete(seen.keys().next().value); }
}
