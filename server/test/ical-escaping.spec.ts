import { describe, expect, it } from "vitest";
import { documentToICal, parseICalEvent } from "#api/caldav.ts";

function doc(properties: Record<string, unknown>, content = "") {
  return {
    id: "doc_1",
    slug: "slug",
    content,
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    properties,
  } as never;
}

describe("documentToICal", () => {
  it("escapes injected ICS structure in the title", () => {
    const ical = documentToICal(
      doc({
        title: "Meeting\nBEGIN:VALARM\nSUMMARY:Hijacked",
        eventStart: "2026-01-01T10:00:00.000Z",
      }),
    )!;
    expect(ical).toContain("SUMMARY:Meeting\\nBEGIN:VALARM\\nSUMMARY:Hijacked");
    expect(ical.split("\r\n")).not.toContain("BEGIN:VALARM");
  });

  it("escapes commas, semicolons and backslashes", () => {
    const ical = documentToICal(
      doc({ title: "a,b;c\\d", eventStart: "2026-01-01T10:00:00.000Z" }),
    )!;
    expect(ical).toContain("SUMMARY:a\\,b\\;c\\\\d");
  });

  it("folds long lines at 75 octets with a leading space", () => {
    const ical = documentToICal(
      doc({ title: "x".repeat(200), eventStart: "2026-01-01T10:00:00.000Z" }),
    )!;
    for (const line of ical.split("\r\n")) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    }
    expect(ical).toContain("\r\n x");
  });

  it("skips a document whose date property is unparseable", () => {
    expect(documentToICal(doc({ title: "t", eventStart: "Z" }))).toBeNull();
    expect(documentToICal(doc({ title: "t", eventStart: "5" }))).toBeNull();
  });

  it("falls back to a default end when eventEnd is unparseable", () => {
    const ical = documentToICal(
      doc({ title: "t", eventStart: "2026-01-01T00:00:00.000Z", eventEnd: "nope" }),
    )!;
    expect(ical).toContain("DTEND;VALUE=DATE:20260102");
  });
});

describe("parseICalEvent", () => {
  const wrap = (body: string) => `BEGIN:VEVENT\r\n${body}\r\nEND:VEVENT`;

  it("returns null for a malformed DTSTART", () => {
    expect(parseICalEvent(wrap("DTSTART:TZ\r\nSUMMARY:hi"))).toBeNull();
    expect(parseICalEvent(wrap("DTSTART;VALUE=DATE:TZ\r\nSUMMARY:hi"))).toBeNull();
    expect(
      parseICalEvent(wrap("DTSTART:20260101T000000Z\r\nDTEND:TZ\r\nSUMMARY:hi")),
    ).toBeNull();
  });

  it("still parses well-formed events", () => {
    expect(parseICalEvent(wrap("DTSTART:20260101T000000Z\r\nSUMMARY:hi"))).toEqual({
      summary: "hi",
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-01T00:00:00.000Z",
    });
    expect(parseICalEvent(wrap("DTSTART;VALUE=DATE:20260701\r\nSUMMARY:hi"))?.start).toBe(
      "2026-07-01T00:00:00.000Z",
    );
  });

  it("round-trips escaped text", () => {
    expect(
      parseICalEvent(wrap("DTSTART:20260101T000000Z\r\nSUMMARY:a\\,b\\nc"))?.summary,
    ).toBe("a,b\nc");
  });
});
