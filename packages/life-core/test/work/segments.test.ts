// Portions adapted from Noblot (c) 2026 Naman Jain. See THIRD_PARTY_NOTICES.md (jantar-secrets-allow: the licensor, as in LICENSE)
import { describe, expect, it } from "vitest";
import { describeClientList, matchesClientList, starterClientLists, type ListClient } from "../../src/work/segments.js";

const NOW = new Date("2026-07-27T00:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const client = (over: Partial<ListClient> = {}): ListClient => ({ state: "client", kind: "person", tags: [], emails: ["riya@acme.example"], createdAt: ago(100), lastTouchAt: ago(1), openDealStages: [], ...over });
const on = (c: ListClient, f: Parameters<typeof matchesClientList>[1]) => matchesClientList(c, f, NOW);

describe("matchesClientList", () => {
  it("an empty list holds everyone; a state narrows to it", () => {
    expect(on(client({ state: "past" }), {})).toBe(true);
    expect(on(client({ state: "lead" }), { state: "lead" })).toBe(true);
    expect(on(client({ state: "client" }), { state: "lead" })).toBe(false);
  });

  it("normalizes tags and AND-s them; an exclusion never beats the same include", () => {
    const c = client({ tags: ["vip", "retail"] });
    expect(on(c, { tags: [" VIP ", "retail"] })).toBe(true);
    expect(on(c, { tags: ["vip", "design"] })).toBe(false);
    expect(on(c, { excludeTags: ["retail"] })).toBe(false);
    expect(on(c, { tags: ["vip"], excludeTags: ["vip"] })).toBe(true);
    expect(on(c, { tags: [] })).toBe(true);
  });

  it('cadence "due" needs a cadence AND no touch in its days (never a past client)', () => {
    expect(on(client({ checkInDays: 30, lastTouchAt: ago(31) }), { cadence: "due" })).toBe(true);
    expect(on(client({ checkInDays: 30, lastTouchAt: ago(5) }), { cadence: "due" })).toBe(false);
    expect(on(client({ lastTouchAt: ago(400) }), { cadence: "due" })).toBe(false);
    expect(on(client({ checkInDays: 30, lastTouchAt: ago(31), state: "past" }), { cadence: "due" })).toBe(false);
    // Never touched: counted from when it was added.
    expect(on(client({ checkInDays: 30, lastTouchAt: undefined, createdAt: ago(45) }), { cadence: "due" })).toBe(true);
  });

  it('cadence "ok" is the exact complement of "due" within cadenced clients; "none" means no cadence', () => {
    for (const c of [client({ checkInDays: 30, lastTouchAt: ago(31) }), client({ checkInDays: 30, lastTouchAt: ago(5) })]) {
      expect(on(c, { cadence: "ok" })).toBe(!on(c, { cadence: "due" }));
    }
    expect(on(client(), { cadence: "none" })).toBe(true);
    expect(on(client({ checkInDays: 7 }), { cadence: "none" })).toBe(false);
  });

  it("quiet and active windows bound the last touch", () => {
    const c = client({ lastTouchAt: ago(20) });
    expect(on(c, { quietDays: 14 })).toBe(true);
    expect(on(c, { quietDays: 30 })).toBe(false);
    expect(on(c, { activeWithinDays: 30 })).toBe(true);
    expect(on(c, { activeWithinDays: 10 })).toBe(false);
    expect(on(client({ lastTouchAt: undefined }), { activeWithinDays: 30 })).toBe(false);
  });

  it("hasOpenDeal false is the negation, not just no deal; a stage needs an open deal on it", () => {
    expect(on(client({ openDealStages: ["proposal"] }), { hasOpenDeal: true })).toBe(true);
    expect(on(client({ openDealStages: [] }), { hasOpenDeal: false })).toBe(true);
    expect(on(client({ openDealStages: ["proposal"] }), { hasOpenDeal: false })).toBe(false);
    expect(on(client({ openDealStages: ["new", "proposal"] }), { stageId: "proposal" })).toBe(true);
    expect(on(client({ openDealStages: ["new"] }), { stageId: "proposal" })).toBe(false);
  });

  it("matches a source any case but WHOLE — a dot is not a wildcard", () => {
    expect(on(client({ source: "Referral" }), { source: "referral" })).toBe(true);
    expect(on(client({ source: "Referral partner" }), { source: "referral" })).toBe(false);
    expect(on(client({ source: "axb" }), { source: "a.b" })).toBe(false);
  });

  it("hasEmail in both directions; everything AND-ed", () => {
    expect(on(client({ emails: [] }), { hasEmail: false })).toBe(true);
    expect(on(client(), { hasEmail: false })).toBe(false);
    expect(on(client({ state: "lead", tags: ["vip"], emails: [] }), { state: "lead", tags: ["vip"], hasEmail: false })).toBe(true);
    expect(on(client({ state: "lead", tags: ["vip"] }), { state: "lead", tags: ["vip"], hasEmail: false })).toBe(false);
  });
});

describe("describeClientList", () => {
  it("says 'All clients' for an empty definition", () => {
    expect(describeClientList({})).toBe("All clients");
  });

  it("joins each active clause", () => {
    expect(describeClientList({ state: "lead", tags: ["vip"], cadence: "due", quietDays: 30 })).toBe("Leads · tagged vip · check-in due · quiet 30d+");
  });

  it("names excluded tags", () => {
    expect(describeClientList({ excludeTags: ["cold"] })).toBe("not tagged cold");
  });

  it("names the stage when the names are supplied, else its raw id", () => {
    expect(describeClientList({ stageId: "s2" }, { s2: "Proposal" })).toBe("at Proposal");
    expect(describeClientList({ stageId: "s2" })).toBe("at s2");
    expect(describeClientList({ source: "referral" })).toBe("from referral");
  });
});

describe("starterClientLists", () => {
  it("keeps 'Needs a check-in' first — it is the daily queue", () => {
    expect(starterClientLists()[0]!.name).toBe("Needs a check-in");
  });

  it("ships definitions the ONE predicate evaluates, each narrowing something, with unique ids", () => {
    const lists = starterClientLists();
    expect(new Set(lists.map((s) => s.id)).size).toBe(lists.length);
    const everyone = [client(), client({ state: "lead" }), client({ kind: "company", emails: [] })];
    for (const s of lists) {
      expect(describeClientList(s.filters)).not.toBe("All clients");
      expect(everyone.every((c) => on(c, s.filters)), s.id).toBe(false);
    }
  });
});
