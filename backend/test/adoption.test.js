import test from 'node:test';
import assert from 'node:assert/strict';
import { adoptionWrite } from '../src/core/adoption.js';
test('adoption accepts only bounded native version headers', () => {
  for (const version of ['android/0/1.0.0', 'web/42/1.0.42', 'android/1000000000/1.0.42', 'android/42/bad', undefined]) assert.equal(adoptionWrite('user', version, 'table'), null);
  assert.equal(adoptionWrite('user', 'android/42/1.0.42', ''), null);
});
test('one atomic transaction deduplicates each user/build/day without storing raw identities', () => {
  const first = adoptionWrite('private-user-id', 'android/42/1.0.42', 'table', Date.parse('2026-11-23T12:00:00Z'));
  const retry = adoptionWrite('private-user-id', 'android/42/1.0.42', 'table', Date.parse('2026-11-23T13:00:00Z'));
  assert.equal(first.key, retry.key);
  assert.equal(first.command.TransactItems[0].Put.ConditionExpression, 'attribute_not_exists(platform)');
  assert.equal(first.command.TransactItems[1].Update.ExpressionAttributeValues[':one'].N, '1');
  assert.ok(!JSON.stringify(first).includes('private-user-id'));
  assert.notEqual(first.key, adoptionWrite('other', 'android/42/1.0.42', 'table').key);
});
test('Android and iOS aggregates cannot overwrite each other at the same build number', () => {
  const a = adoptionWrite('user', 'android/42/1.0.42', 'table'), i = adoptionWrite('user', 'ios/42/1.0.42', 'table');
  assert.notEqual(a.command.TransactItems[1].Update.Key.build_number.N, i.command.TransactItems[1].Update.Key.build_number.N);
});
