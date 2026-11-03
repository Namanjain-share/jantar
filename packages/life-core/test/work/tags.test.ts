// Portions adapted from Noblot (c) 2026 Naman Jain. See THIRD_PARTY_NOTICES.md (jantar-secrets-allow: the licensor, as in LICENSE)
import { describe, it, expect } from "vitest";
import {
  TAG_PALETTE,
  defaultTagColor,
  normalizeTag,
  normalizeTags,
  planTagRename,
  tagTypeahead,
} from "../../src/work/tags.js";

describe("normalizeTag", () => {
  it("trims, collapses whitespace and lowercases (tags are canonical, case-insensitive)", () => {
    expect(normalizeTag("  VIP   Client ")).toBe("vip client");
  });

  it("caps length (30, Work's tag cap) and returns '' for blanks", () => {
    expect(normalizeTag("x".repeat(80))).toHaveLength(30);
    expect(normalizeTag("   ")).toBe("");
  });

  it("strips the comma so a comma-joined editor can never create one tag from two", () => {
    expect(normalizeTag("a,b")).toBe("ab");
  });

  it("strips . and $ (a tag stays one plain word group)", () => {
    expect(normalizeTag("node.js")).toBe("nodejs");
    expect(normalizeTag("$vip")).toBe("vip");
  });
});

describe("normalizeTags", () => {
  it("dedupes case-variants and drops blanks, preserving first-seen order", () => {
    expect(normalizeTags(["VIP", "  ", "referral", "vip", "Referral"])).toEqual(["vip", "referral"]);
  });
});

describe("defaultTagColor", () => {
  it("is deterministic and always inside the palette", () => {
    expect(defaultTagColor("vip")).toBe(defaultTagColor("vip"));
    for (const t of ["vip", "referral", "cold", "warm", "enterprise"]) {
      expect(TAG_PALETTE).toContain(defaultTagColor(t));
    }
  });

  it("spreads different tags across more than one palette entry", () => {
    const used = new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map(defaultTagColor));
    expect(used.size).toBeGreaterThan(1);
  });
});

describe("planTagRename", () => {
  it("reports a plain rename", () => {
    expect(planTagRename("vip", "VIP Client", ["vip", "cold"])).toEqual({
      ok: true,
      from: "vip",
      to: "vip client",
      merge: false,
    });
  });

  it("flags a MERGE when the target tag already exists among the tags already used", () => {
    expect(planTagRename("prospect", "Lead", ["prospect", "lead"])).toEqual({
      ok: true,
      from: "prospect",
      to: "lead",
      merge: true,
    });
  });

  it("rejects a no-op rename and a blank target", () => {
    expect(planTagRename("vip", " VIP ", ["vip"]).ok).toBe(false);
    expect(planTagRename("vip", "  ", ["vip"]).ok).toBe(false);
  });
});

describe("tagTypeahead", () => {
  const all = ["vip", "vip client", "referral", "cold"];

  it("prefix matches rank above substring matches", () => {
    expect(tagTypeahead(all, "vi", [])).toEqual(["vip", "vip client"]);
    expect(tagTypeahead(all, "ip", [])).toEqual(["vip", "vip client"]);
  });

  it("hides tags the contact already carries", () => {
    expect(tagTypeahead(all, "vi", ["vip"])).toEqual(["vip client"]);
  });

  it("returns everything unselected for an empty query, capped", () => {
    expect(tagTypeahead(all, "", ["cold"])).toEqual(["vip", "vip client", "referral"]);
    expect(tagTypeahead(Array.from({ length: 50 }, (_, i) => `t${i}`), "", [])).toHaveLength(12);
  });
});
