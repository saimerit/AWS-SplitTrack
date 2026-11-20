import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOptions, planRetention, TARGET, validateFunctions } from '../scripts/configure-log-retention.mjs';

const now = Date.parse('2026-11-20T22:00:00Z');
const group = { logGroupName: '/aws/lambda/splittrack-backend-StateFunction-example', creationTime: now - 7 * 86400000, storedBytes: 1000 };

test('retention script defaults to dry-run and rejects ambiguous options', () => {
  assert.equal(parseOptions([]).apply, false);
  assert.equal(parseOptions(['--apply']).apply, true);
  assert.deepEqual(parseOptions(['--profile', 'splittrack']), { apply: false, profile: 'splittrack' });
  for (const args of [['--profile'], ['--region', 'us-east-1'], ['--stack', 'another-stack'], ['--unknown']]) assert.throws(() => parseOptions(args));
  assert.equal(TARGET.retentionDays, 30);
});

test('all five expected stack-owned functions are required before any retention write', () => {
  const resources = ['ApiFunction', 'AuthFunction', 'ChangelogFunction', 'HealthFunction', 'StateFunction'].map(logicalId => ({ LogicalResourceId: logicalId, PhysicalResourceId: `${TARGET.stack}-${logicalId}-example`, ResourceType: 'AWS::Lambda::Function', ResourceStatus: 'UPDATE_COMPLETE' }));
  assert.equal(validateFunctions(resources).length, 5);
  assert.throws(() => validateFunctions(resources.slice(1)));
  assert.throws(() => validateFunctions([...resources, { ...resources[0], LogicalResourceId: 'AnotherFunction' }]));
  assert.throws(() => validateFunctions(resources.map((item, index) => index ? item : { ...item, PhysicalResourceId: 'unrelated-function' })));
  assert.throws(() => validateFunctions(resources.map((item, index) => index ? item : { ...item, ResourceStatus: 'UPDATE_IN_PROGRESS' })));
});

test('unlimited log history is preserved by rejecting older or unverifiable events', () => {
  const recent = [{ firstEventTimestamp: now - 7 * 86400000 }, { firstEventTimestamp: now - 2 * 86400000 }];
  const plan = planRetention(group, recent, now);
  assert.equal(plan.changeRequired, true);
  assert.equal(plan.earliestEventAt, new Date(recent[0].firstEventTimestamp).toISOString());
  assert.throws(() => planRetention(group, [{ firstEventTimestamp: now - 31 * 86400000 }], now));
  assert.throws(() => planRetention(group, [{}], now));
});

test('already configured policies are idempotent and shorter policies can safely be extended', () => {
  const staleMetadata = [{ firstEventTimestamp: now - 60 * 86400000 }];
  assert.equal(planRetention({ ...group, retentionInDays: 30 }, staleMetadata, now).changeRequired, false);
  assert.equal(planRetention({ ...group, retentionInDays: 7 }, staleMetadata, now).changeRequired, true);
  assert.equal(planRetention(group, [], now).changeRequired, true);
});
