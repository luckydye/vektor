import { describe, expect, it } from "bun:test";
import { extractMentionsFromHtml, getUniqueMentionedEmails } from "../src/db/mentions.ts";

describe("Mention extraction", () => {
  it("extracts mentions from HTML with user-mention elements", () => {
    const html = `
      <p>Hey <user-mention email="john@example.com">@John Doe</user-mention>, can you review this?</p>
    `;

    const mentions = extractMentionsFromHtml(html);

    expect(mentions).toHaveLength(1);
    expect(mentions[0].email).toBe("john@example.com");
    expect(mentions[0].label).toBe("John Doe");
  });

  it("extracts multiple mentions from HTML", () => {
    const html = `
      <p>Hey <user-mention email="john@example.com">@John Doe</user-mention> and 
      <user-mention email="jane@example.com">@Jane Smith</user-mention>, 
      let's discuss this with <user-mention email="bob@example.com">@Bob</user-mention>.</p>
    `;

    const mentions = extractMentionsFromHtml(html);

    expect(mentions).toHaveLength(3);
    expect(mentions[0].email).toBe("john@example.com");
    expect(mentions[1].email).toBe("jane@example.com");
    expect(mentions[2].email).toBe("bob@example.com");
  });

  it("extracts mentions from nested HTML structures", () => {
    const html = `
      <div>
        <h1>Document Title</h1>
        <div>
          <p>Content with <user-mention email="alice@example.com">@Alice</user-mention></p>
          <ul>
            <li>Item with <user-mention email="bob@example.com">@Bob</user-mention></li>
          </ul>
        </div>
      </div>
    `;

    const mentions = extractMentionsFromHtml(html);

    expect(mentions).toHaveLength(2);
    expect(mentions[0].email).toBe("alice@example.com");
    expect(mentions[1].email).toBe("bob@example.com");
  });

  it("handles mentions without labels", () => {
    const html = `
      <p><user-mention email="test@example.com"></user-mention></p>
    `;

    const mentions = extractMentionsFromHtml(html);

    expect(mentions).toHaveLength(1);
    expect(mentions[0].email).toBe("test@example.com");
    expect(mentions[0].label).toBeUndefined();
  });

  it("handles mentions with @ prefix in label", () => {
    const html = `
      <p><user-mention email="test@example.com">@TestUser</user-mention></p>
    `;

    const mentions = extractMentionsFromHtml(html);

    expect(mentions).toHaveLength(1);
    expect(mentions[0].label).toBe("TestUser");
  });

  it("returns empty array for HTML without mentions", () => {
    const html = `
      <div>
        <h1>Just a regular document</h1>
        <p>No mentions here!</p>
      </div>
    `;

    const mentions = extractMentionsFromHtml(html);

    expect(mentions).toHaveLength(0);
  });

  it("handles malformed HTML gracefully", () => {
    const html = `
      <p>Some text <user-mention>Missing email</user-mention></p>
    `;

    const mentions = extractMentionsFromHtml(html);

    expect(mentions).toHaveLength(0);
  });

  it("extracts unique emails from HTML", () => {
    const html = `
      <p><user-mention email="john@example.com">@John</user-mention> and 
      <user-mention email="jane@example.com">@Jane</user-mention> and 
      <user-mention email="john@example.com">@John again</user-mention></p>
    `;

    const emails = getUniqueMentionedEmails(html);

    expect(emails).toHaveLength(2);
    expect(emails).toContain("john@example.com");
    expect(emails).toContain("jane@example.com");
  });

  it("handles complex TipTap editor output", () => {
    const html = `
      <h1>Meeting Notes</h1>
      <p>Attendees:</p>
      <ul>
        <li><user-mention email="alice@company.com">@Alice Johnson</user-mention> - Product Manager</li>
        <li><user-mention email="bob@company.com">@Bob Smith</user-mention> - Engineer</li>
      </ul>
      <p>Action items for <user-mention email="alice@company.com">@Alice Johnson</user-mention>:</p>
      <ol>
        <li>Review specs with <user-mention email="charlie@company.com">@Charlie</user-mention></li>
        <li>Update roadmap</li>
      </ol>
    `;

    const mentions = extractMentionsFromHtml(html);
    const emails = getUniqueMentionedEmails(html);

    expect(mentions).toHaveLength(4);
    expect(emails).toHaveLength(3);
    expect(emails).toContain("alice@company.com");
    expect(emails).toContain("bob@company.com");
    expect(emails).toContain("charlie@company.com");
  });

  it("handles empty or invalid HTML", () => {
    expect(extractMentionsFromHtml("")).toHaveLength(0);
    expect(extractMentionsFromHtml("<>")).toHaveLength(0);
    expect(getUniqueMentionedEmails("")).toHaveLength(0);
  });
});
