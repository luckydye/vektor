import { render } from "solid-js/web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Renders the real `WorkflowView` against a poisoned `result.json` and asserts on
 * the DOM: no handler attribute, no executable element, no scheme-bearing URL,
 * while the prose around the payload survives so the channel still works.
 */

const RESULT_URL = "/uploads/artifacts/workflow/run_1/result.json";

const XSS_HTML = [
  "<p>Quarterly report</p>",
  '<img src=x onerror="globalThis.__wfxss = (globalThis.__wfxss ?? 0) + 1">',
  '<svg onload="globalThis.__wfxss = (globalThis.__wfxss ?? 0) + 1"><circle r="4" /></svg>',
  "<script>globalThis.__wfxss = (globalThis.__wfxss ?? 0) + 1;</script>",
  '<iframe src="javascript:globalThis.__wfxss = 1"></iframe>',
  '<a href="javascript:globalThis.__wfxss = 1">payout</a>',
  '<a href="&#106;avascript:globalThis.__wfxss = 1">encoded payout</a>',
  '<img src="javascript:globalThis.__wfxss = 1">',
  '<div onclick="globalThis.__wfxss = 1">clickme</div>',
  '<img/onerror="globalThis.__wfxss = 1" src=x>',
  "<table><tr><td>7</td></tr></table>",
  '<a href="https://example.com/report">source</a>',
].join("\n");

let runResult: Record<string, unknown> = {};
let runtimeInputs: Record<string, unknown> = {};

vi.mock("@solidjs/router", () => ({
  useLocation: () => ({ pathname: "/w/doc_1", search: "" }),
  useNavigate: () => () => {},
}));

vi.mock("#composeables/useSpace.ts", () => ({
  useSpace: () => ({
    currentSpaceId: () => "space_1",
    currentSpace: () => ({ id: "space_1", slug: "first", userRole: "owner" }),
  }),
}));

vi.mock("#api/client.ts", () => ({
  api: {
    subscribeToTopics: () => () => {},
    workflows: {
      listRuns: async () => ({
        runs: [
          {
            runId: "run_1",
            documentId: "doc_1",
            status: "completed",
            createdAt: "2026-01-01T00:00:00.000Z",
            sourceExtensionId: null,
            runtimeInputs,
          },
        ],
        nextCursor: null,
      }),
      getRun: async () => ({
        runId: "run_1",
        documentId: "doc_1",
        status: "completed",
        createdAt: "2026-01-01T00:00:00.000Z",
        sourceExtensionId: null,
        runtimeInputs,
        logs: [],
        error: null,
        resultArtifact: { url: RESULT_URL },
      }),
    },
    document: { get: async () => ({ slug: "out", properties: {} }) },
    extensions: { getById: async () => ({ routes: [] }) },
  },
}));

const { QueryClient, setFallbackQueryClient } = await import("#composeables/query.ts");
const { WorkflowView } = await import("#components/WorkflowView.tsx");

let dispose: (() => void) | undefined;
let host: HTMLElement | undefined;

