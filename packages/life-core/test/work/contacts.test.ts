// Portions adapted from Noblot (c) 2026 Naman Jain. See THIRD_PARTY_NOTICES.md (jantar-secrets-allow: the licensor, as in LICENSE)
import { describe, it, expect } from "vitest";
import {
  contactAvatarColor,
  contactInitials,
  countsAsTouch,
  duplicatePairKey,
  findDuplicateGroups,
  formatLogLine,
  lastTouchAt,
  normalizeContactEmail,
  normalizeContactLink,
  normalizeContactName,
  normalizeContactPhone,
  parseVCard,
  toVCard,
} from "../../src/work/contacts.js";

describe("normalizers", () => {
  it("folds case, accents, punctuation and honorifics out of a name", () => {
    expect(normalizeContactName("  Dr. Riya   Sharma ")).toBe("riya sharma");
    expect(normalizeContactName("José Álvarez")).toBe("jose alvarez");
    expect(normalizeContactName("O'Brien-Smith")).toBe("obrien smith");
    expect(normalizeContactName("   ")).toBe("");
  });

  it("keeps a name in any script, so two different non-Latin names never fold to one key", () => {
    // Made-up companies. Before: everything outside a-z0-9 folded to "", so all of these were one name.
    expect(normalizeContactName("डेल्टा ट्रेडर्स")).toBe("डेल्टा ट्रेडर्स");
    expect(normalizeContactName("ग्लोबल सॉल्यूशंस")).not.toBe(normalizeContactName("डेल्टा ट्रेडर्स"));
    expect(normalizeContactName("山田商事")).toBe("山田商事");
    expect(normalizeContactName("  Мир-Стандарт ")).toBe("мир стандарт");
    expect(normalizeContactName("Δέλτα")).toBe(normalizeContactName("δελτα"));
    expect(normalizeContactName("Shri  डेल्टा")).toBe("डेल्टा");
    // A name of symbols alone has no identity: "" (callers never match on it).
    expect(normalizeContactName("★")).toBe("");
    expect(normalizeContactName("— & —")).toBe("");
  });

  it("compares phones on their last 10 digits so +91 and 0 prefixes match", () => {
    expect(normalizeContactPhone("+91 98765-43210")).toBe("9876543210");
    expect(normalizeContactPhone("098765 43210")).toBe("9876543210");
    expect(normalizeContactPhone("12345")).toBe(""); // too short to be an identity
  });

  // v0.13 Work: the 10-digit rule against short foreign numbers and long ones.
  it("keeps every digit of a 7- to 9-digit number, and the last 10 of a longer one", () => {
    expect(normalizeContactPhone("555-1234")).toBe("5551234");
    expect(normalizeContactPhone("+65 6123 4567")).toBe("6561234567");
    expect(normalizeContactPhone("6123 4567")).toBe("61234567");
    expect(normalizeContactPhone("+44 20 7946 0958")).toBe("2079460958");
    expect(normalizeContactPhone("020 7946 0958")).toBe("2079460958");
    // Two different short numbers never collapse into one identity.
    expect(normalizeContactPhone("6123 4567")).not.toBe(normalizeContactPhone("6123 4568"));
  });

  it("lowercases and trims emails", () => {
    expect(normalizeContactEmail(" Riya@Example.COM ")).toBe("riya@example.com");
  });
});

