import { beforeAll, describe, expect, it } from "vitest";

/**
 * The attributes these elements read come out of stored document HTML, where
 * the sanitizer keeps a custom element's attributes verbatim — so each one is
 * an untrusted input, and none of them may reach markup or a navigation.
 */
beforeAll(async () => {
  await import("#editor/elements/document-attachment.ts");
  await import("#editor/elements/figma-embed.ts");
  await import("#editor/elements/file-attachment.ts");
});

function mount(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
  return host.firstElementChild as HTMLElement;
}

describe("document-attachment", () => {
  it("renders a table document as a label, not as its content", () => {
    const card = mount(
      `<document-attachment type="csv" status="loaded" content="<img src=x onerror=alert(1)>"></document-attachment>`,
    );
    const shadow = (card as HTMLElement & { shadow: ShadowRoot }).shadow;

    expect(shadow.querySelector("img")).toBeNull();
    expect(shadow.innerHTML).not.toContain("onerror");
    expect(shadow.textContent).toContain("Table document");
  });

  it("keeps document content off the shadow root of an unknown type too", () => {
    const card = mount(
      `<document-attachment type="mystery" status="loaded" content="<img src=x onerror=alert(1)>"></document-attachment>`,
    );
    const shadow = (card as HTMLElement & { shadow: ShadowRoot }).shadow;

    expect(shadow.querySelector("img")).toBeNull();
    expect(shadow.innerHTML).not.toContain("onerror");
  });
});

describe("figma-embed", () => {
  it("embeds a Figma file", () => {
    const embed = mount(
      `<figma-embed data-figma-url="https://www.figma.com/design/ABC/Test"></figma-embed>`,
    );
    const iframe = embed.shadowRoot?.querySelector("iframe");

    expect(iframe?.src).toContain("https://embed.figma.com/design/ABC/Test");
  });

  it("embeds nothing for a URL that is not Figma's", () => {
    for (const url of [
      "javascript:alert(1)",
      "https://evil.example/design/ABC",
      "https://figma.com.evil.example/design/ABC",
    ]) {
      const embed = mount(`<figma-embed data-figma-url="${url}"></figma-embed>`);
      expect(embed.shadowRoot?.querySelector("iframe")).toBeUndefined();
    }
  });
});

describe("file-attachment", () => {
  it("drops a src a browser would execute", () => {
    const card = mount(
      `<file-attachment src="javascript:alert(1)" filename="model.glb"></file-attachment>`,
    );
    const shadow = (card as HTMLElement & { shadow: ShadowRoot }).shadow;

    expect(shadow.innerHTML).not.toContain("javascript:");
    expect((card as HTMLElement & { safeSrc(): string }).safeSrc()).toBe("");
  });

  it("keeps the upload URL an attachment actually points at", () => {
    const card = mount(
      `<file-attachment src="/api/v1/spaces/s/uploads/ab/abc.glb" filename="model.glb"></file-attachment>`,
    );

    expect((card as HTMLElement & { safeSrc(): string }).safeSrc()).toBe(
      "/api/v1/spaces/s/uploads/ab/abc.glb",
    );
  });
});
