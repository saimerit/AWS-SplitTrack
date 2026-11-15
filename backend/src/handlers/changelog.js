import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { fail, ok, parseBody } from '../http.js';

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export async function handler(event) {
  try {
    const method = event.requestContext?.http?.method || event.httpMethod || 'GET';
    if (method === 'GET') {
      const result = await client.send(new ScanCommand({ TableName: process.env.CHANGELOG_TABLE }));
      return ok((result.Items || []).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)));
    }

    const adminHeader =
      event.headers?.['x-admin-key'] ||
      event.headers?.['X-Admin-Key'] ||
      event.headers?.['x-api-key'];

    if (process.env.ADMIN_API_KEY && adminHeader !== process.env.ADMIN_API_KEY) {
      return fail('Invalid admin key.', 401);
    }

    const { version, message, notes = [] } = parseBody(event);
    if (!version || !message) {
      return fail('version and message are required.');
    }

    const item = {
      releaseId: 'release',
      publishedAt: new Date().toISOString(),
      version,
      message,
      notes,
    };
    await client.send(new PutCommand({ TableName: process.env.CHANGELOG_TABLE, Item: item }));
    return ok(item, 201);
  } catch (error) {
    return fail(error.message || 'Unable to publish changelog.', 500);
  }
}
