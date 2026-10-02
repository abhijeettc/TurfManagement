import { ScanCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './ddbClient.mjs';

const TABLE = () => process.env.COURT_MAPPING_TABLE;

/**
 * Incoming court label on `platform` -> its mapping row, or null. A scan is
 * fine here — this table has one row per physical court at one venue, so a
 * few dozen items at most. A deployment covering many venues in one table
 * would need a GSI on (platform, externalLabel) instead; out of scope for the
 * one-venue-per-deployment model this system (like the doc) assumes.
 */
export async function findByExternalLabel(platform, label) {
  const { Items } = await ddb.send(new ScanCommand({ TableName: TABLE() }));
  const needle = String(label).trim().toLowerCase();
  const norm = (v) => String(v ?? '').trim().toLowerCase();
  // `aliases`: extra labels a message may use for this court (any platform).
  return (Items ?? []).find((row) => norm(row[platform]) === needle || (row.aliases ?? []).some((a) => norm(a) === needle)) ?? null;
}

export async function getMapping(canonicalCourt) {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE(), Key: { canonicalCourt } }));
  return Item ?? null;
}

/** Every enabled platform besides the source one, with that platform's own court name. */
export function otherTargets(mapping, sourcePlatform, { selfBlock = [] } = {}) {
  const enabled = mapping.enabledPlatforms ?? [];
  return enabled
    // A booking's own platform is normally skipped (it already holds the slot).
    // `selfBlock` lists platforms whose booking alerts should still block that
    // same platform — used when the alert is only a WhatsApp message and the
    // panel has not recorded the slot itself.
    .filter((platform) => platform !== sourcePlatform || selfBlock.includes(platform))
    .map((platform) => ({ platform, courtName: mapping[platform] }))
    .filter((target) => target.courtName);
}
