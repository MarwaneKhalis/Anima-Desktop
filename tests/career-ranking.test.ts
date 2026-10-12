import assert from "node:assert/strict";
import { test } from "node:test";
import type { CareerProfile, JobOffer } from "../src/shared/career.ts";
import { profileFitScore, rankJobsForProfile } from "../src/shared/career-ranking.ts";

const profile: CareerProfile = {
  firstName: "Ada", lastName: "Lovelace", email: "ada@example.test", phone: "", city: "Lyon", country: "France", address: "", postalCode: "",
  headline: "", summary: "", linkedinUrl: "", websiteUrl: "", skills: ["TypeScript", "React"], languages: [], experiences: [], education: [],
  preferences: { titles: ["Développeuse logiciel"], locations: [], remote: false, contract: "" }, answers: {}, updatedAt: "",
};
const job = (id: string, title: string, location: string, description = ""): JobOffer => ({
  id, title, location, description, company: "Example", url: `https://example.test/${id}`, sourceUrl: "", discoveredAt: "", updatedAt: "",
});

test("profile ranking prioritizes title, skill and location overlap with stable ties", () => {
  const exact = job("exact", "Développeuse logiciel", "Lyon", "TypeScript React");
  const partial = job("partial", "Développeuse backend", "Paris", "TypeScript");
  const unrelated = job("unrelated", "Comptable", "Marseille");
  assert.equal(profileFitScore(exact, profile), 100);
  assert.deepEqual(rankJobsForProfile([unrelated, partial, exact], profile).map(item => item.id), ["exact", "partial", "unrelated"]);
  const tied = [job("first", "Comptable", "Marseille"), job("second", "Auditeur", "Nice")];
  assert.deepEqual(rankJobsForProfile(tied, profile).map(item => item.id), ["first", "second"]);
});

test("profile ranking stays unavailable when the profile contains no matching signals", () => {
  const emptyProfile = { ...profile, city: "", skills: [], preferences: { ...profile.preferences, titles: [], locations: [] } };
  assert.equal(profileFitScore(job("one", "Engineer", "Paris"), emptyProfile), null);
});

test("short programming language names remain usable ranking signals", () => {
  const cppProfile = { ...profile, skills: ["C++"], preferences: { ...profile.preferences, titles: [], locations: [] }, city: "" };
  assert.equal(profileFitScore(job("cpp", "Systems Developer", "Remote", "C++ experience required"), cppProfile), 100);
});
