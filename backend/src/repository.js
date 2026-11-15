import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const dataTable = () => process.env.DATA_TABLE;

export async function loadState(userId) {
  const state = {
    accounts: [],
    friends: [],
    trips: [],
    categories: [],
    transactions: [],
  };

  let ExclusiveStartKey;
  do {
    const result = await client.send(
      new QueryCommand({
        TableName: dataTable(),
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: { ':userId': userId },
        ExclusiveStartKey,
      })
    );

    for (const item of result.Items || []) {
      if (item.entityType && item.entityId && item.data) {
        if (!state[item.entityType]) state[item.entityType] = [];
        state[item.entityType].push(item.data);
      }
    }
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return state;
}

export async function saveEntity(userId, entityType, entityId, data) {
  await client.send(
    new PutCommand({
      TableName: dataTable(),
      Item: {
        userId,
        recordId: `${entityType}#${entityId}`,
        entityType,
        entityId,
        data,
        updatedAt: new Date().toISOString(),
      },
    })
  );
}

export async function deleteEntity(userId, entityType, entityId) {
  await client.send(
    new DeleteCommand({
      TableName: dataTable(),
      Key: {
        userId,
        recordId: `${entityType}#${entityId}`,
      },
    })
  );
}

export async function saveEntities(userId, entities) {
  for (let offset = 0; offset < entities.length; offset += 25) {
    const chunk = entities.slice(offset, offset + 25);
    let requestItems = {
      [dataTable()]: chunk.map(({ entityType, entityId, data }) => ({
        PutRequest: {
          Item: {
            userId,
            recordId: `${entityType}#${entityId}`,
            entityType,
            entityId,
            data,
            updatedAt: new Date().toISOString(),
          },
        },
      })),
    };

    let retries = 0;
    while (requestItems && Object.keys(requestItems).length > 0 && retries < 3) {
      const response = await client.send(new BatchWriteCommand({ RequestItems: requestItems }));
      requestItems = response.UnprocessedItems;
      if (requestItems && Object.keys(requestItems).length > 0) {
        retries++;
        await new Promise((resolve) => setTimeout(resolve, 50 * Math.pow(2, retries)));
      }
    }
  }
}

export async function deleteEntities(userId, recordIds) {
  for (let offset = 0; offset < recordIds.length; offset += 25) {
    const chunk = recordIds.slice(offset, offset + 25);
    let requestItems = {
      [dataTable()]: chunk.map((recordId) => ({
        DeleteRequest: {
          Key: { userId, recordId },
        },
      })),
    };

    let retries = 0;
    while (requestItems && Object.keys(requestItems).length > 0 && retries < 3) {
      const response = await client.send(new BatchWriteCommand({ RequestItems: requestItems }));
      requestItems = response.UnprocessedItems;
      if (requestItems && Object.keys(requestItems).length > 0) {
        retries++;
        await new Promise((resolve) => setTimeout(resolve, 50 * Math.pow(2, retries)));
      }
    }
  }
}

export async function clearState(userId) {
  const recordsToDelete = [];
  let ExclusiveStartKey;
  do {
    const result = await client.send(
      new QueryCommand({
        TableName: dataTable(),
        KeyConditionExpression: 'userId = :userId',
        ProjectionExpression: 'recordId',
        ExpressionAttributeValues: { ':userId': userId },
        ExclusiveStartKey,
      })
    );
    for (const item of result.Items || []) {
      if (item.recordId) recordsToDelete.push(item.recordId);
    }
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  if (recordsToDelete.length > 0) {
    await deleteEntities(userId, recordsToDelete);
  }
  return { deletedCount: recordsToDelete.length };
}

export async function getUserById(userId) {
  if (!userId) return null;
  const cleanId = userId.startsWith('USER#') ? userId.slice(5) : userId;
  const result = await client.send(
    new GetCommand({
      TableName: dataTable(),
      Key: {
        userId: `USER#${cleanId}`,
        recordId: 'PROFILE',
      },
    })
  );
  return result.Item || null;
}

export async function getUserByEmail(email) {
  if (!email) return null;
  const normalizedEmail = email.toLowerCase().trim();
  const lookup = await client.send(
    new GetCommand({
      TableName: dataTable(),
      Key: {
        userId: `EMAIL#${normalizedEmail}`,
        recordId: 'LOOKUP',
      },
    })
  );
  if (!lookup.Item?.targetUserId) return null;
  return getUserById(lookup.Item.targetUserId);
}

export async function getUserByGoogleId(googleId) {
  if (!googleId) return null;
  const lookup = await client.send(
    new GetCommand({
      TableName: dataTable(),
      Key: {
        userId: `GOOGLE#${googleId}`,
        recordId: 'LOOKUP',
      },
    })
  );
  if (!lookup.Item?.targetUserId) return null;
  return getUserById(lookup.Item.targetUserId);
}

export async function createUser(userData) {
  const now = new Date().toISOString();
  const normalizedEmail = userData.email.toLowerCase().trim();
  const userProfile = {
    userId: `USER#${userData.id}`,
    recordId: 'PROFILE',
    id: userData.id,
    email: normalizedEmail,
    name: userData.name || normalizedEmail.split('@')[0],
    avatar: userData.avatar || '',
    dob: userData.dob || '',
    provider: userData.provider || 'email',
    passwordHash: userData.passwordHash || null,
    googleId: userData.googleId || null,
    createdAt: now,
    updatedAt: now,
  };

  const emailLookup = {
    userId: `EMAIL#${normalizedEmail}`,
    recordId: 'LOOKUP',
    targetUserId: userData.id,
    createdAt: now,
  };

  const items = [
    { PutRequest: { Item: userProfile } },
    { PutRequest: { Item: emailLookup } },
  ];

  if (userData.googleId) {
    items.push({
      PutRequest: {
        Item: {
          userId: `GOOGLE#${userData.googleId}`,
          recordId: 'LOOKUP',
          targetUserId: userData.id,
          createdAt: now,
        },
      },
    });
  }

  await client.send(
    new BatchWriteCommand({
      RequestItems: {
        [dataTable()]: items,
      },
    })
  );

  return userProfile;
}

export async function updateUser(userId, updates) {
  const cleanId = userId.startsWith('USER#') ? userId.slice(5) : userId;
  const existing = await getUserById(cleanId);
  if (!existing) return null;

  const updated = {
    ...existing,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  await client.send(
    new PutCommand({
      TableName: dataTable(),
      Item: updated,
    })
  );

  if (updates.googleId && updates.googleId !== existing.googleId) {
    await client.send(
      new PutCommand({
        TableName: dataTable(),
        Item: {
          userId: `GOOGLE#${updates.googleId}`,
          recordId: 'LOOKUP',
          targetUserId: cleanId,
          createdAt: new Date().toISOString(),
        },
      })
    );
  }

  return updated;
}

