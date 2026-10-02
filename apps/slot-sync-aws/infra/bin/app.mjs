#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { SlotSyncStack } from '../lib/slot-sync-stack.mjs';

const app = new App();

const venueSlug = app.node.tryGetContext('venueSlug') ?? process.env.VENUE_SLUG ?? 'demo-venue';
const enabledPlatforms = (app.node.tryGetContext('enabledPlatforms') ?? process.env.ENABLED_PLATFORMS ?? 'turfpro')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const alertPhone = app.node.tryGetContext('alertPhone') ?? process.env.ALERT_PHONE ?? null;

new SlotSyncStack(app, `SlotSync-${venueSlug}`, {
  venueSlug,
  enabledPlatforms,
  alertPhone,
  env: {
    region: process.env.CDK_DEFAULT_REGION ?? 'ap-south-1', // Mumbai — logins come from an Indian IP
    account: process.env.CDK_DEFAULT_ACCOUNT,
  },
});
