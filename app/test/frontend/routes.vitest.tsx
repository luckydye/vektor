import { afterEach, describe, expect, it } from "vitest";
import { CommandPalatte } from "#components/CommandPalatte.tsx";
import { Dialog } from "#components/Dialog.tsx";
import { DocumentTree } from "#components/DocumentTree.tsx";
import { DocumentPageView } from "#components/views/DocumentPageView.tsx";
import { ExtensionRouteView } from "#components/views/ExtensionRouteView.tsx";
import { NotFoundView } from "#components/views/NotFoundView.tsx";
import { SpaceHomeView } from "#components/views/SpaceHomeView.tsx";
import { SpaceSearchView } from "#components/views/SpaceSearchView.tsx";
import { SpaceSettingsView } from "#components/views/SpaceSettingsView.tsx";
import { renderRoute } from "./routeHarness.tsx";

/**
 * Tier 2: the literal before/after diff.
 *
 * Each route renders against a fixed API fixture, and its normalized DOM is
 * snapshotted. On the migration branch these files are the comparison — a diff
 * here is either a deliberate change or a port bug, and nothing else in the
 * suite catches markup drift, a lost attribute or a missing node.
 *
 * Snapshots are committed. The normalizer is what makes that safe: no scope
 * ids, no hydration markers, sorted classes, placeholdered dates.
 */

const open: Array<() => void> = [];
afterEach(() => {
  for (const dispose of open.splice(0)) dispose();
});

async function snapshotOf(View: unknown, options = {}) {
  const route = await renderRoute(View, options);
  open.push(route.cleanup);
  return route.snapshot();
}

describe("route snapshots", () => {
  it("space home", async () => {
    await expect(await snapshotOf(SpaceHomeView)).toMatchFileSnapshot(
      "./__snapshots__/route-space-home.html",
    );
  });

  // `at`, because Search calls useNavigate/useLocation at setup and those throw
  // outside a Route. The Vue original reached the router through a lazy
  // computed, so it rendered without one.
  it("space search", async () => {
    await expect(
      await snapshotOf(SpaceSearchView, { at: "/search" }),
    ).toMatchFileSnapshot("./__snapshots__/route-space-search.html");
  });

  it("space settings", async () => {
    await expect(await snapshotOf(SpaceSettingsView)).toMatchFileSnapshot(
      "./__snapshots__/route-space-settings.html",
    );
  });

  it("document page", async () => {
    await expect(
      await snapshotOf(DocumentPageView, {
        at: "/doc/getting-started",
        props: { documentSlug: "getting-started" },
        fixture: [
          [
            /\/documents\/[^/?]+(\?|$)/,
            {
              document: {
                id: "doc_fixture_1",
                slug: "getting-started",
                type: "document",
                title: "Getting started",
                content: "# Getting started\n\nA seeded paragraph.",
                currentRev: 1,
                publishedRev: 1,
                properties: {},
                readonly: false,
                archived: false,
                parentId: null,
                createdBy: "user_ada",
                createdAt: "2026-01-02T09:00:00.000Z",
                updatedAt: "2026-01-02T10:00:00.000Z",
              },
            },
          ],
          [/\/revisions/, { revisions: [] }],
          [/\/comments/, { comments: [] }],
          [/\/contributors/, { contributors: [] }],
        ],
      }),
    ).toMatchFileSnapshot("./__snapshots__/route-document-page.html");
  });

  // Two states, because the happy path needs a real extension bundle served
  // over HTTP and happy-dom cannot load one. What these do lock in is that the
  // route resolves the extension, mounts `<extension-view>`, and degrades to a
  // readable error instead of a blank page — which is the part a port could
  // plausibly break.
  it("extension route, view fails to load", async () => {
    await expect(
      await snapshotOf(ExtensionRouteView, {
        at: "/x/reports/monthly",
        fixture: [
          [
            /\/extensions/,
            {
              extensions: [
                {
                  id: "ext_reports",
                  name: "Reports",
                  version: "1.0.0",
                  enabled: true,
                  entries: { view: "view.js" },
                  routes: [{ path: "reports", title: "Reports", icon: "" }],
                },
              ],
            },
          ],
        ],
      }),
    ).toMatchFileSnapshot("./__snapshots__/route-extension.html");
  });

  it("extension route, no extension matches the path", async () => {
    await expect(
      await snapshotOf(ExtensionRouteView, { at: "/x/nothing/here" }),
    ).toMatchFileSnapshot("./__snapshots__/route-extension-unmatched.html");
  });

  it("not found", async () => {
    await expect(await snapshotOf(NotFoundView)).toMatchFileSnapshot(
      "./__snapshots__/route-not-found.html",
    );
  });
});

describe("panel snapshots", () => {
  it("document tree", async () => {
    await expect(
      await snapshotOf(DocumentTree, {
        fixture: [
          [
            /\/categories/,
            [{ id: "cat_1", name: "Guidelines", slug: "guidelines", color: "#4ECDC4" }],
          ],
        ],
      }),
    ).toMatchFileSnapshot("./__snapshots__/panel-document-tree.html");
  });

  it("command palette, open", async () => {
    const route = await renderRoute(CommandPalatte, {});
    open.push(route.cleanup);
    // The palette is keyboard-summoned and never route-reachable, so it is
    // opened through the action it registers rather than by navigating.
    const { Actions } = await import("#utils/actions.js");
    await Actions.run("ui:toggle:palatte");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const { normalizeDom } = await import("./normalize.ts");
    await expect(normalizeDom(route.container)).toMatchFileSnapshot(
      "./__snapshots__/panel-command-palette.html",
    );
  });

  it("dialog, open", async () => {
    await snapshotOf(Dialog, { props: { show: true, title: "Fixture dialog" } });
    // Dialog teleports, so the panel is on the body rather than in the container.
    const { normalizeDom } = await import("./normalize.ts");
    await expect(normalizeDom(document.body)).toMatchFileSnapshot(
      "./__snapshots__/panel-dialog-open.html",
    );
  });
});