describe("normalizeContactLink", () => {
  it("adds the missing scheme and infers the type from the host", () => {
    expect(normalizeContactLink({ url: "linkedin.com/in/riya" })).toEqual({
      type: "linkedin",
      url: "https://linkedin.com/in/riya",
    });
    expect(normalizeContactLink({ url: "https://www.instagram.com/riya" })?.type).toBe("instagram");
    expect(normalizeContactLink({ url: "x.com/riya" })?.type).toBe("twitter");
    expect(normalizeContactLink({ url: "twitter.com/riya" })?.type).toBe("twitter");
    expect(normalizeContactLink({ url: "acme.test" })?.type).toBe("website");
  });

  it("keeps an explicit type and label, and rejects junk", () => {
    expect(normalizeContactLink({ url: "linkedin.com/in/riya", type: "other", label: "Work" })).toEqual({
      type: "other",
      url: "https://linkedin.com/in/riya",
      label: "Work",
    });
    expect(normalizeContactLink({ url: "   " })).toBeNull();
    expect(normalizeContactLink({ url: "not a url at all" })).toBeNull();
  });

  // v0.13 Work keeps https links only.
  it("stores an http link as https", () => {
    expect(normalizeContactLink({ url: "http://acme.test/about" })?.url).toBe("https://acme.test/about");
  });
});

describe("contactInitials / contactAvatarColor", () => {
  it("takes first + last initial, uppercased", () => {
    expect(contactInitials("Riya Sharma")).toBe("RS");
    expect(contactInitials("Riya Kumari Sharma")).toBe("RS");
    expect(contactInitials("Nimbus")).toBe("NI");
    expect(contactInitials("é")).toBe("E");
    expect(contactInitials("   ")).toBe("?");
    expect(contactInitials("★")).toBe("?");
    expect(contactInitials("山田商事")).toBe("山田");
    expect(contactInitials("डेल्टा ट्रेडर्स")).toBe("डट");
    expect(contactInitials("𠀋𠀌 Ltd")).toBe("𠀋L");
  });

  it("is deterministic and case/whitespace-insensitive", () => {
    expect(contactAvatarColor("Riya Sharma")).toBe(contactAvatarColor("  riya   sharma "));
    expect(contactAvatarColor("Riya Sharma")).toBe(contactAvatarColor("Riya Sharma"));
  });
});

