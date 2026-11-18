import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  BatchGetCommand,
  QueryCommand,
  TransactWriteCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";

const client = DynamoDBDocumentClient.from(
  new DynamoDBClient({ maxAttempts: 4 }),
  { marshallOptions: { removeUndefinedValues: true } },
);
export class AwsRepository {
  constructor(db = client) {
    this.client = db;
    this.tables = {
      data: process.env.DATA_TABLE || "SplitTrackData",
      ledger: process.env.LEDGER_DATA_TABLE || "SplitTrackLedgerData",
      transactions: process.env.TRANSACTIONS_TABLE || "SplitTrackTransactions",
      changelog: process.env.CHANGELOG_TABLE || "SplitTrackChangelog",
      recurring: process.env.RECURRING_TABLE || "SplitTrackRecurring",
      templates: process.env.TEMPLATES_TABLE || "SplitTrackTemplates",
    };
  }
  async get(table, key) {
    return (
      await this.client.send(
        new GetCommand({
          TableName: this.tables[table],
          Key: key,
          ConsistentRead: true,
        }),
      )
    ).Item;
  }
  async many(table, keys) {
    const result = [];
    const unique = [
      ...new Map(keys.map((key) => [JSON.stringify(key), key])).values(),
    ];
    for (let offset = 0; offset < unique.length; offset += 100) {
      let requested = {
        [this.tables[table]]: {
          Keys: unique.slice(offset, offset + 100),
          ConsistentRead: true,
        },
      };
      let attempts = 0;
      while (Object.keys(requested).length) {
        const response = await this.client.send(
          new BatchGetCommand({ RequestItems: requested }),
        );
        result.push(...(response.Responses?.[this.tables[table]] || []));
        requested = response.UnprocessedKeys || {};
        if (Object.keys(requested).length) {
          if (++attempts > 7) throw new Error("Incomplete database read");
          await new Promise((resolve) =>
            setTimeout(resolve, 20 * 2 ** attempts),
          );
        }
      }
    }
    return result;
  }
  async query(
    table,
    partition,
    value,
    { prefix, cursor, limit = 50, reverse = false } = {},
  ) {
    const sort =
      {
        transactions: "transactionId",
        recurring: "recurringId",
        templates: "templateId",
      }[table] || "recordId";
    const names = { "#pk": partition },
      values = { ":pk": value };
    let expression = "#pk = :pk";
    if (prefix) {
      names["#sk"] = sort;
      values[":prefix"] = prefix;
      expression += " AND begins_with(#sk, :prefix)";
    }
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tables[table],
        KeyConditionExpression: expression,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ExclusiveStartKey: cursor,
        Limit: limit,
        ScanIndexForward: !reverse,
        ConsistentRead: true,
      }),
    );
    return { items: result.Items || [], cursor: result.LastEvaluatedKey };
  }
  async transact(actions) {
    await this.client.send(
      new TransactWriteCommand({
        TransactItems: actions.map((action) => {
          const table = this.tables[action.table];
          if (action.type === "delete")
            return { Delete: { TableName: table, Key: action.key } };
          const condition = action.unique
            ? "attribute_not_exists(#pk) OR #owner = :owner"
            : action.revision !== undefined
              ? action.revision === 0
                ? "attribute_not_exists(#rev) OR #rev = :rev"
                : "#rev = :rev"
              : undefined;
          const names = action.unique
            ? { "#pk": "userId", "#owner": "uid" }
            : condition
              ? { "#rev": "revision" }
              : undefined;
          const values = action.unique
            ? { ":owner": action.item.uid }
            : condition
              ? { ":rev": action.revision }
              : undefined;
          return {
            Put: {
              TableName: table,
              Item: action.item,
              ConditionExpression: condition,
              ExpressionAttributeNames: names,
              ExpressionAttributeValues: values,
            },
          };
        }),
      }),
    );
  }
  async releases() {
    const result = await this.client.send(
      new ScanCommand({ TableName: this.tables.changelog, Limit: 100 }),
    );
    return (result.Items || []).sort((a, b) =>
      String(b.publishedAt).localeCompare(String(a.publishedAt)),
    );
  }
}
export const repository = new AwsRepository();
