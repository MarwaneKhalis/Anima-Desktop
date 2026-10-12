import type { Application } from "./career.ts";

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
    .sort((a, b) => a.nextActionAt.localeCompare(b.nextActionAt));
}