beforeEach(() => {
  runResult = {};
  runtimeInputs = {};
  setFallbackQueryClient(new QueryClient());
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : String((input as Request).url ?? "");
    const body = url.includes("result.json") ? runResult : {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  dispose?.();
  host?.remove();
  dispose = undefined;
  host = undefined;
  delete (globalThis as Record<string, unknown>).__wfxss;
});

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  dispose = render(() => <WorkflowView documentId="doc_1" spaceId="space_1" />, host);
  // List query, run detail and artifact fetch each resolve on their own tick.
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * The container the result `html` is injected into, or `null` when it sanitized
 * away entirely. Scoped, because the app chrome has `<svg>` icons and links of
 * its own that an assertion over the whole render would trip on.
 */
function outputContainer(): HTMLElement | null {
  return host?.querySelector<HTMLElement>("div.p-2") ?? null;
}

/** Every attribute in a subtree, as `[tag, name, value]`. */
function attributesIn(root: ParentNode): Array<[string, string, string]> {
  return [...root.querySelectorAll("*")].flatMap((element) =>
    [...element.attributes].map((attribute): [string, string, string] => [
      element.tagName.toLowerCase(),
      attribute.name.toLowerCase(),
      attribute.value,
    ]),
  );
}

function tagNamesIn(root: ParentNode): string[] {
  return [...root.querySelectorAll("*")].map((element) => element.tagName.toLowerCase());
}

const EXECUTABLE_SCHEME = /^\s*(?:javascript|vbscript|data):/i;
const URL_ATTRIBUTES = ["href", "src", "xlink:href", "srcdoc", "action", "formaction"];

/** No URL anywhere in the panel may name a scheme that executes on click. */
function expectNoExecutableUrls() {
  if (!host) throw new Error("not mounted");
  for (const [tag, name, value] of attributesIn(host)) {
    if (!URL_ATTRIBUTES.includes(name)) continue;
    expect(
      EXECUTABLE_SCHEME.test(value.replace(/&#?\w+;/g, "")),
      `<${tag} ${name}="${value}"> should not name an executable scheme`,
    ).toBe(false);
  }

  // happy-dom runs no scripts, so this states intent; the DOM checks are the proof.
  expect((globalThis as Record<string, unknown>).__wfxss).toBeUndefined();
}

/**
 * The invariants the injected result markup has to satisfy however the payload
 * got in: nothing that runs on an event, nothing that executes or loads a
 * document, and no URL naming a scheme the sanitizer does not underwrite.
 */
function expectInertResult() {
  expectNoExecutableUrls();

  const output = outputContainer();
  if (!output) return;

  const attributes = attributesIn(output);
  expect(attributes.filter(([, name]) => name.startsWith("on"))).toEqual([]);
  // `<img/onerror=…>`: a browser reads this as a handler, the parser as an
  // attribute literally named `/onerror`.
  expect(attributes.filter(([, name]) => name.includes("/"))).toEqual([]);

  for (const tag of ["script", "iframe", "svg", "object", "embed", "style", "form"]) {
    expect(tagNamesIn(output)).not.toContain(tag);
  }
}

describe("workflow run result html", () => {
  it("renders the payload class from the audit inert", async () => {
    runResult = { html: XSS_HTML };
    await mount();

    expectInertResult();
  });

  it("keeps the prose, tables and safe links around the payload", async () => {
    runResult = { html: XSS_HTML };
    await mount();

    const output = outputContainer();
    expect(output).toBeTruthy();
    expect(output?.textContent).toContain("Quarterly report");
    expect(tagNamesIn(output as HTMLElement)).toContain("table");

    // The one link with a scheme the sanitizer underwrites keeps its href and
    // is hardened; the `javascript:` anchors survive as text, without one.
    const links = [...(output?.querySelectorAll("a[href]") ?? [])];
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "https://example.com/report",
    ]);
    expect(links[0]?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(output?.textContent).toContain("payout");
  });

  it("sanitizes the wrapped output shapes too", async () => {
    runResult = { html: { type: "text", value: XSS_HTML } };
    await mount();

    expect(outputContainer()?.textContent).toContain("Quarterly report");
    expectInertResult();
  });

  it("renders no output block at all when the html is only a payload", async () => {
    runResult = { html: "<script>globalThis.__wfxss = 1;</script>" };
    await mount();

    expectInertResult();
    expect(outputContainer()).toBeNull();
    expect(
      [...(host?.querySelectorAll("a[href]") ?? [])].map((a) => a.getAttribute("href")),
    ).toEqual([RESULT_URL]);
  });

  it("does not link a run input file whose URL names an executable scheme", async () => {
    runtimeInputs = {
      fileName: "report.csv",
      file: "javascript:globalThis.__wfxss = 1",
    };
    runResult = {};
    await mount();

    expectInertResult();
    // Only the artifact link is left: the attachment link and its download
    // button are gone. (The inputs table still shows the value — as text.)
    expect(
      [...(host?.querySelectorAll("a[href]") ?? [])].map((a) => a.getAttribute("href")),
    ).toEqual([RESULT_URL]);
  });

  it("still links a run input file served over http", async () => {
    runtimeInputs = { fileName: "report.csv", file: "https://example.com/report.csv" };
    runResult = {};
    await mount();

    expect(
      [...(host?.querySelectorAll("a[href]") ?? [])].map((a) => a.getAttribute("href")),
    ).toEqual([RESULT_URL, "https://example.com/report.csv"]);
    expectInertResult();
  });

  it("renders table output as text, not markup", async () => {
    runResult = {
      data: JSON.stringify([
        { name: '<img src=x onerror="globalThis.__wfxss = 1">', value: 1 },
      ]),
    };
    await mount();

    expect(host?.textContent).toContain("<img src=x onerror=");
    expectInertResult();
  });
});
