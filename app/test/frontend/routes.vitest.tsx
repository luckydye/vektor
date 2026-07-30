import { afterEach, describe, expect, it } from "vitest";
import Dialog from "#components/Dialog.vue";
import DocumentTree from "#components/DocumentTree.vue";
import NotFoundView from "#components/views/NotFoundView.vue";
import SpaceHomeView from "#components/views/SpaceHomeView.vue";
import SpaceSearchView from "#components/views/SpaceSearchView.vue";
import SpaceSettingsView from "#components/views/SpaceSettingsView.vue";
import { renderRoute } from "./routeHarness.ts";

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

  it("space search", async () => {
    await expect(await snapshotOf(SpaceSearchView)).toMatchFileSnapshot(
      "./__snapshots__/route-space-search.html",
    );
  });

  it("space settings", async () => {
    await expect(await snapshotOf(SpaceSettingsView)).toMatchFileSnapshot(
      "./__snapshots__/route-space-settings.html",
    );
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

  it("dialog, open", async () => {
    await snapshotOf(Dialog, { props: { show: true, title: "Fixture dialog" } });
    // Dialog teleports, so the panel is on the body rather than in the container.
    const { normalizeDom } = await import("./normalize.ts");
    await expect(normalizeDom(document.body)).toMatchFileSnapshot(
      "./__snapshots__/panel-dialog-open.html",
    );
  });
});