describe("findDuplicateGroups", () => {
  const c = (id: string, name: string, emails: string[] = [], phones: string[] = []) => ({
    id,
    name,
    emails,
    phones,
  });

  it("groups on a shared email regardless of case", () => {
    const groups = findDuplicateGroups([
      c("a", "Riya Sharma", ["riya@acme.test"]),
      c("b", "R. Sharma", ["RIYA@acme.test"]),
      c("d", "Someone Else", ["else@x.example"]),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.contactIds.sort()).toEqual(["a", "b"]);
    expect(groups[0]!.reasons).toEqual(["email"]);
  });

  it("groups on a shared phone written differently", () => {
    const groups = findDuplicateGroups([
      c("a", "Riya", [], ["+91 98765 43210"]),
      c("b", "Riya S", [], ["09876543210"]),
    ]);
    expect(groups[0]!.reasons).toEqual(["phone"]);
  });

  it("groups on a normalized name", () => {
    const groups = findDuplicateGroups([c("a", "Dr. Riya Sharma"), c("b", "riya sharma")]);
    expect(groups[0]!.reasons).toEqual(["name"]);
  });

  it("collects EVERY matching reason on one group", () => {
    const groups = findDuplicateGroups([
      c("a", "Riya Sharma", ["riya@x.example"], ["9876543210"]),
      c("b", "Riya Sharma", ["riya@x.example"], ["9876543210"]),
    ]);
    expect(groups[0]!.reasons).toEqual(["email", "name", "phone"]);
  });

  it("transitively unions a chain (a~b by email, b~c by phone) into ONE group", () => {
    const groups = findDuplicateGroups([
      c("a", "Riya", ["riya@x.example"]),
      c("b", "R S", ["riya@x.example"], ["9876543210"]),
      c("c", "Sharma", [], ["9876543210"]),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.contactIds.sort()).toEqual(["a", "b", "c"]);
  });

  it("returns nothing when there is nothing in common", () => {
    expect(findDuplicateGroups([c("a", "Riya", ["r@x.example"]), c("b", "Arjun", ["a@x.example"])])).toEqual([]);
  });

  it("ignores blank names/emails/phones instead of grouping every empty record together", () => {
    expect(findDuplicateGroups([c("a", "  ", [""], ["12"]), c("b", " ", [" "], ["34"])])).toEqual([]);
  });

  it("sorts the biggest group first", () => {
    const groups = findDuplicateGroups([
      c("a", "Riya"),
      c("b", "Riya"),
      c("c", "Riya"),
      c("x", "Arjun"),
      c("y", "Arjun"),
    ]);
    expect(groups[0]!.contactIds).toHaveLength(3);
  });
});

describe("formatLogLine", () => {
  it("names the direction and the channel", () => {
    expect(formatLogLine({ kind: "call", direction: "in" })).toBe("Inbound call");
    expect(formatLogLine({ kind: "meeting", direction: "out" })).toBe("Outbound meeting");
  });

  it("appends a duration only when one was logged", () => {
    expect(formatLogLine({ kind: "call", direction: "out", minutes: 12 })).toBe("Outbound call · 12m");
    expect(formatLogLine({ kind: "email", direction: "out" })).toBe("Outbound email");
  });

  it("renders an hour-plus duration in h/m, dropping a zero minute part", () => {
    expect(formatLogLine({ kind: "meeting", direction: "in", minutes: 90 })).toBe("Inbound meeting · 1h 30m");
    expect(formatLogLine({ kind: "meeting", direction: "in", minutes: 120 })).toBe("Inbound meeting · 2h");
  });

  it("keeps a zero-minute log distinguishable from an unlogged duration", () => {
    expect(formatLogLine({ kind: "call", direction: "in", minutes: 0 })).toBe("Inbound call · 0m");
  });

  // v0.13 Work: a row with no direction (a note), and the outcome.
  it("reads a note as itself, and adds the outcome", () => {
    expect(formatLogLine({ kind: "note" })).toBe("Note");
    expect(formatLogLine({ kind: "call", direction: "out", minutes: 25, outcome: "good" })).toBe("Outbound call · 25m · Went well");
    expect(formatLogLine({ kind: "call", outcome: "no_answer" })).toBe("Call · No answer");
  });
});

describe("touches (v0.13 Work)", () => {
  it("counts what he did with the client, never a stage move or the created row", () => {
    for (const k of ["call", "meeting", "email", "message", "note"]) expect(countsAsTouch(k), k).toBe(true);
    for (const k of ["stage", "created", "edit"]) expect(countsAsTouch(k), k).toBe(false);
  });

  it("finds the newest touch, skipping rows that are not touches", () => {
    expect(
      lastTouchAt([
        { kind: "call", at: "2026-10-01T10:00:00.000Z" },
        { kind: "stage", at: "2026-10-09T10:00:00.000Z" },
        { kind: "note", at: "2026-10-05T10:00:00.000Z" },
      ]),
    ).toBe("2026-10-05T10:00:00.000Z");
    expect(lastTouchAt([{ kind: "created", at: "2026-10-01T10:00:00.000Z" }])).toBeNull();
  });
});

describe("findDuplicateGroups — dismissed pairs", () => {
  const c = (id: string, name: string, emails: string[] = [], phones: string[] = []) => ({
    id,
    name,
    emails,
    phones,
  });

  it("hides a two-record group once the pair has been ruled 'not a duplicate'", () => {
    const contacts = [c("a", "Riya Sharma"), c("b", "riya sharma")];
    expect(findDuplicateGroups(contacts)).toHaveLength(1);
    expect(findDuplicateGroups(contacts, new Set([duplicatePairKey("b", "a")]))).toEqual([]);
  });

  it("keeps a bigger group while ANY pair inside it is still undecided", () => {
    const contacts = [c("a", "Riya"), c("b", "riya"), c("c", "RIYA")];
    const groups = findDuplicateGroups(contacts, new Set([duplicatePairKey("a", "b")]));
    expect(groups).toHaveLength(1);
    expect(groups[0]!.contactIds.sort()).toEqual(["a", "b", "c"]);
  });

  it("keys a pair the same whichever way round it is asked", () => {
    expect(duplicatePairKey("b", "a")).toBe(duplicatePairKey("a", "b"));
  });
});

describe("vCard", () => {
  it("round-trips a contact through toVCard/parseVCard", () => {
    const [back] = parseVCard(
      toVCard([
        {
          name: "Riya Sharma",
          emails: ["riya@acme.test", "riya@personal.test"],
          phones: ["+91 98765 43210"],
          company: "Acme",
          title: "Founder",
          address: "12 Example Road, Springfield",
          urls: ["https://acme.test"],
        },
      ]),
    );
    expect(back).toEqual({
      name: "Riya Sharma",
      emails: ["riya@acme.test", "riya@personal.test"],
      phones: ["+91 98765 43210"],
      urls: ["https://acme.test"],
      company: "Acme",
      title: "Founder",
      address: "12 Example Road, Springfield",
    });
  });

  it("escapes the structural characters so a comma in a field can't split it", () => {
    const vcf = toVCard([{ name: "Sharma, Riya", company: "A; B" }]);
    expect(vcf).toContain("FN:Sharma\\, Riya");
    expect(parseVCard(vcf)[0]!.name).toBe("Sharma, Riya");
    expect(parseVCard(vcf)[0]!.company).toBe("A; B");
  });

  it("unfolds continuation lines rather than truncating the value", () => {
    // The fold falls INSIDE the values that survive parsing — folding a NOTE (which is
    // dropped anyway) would pass whether or not unfolding works.
    const parsed = parseVCard(
      [
        "BEGIN:VCARD",
        "VERSION:3.0",
        "FN:Riya Shar",
        " ma",
        "EMAIL:riya@ac",
        "\tme.test",
        "END:VCARD",
      ].join("\r\n"),
    );
    expect(parsed[0]!.name).toBe("Riya Sharma");
    expect(parsed[0]!.emails).toEqual(["riya@acme.test"]);
  });

  it("falls back to N when a card carries no FN, reading it as 'given family'", () => {
    const parsed = parseVCard(
      ["BEGIN:VCARD", "VERSION:2.1", "N:Sharma;Riya;;;", "TEL;CELL:9876543210", "END:VCARD"].join("\n"),
    );
    expect(parsed[0]!.name).toBe("Riya Sharma");
    expect(parsed[0]!.phones).toEqual(["9876543210"]);
  });

  it("drops a nameless card instead of importing a blank contact", () => {
    expect(parseVCard("BEGIN:VCARD\r\nVERSION:3.0\r\nEMAIL:x@y.example\r\nEND:VCARD")).toEqual([]);
  });

  it("reads grouped 4.0 properties (item1.EMAIL) and joins a multi-part ADR", () => {
    const parsed = parseVCard(
      [
        "BEGIN:VCARD",
        "VERSION:4.0",
        "FN:Arjun",
        "item1.EMAIL;TYPE=work:arjun@x.example",
        "ADR;TYPE=home:;;221B Baker St;London;;NW1;UK",
        "END:VCARD",
      ].join("\r\n"),
    );
    expect(parsed[0]!.emails).toEqual(["arjun@x.example"]);
    expect(parsed[0]!.address).toBe("221B Baker St, London, NW1, UK");
  });

  // v0.13 Work: a photo is never read.
  it("skips a PHOTO property", () => {
    const parsed = parseVCard(["BEGIN:VCARD", "VERSION:3.0", "FN:Arjun", "PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRg", "END:VCARD"].join("\r\n"));
    expect(parsed).toEqual([{ name: "Arjun" }]);
  });

  it("emits nothing at all for an empty book", () => {
    expect(toVCard([])).toBe("");
  });
});
