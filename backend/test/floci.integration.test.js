import test from 'node:test';
import assert from 'node:assert/strict';
import { DynamoDBClient, CreateTableCommand, ListTablesCommand, PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';

const endpoint = process.env.FLOCI_ENDPOINT || 'http://127.0.0.1:4566';
const client = new DynamoDBClient({ endpoint, region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
const tableName = 'splittrack-floci-smoke';

test('Floci provides the DynamoDB operations used by SplitTrack', async () => {
  const tables = await client.send(new ListTablesCommand({}));
  if (!tables.TableNames?.includes(tableName)) {
    await client.send(new CreateTableCommand({
      TableName: tableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'userId', AttributeType: 'S' }, { AttributeName: 'recordId', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }, { AttributeName: 'recordId', KeyType: 'RANGE' }],
    }));
  }
  await client.send(new PutItemCommand({ TableName: tableName, Item: { userId: { S: 'smoke-user' }, recordId: { S: 'accounts#a' }, payload: { S: 'ok' } } }));
  const result = await client.send(new QueryCommand({
    TableName: tableName, KeyConditionExpression: 'userId = :id', ExpressionAttributeValues: { ':id': { S: 'smoke-user' } },
  }));
  assert.equal(result.Items?.[0]?.payload?.S, 'ok');
});
