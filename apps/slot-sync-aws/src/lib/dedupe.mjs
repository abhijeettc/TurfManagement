import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { dedupeKey } from '@turfsync/core/dedupe.js';
import { ddb } from './ddbClient.mjs';

export { dedupeKey };

const TABLE = () => process.env.SLOT_SYNC_EVENTS_TABLE;

/**
 * DynamoDB equivalent of the doc's step 2: "a conditional write on
 * eventKey ... If it already exists, stop." `item.pk` is the event key
 * (`<platform>#<canonicalCourt>#<date>#<start>`).
 *
 * @returns {Promise<boolean>} true if this call created the row (proceed —
 *   this is a new event), false if it already existed (stop — duplicate).
 */
export async function claimEvent(item) {
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE(),
        Item: item,
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
    return true;
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}
