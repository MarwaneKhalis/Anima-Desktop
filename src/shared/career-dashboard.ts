import type { Application } from "./career.ts";
import type { Prospect } from "./types.ts";

const attentionPriority: Record<string, number> = {
  uncertain: 0,
  needs_input: 1,
  blocked: 2,
  failed: 3,
};

/** Surface the riskiest incomplete applications first in the daily restart view. */
export function prioritizeAttention(applications: readonly Application[]): Application[] {
  return applications
    .filter((application) => Object.hasOwn(attentionPriority, application.state))
    .slice()
    .sort((a, b) => attentionPriority[a.state] - attentionPriority[b.state] || b.updatedAt.localeCompare(a.updatedAt));
}

/** Return due follow-ups for open hiring outcomes, excluding already surfaced blockers. */
export function dueFollowups(applications: readonly Application[], now = new Date()): Application[] {
  const attentionIds = new Set(prioritizeAttention(applications).map((application) => application.id));
  return applications
    .filter((application) => {
      if (!application.nextActionAt || ["rejected", "withdrawn"].includes(application.outcome) || attentionIds.has(application.id)) return false;
      const scheduledAt = Date.parse(application.nextActionAt);
      return Number.isFinite(scheduledAt) && scheduledAt <= now.getTime();
    })
    .slice()
    .sort((a, b) => Date.parse(a.nextActionAt) - Date.parse(b.nextActionAt));
}


/** Return due contact reminders that still have an actionable next step. */
export function dueProspectFollowups(prospects: readonly Prospect[], now = new Date()): Prospect[] {
  return prospects.filter((p) => p.nextAction && p.nextActionAt && !["Sans suite", "À ne pas contacter"].includes(p.status) && Number.isFinite(Date.parse(p.nextActionAt)) && Date.parse(p.nextActionAt) <= now.getTime())
    .slice().sort((a, b) => Date.parse(a.nextActionAt) - Date.parse(b.nextActionAt) || `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`, "fr"));
}

/** Keep the home panel concise while making every hidden action discoverable. */
export function summarizeDailyActions<TCampaign, TAttention, TFollowup>(campaigns: readonly TCampaign[], attention: readonly TAttention[], followups: readonly TFollowup[], campaignCount = campaigns.length) {
  const visibleAttention = attention.slice(0, 3);
  return { campaignCount, hiddenCampaignCount: Math.max(0, campaignCount - campaigns.length), attentionCount: attention.length, followupCount: followups.length, visibleAttention, hiddenAttentionCount: attention.length - visibleAttention.length, totalCount: campaignCount + attention.length + followups.length };
}
