import { PutCommand, GetCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './ddbClient.mjs';

const TABLE = () => process.env.ECHO_EXPECTATIONS_TABLE;

/**
 * DynamoDB port of apps/api/src/ingest/echo.js — same purpose (our own block
 * on `targetPlatform` fires a real notification there, which must not be
 * ingested back in as a fresh external booking, or the fan-out loops), but
 * simplified from Postgres's range-*overlap* query to an exact-slot key
 * match. Postgres needed overlap because a human's block action and the
 * resulting echo could arrive with slightly different reported bounds; here,
 * expectEcho() and claimEcho() are always called with the SAME startMs/endMs
 * this process itself just requested a block for, so there is nothing to
 * overlap against — an exact key is both simpler and correct for how this
 * system actually calls it.
 */
function key({ venueSlug, platform, externalCourtId, startMs, endMs }) {
  return `${venueSlug}#${platform}#${externalCourtId}#${startMs}#${endMs}`;
}

/** Called immediately before every outbound block or unblock action. */
export async function expectEcho({ venueSlug, platform, externalCourtId, startMs, endMs, ttlSeconds = 900 }) {
  await ddb.send(
    new PutCommand({
      TableName: TABLE(),
      Item: {
        pk: key({ venueSlug, platform, externalCourtId, startMs, endMs }),
        expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
        createdAt: new Date().toISOString(),
      },
    }),
  );
}

/**
 * Claim (consume, not just check) a matching expectation. Deleting it means a
 * second, genuine booking for the same slot minutes later is not swallowed.
 *
 * @returns {Promise<boolean>} true if an expectation was consumed (this
 *   ingest is our own echo — suppress it), false if it's a real external event.
 */
export async function claimEcho({ venueSlug, platform, externalCourtId, startMs, endMs }) {
  const pk = key({ venueSlug, platform, externalCourtId, startMs, endMs });
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE(), Key: { pk } }));
  if (!Item || Item.expiresAt < Math.floor(Date.now() / 1000)) return false;
  await ddb.send(new DeleteCommand({ TableName: TABLE(), Key: { pk } }));
  return true;
}
