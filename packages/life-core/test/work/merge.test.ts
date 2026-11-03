// Portions adapted from Noblot (c) 2026 Naman Jain. See THIRD_PARTY_NOTICES.md (jantar-secrets-allow: the licensor, as in LICENSE)
import { describe, it, expect } from "vitest";
import { MERGE_FIELDS, contactMergeConflicts, planContactMerge, type MergeableContact } from "../../src/work/merge.js";

const base: MergeableContact = { name: "Riya", state: "lead", emails: [], phones: [], links: [], tags: [] };

describe("planContactMerge", () => {
  it("keeps the survivor's scalars and back-fills only the blanks from the loser", () => {
    const merged = planContactMerge(
      { ...base, name: "Riya Sharma", title: "Head of Ops" },
      { ...base, name: "R. Sharma", title: "Old title", city: "Bengaluru", source: "Referral" },
    );
    expect(merged.name).toBe("Riya Sharma");
    expect(merged.title).toBe("Head of Ops");
    expect(merged.city).toBe("Bengaluru");
    expect(merged.source).toBe("Referral");
  });

  it("unions emails/phones/tags, survivor first, deduped by normalized form", () => {
    const merged = planContactMerge(
      { ...base, emails: ["riya@acme.example"], phones: [{ value: "+91 98765 43210" }], tags: ["vip"] },
      { ...base, emails: ["RIYA@ACME.EXAMPLE", "old@acme.example"], phones: [{ value: "09876543210", label: "work" }], tags: ["VIP", "design"] },
    );
    expect(merged.emails).toEqual(["riya@acme.example", "old@acme.example"]);
    expect(merged.phones).toEqual([{ value: "+91 98765 43210" }]);
    expect(merged.tags).toEqual(["vip", "design"]);
  });

  it("unions links deduped by url", () => {
    const merged = planContactMerge({ ...base, links: ["https://acme.example"] }, { ...base, links: ["https://acme.example", "https://www.linkedin.com/in/riya-example"] });
    expect(merged.links).toEqual(["https://acme.example", "https://www.linkedin.com/in/riya-example"]);
  });

  it("never leaves the merged contact its own company, or ruled 'not a duplicate' of either party", () => {
    const merged = planContactMerge(
      { ...base, id: "a1", notDuplicateOf: ["a2", "a9"] },
      { ...base, id: "a2", companyId: "a1", notDuplicateOf: ["a1", "a8"] },
    );
    expect(merged.companyId).toBeUndefined();
    expect(merged.notDuplicateOf).toEqual(["a9", "a8"]);
  });

  it("takes the loser's check-in cadence only when the survivor has none", () => {
    expect(planContactMerge({ ...base, checkInDays: 30 }, { ...base, checkInDays: 90 }).checkInDays).toBe(30);
    expect(planContactMerge({ ...base }, { ...base, checkInDays: 90 }).checkInDays).toBe(90);
  });

  // Work's own rules.
  it("merges to the more active state: a client over a lead over past", () => {
    expect(planContactMerge({ ...base, state: "lead" }, { ...base, state: "client" }).state).toBe("client");
    expect(planContactMerge({ ...base, state: "past" }, { ...base, state: "lead" }).state).toBe("lead");
    expect(planContactMerge({ ...base, state: "past" }, { ...base, state: "past" }).state).toBe("past");
  });

  it("an imported loser's mark moves to a clean survivor; the survivor's own mark stays", () => {
    expect(planContactMerge({ ...base }, { ...base, from: "import" }).from).toBe("import");
    expect(planContactMerge({ ...base, from: "meeting" }, { ...base, from: "import" }).from).toBe("meeting");
    expect(planContactMerge({ ...base }, { ...base }).from).toBeUndefined();
  });
});

describe("contactMergeConflicts + the per-field picker", () => {
  it("reports only the scalars where BOTH sides hold a different value", () => {
    const conflicts = contactMergeConflicts(
      { ...base, name: "Riya Sharma", city: "Pune", checkInDays: 30 },
      { ...base, name: "R. Sharma", city: "Pune", title: "Design Lead", checkInDays: 90 },
    );
    expect(conflicts.map((c) => c.field)).toEqual(["name", "checkInDays"]);
    // A field only one side has is a back-fill, not a decision.
    expect(conflicts.some((c) => c.field === "title")).toBe(false);
    // …and identical values are not a disagreement.
    expect(conflicts.some((c) => c.field === "city")).toBe(false);
    expect(conflicts[1]).toMatchObject({ survivor: "every 30d", loser: "every 90d" });
  });

  it("hands the picked fields to the loser and leaves the rest survivor-wins", () => {
    const merged = planContactMerge({ ...base, name: "Riya Sharma", city: "Pune", notes: "Prefers calls" }, { ...base, name: "R. Sharma", city: "Mumbai", notes: "Prefers e-mail" }, ["city", "notes"]);
    expect(merged.name).toBe("Riya Sharma"); // not picked → survivor
    expect(merged.city).toBe("Mumbai");
    expect(merged.notes).toBe("Prefers e-mail");
  });

  it("a pick can never blank out a value the loser does not have", () => {
    const merged = planContactMerge({ ...base, name: "Riya Sharma", city: "Pune", checkInDays: 30 }, { ...base, name: "R. Sharma" }, ["city", "checkInDays", "folder"]);
    expect(merged.city).toBe("Pune");
    expect(merged.checkInDays).toBe(30);
    expect(merged.folder).toBeUndefined();
  });

  it("still unions the lists regardless of the picks", () => {
    const merged = planContactMerge({ ...base, emails: ["riya@acme.example"], tags: ["vip"] }, { ...base, emails: ["old@acme.example"], tags: ["design"] }, [...MERGE_FIELDS]);
    expect(merged.emails).toEqual(["riya@acme.example", "old@acme.example"]);
    expect(merged.tags).toEqual(["vip", "design"]);
  });
});
