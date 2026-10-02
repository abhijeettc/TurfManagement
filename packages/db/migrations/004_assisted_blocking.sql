-- Phase 3 pivot: assisted blocking, not automated dashboard writes.
--
-- 06-Multi-Platform-Channel-Sync.md (the channel-sync research the build plan
-- is drawn from) rules out RPA against partner dashboards for v1: Playo's
-- terms require written consent for automated access, Hudle's ban automation
-- "to build a competitive product" — which this is — and most owners have no
-- desktop to run the safer owner-side agent on anyway. The worker no longer
-- calls a platform adapter to block or unblock a slot; it creates a tracked
-- task for a human to do it in the partner app, with an SLA and escalation.
--
-- The block_state_t lifecycle is unchanged. 'submitted' now means "task is
-- visible to staff, awaiting their tap" rather than "sent to the platform,
-- awaiting verification"; 'verified' now means a human confirmed it, not an
-- automated re-fetch. Unblocking a verified job no longer flips it straight
-- to 'superseded' — it opens a second assisted task first (unblock_requested_at),
-- since releasing the slot in the partner app is just as manual as blocking it.

alter table block_jobs
  add column if not exists due_by timestamptz,
  add column if not exists escalated_at timestamptz,
  add column if not exists unblock_requested_at timestamptz,
  add column if not exists unblock_due_by timestamptz,
  add column if not exists unblock_escalated_at timestamptz,
  add column if not exists completed_by text;
