import { createEffect, createRoot, createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { Actions } from "#utils/actions.ts";
import { registerScopedAction } from "#utils/scopedAction.ts";

/**
 * Context-based actions must not outlive their context.
 *
 * The action registry is a module-level map, so an action registered while a
 * document is open stays in the command palette and context menu of every page
 * that follows unless something removes it — and then "Unpublish" or "Duplicate
 * Document" is offered on the home page, where there is no document to act on.
 */

const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  for (const [id] of [...Actions.entries()]) Actions.unregister(id);
});

function inRoot<T>(setup: () => T): T {
  let value!: T;
  createRoot((dispose) => {
    disposers.push(dispose);
    value = setup();
  });
  return value;
}

const noop = { run: async () => {} };

describe("registerScopedAction", () => {
  it("removes the action when its owner is disposed", () => {
    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      registerScopedAction("document:unpublish", { ...noop, group: "document:danger" });
    });

    expect(Actions.get("document:unpublish")).toBeTruthy();

    dispose();

    expect(Actions.get("document:unpublish")).toBeUndefined();
    expect(Actions.group("document:danger")).toEqual([]);
  });

  it("removes the action when a re-running effect no longer registers it", async () => {
    const [hasDocument, setHasDocument] = createSignal(true);

    inRoot(() => {
      createEffect(() => {
        if (!hasDocument()) return;
        registerScopedAction("document:duplicate", { ...noop, group: "document" });
      });
    });
    await Promise.resolve();

    expect(Actions.get("document:duplicate")).toBeTruthy();

    setHasDocument(false);
    await Promise.resolve();

    expect(Actions.get("document:duplicate")).toBeUndefined();
  });

  it("keeps the live registration when a second owner replaced it first", () => {
    // Several DocumentActions instances (one per header layout) share these ids;
    // the one leaving must not delete the registration of the one arriving.
    let disposeFirst!: () => void;
    createRoot((d) => {
      disposeFirst = d;
      registerScopedAction("document:share", { ...noop, title: "first" });
    });

    inRoot(() => registerScopedAction("document:share", { ...noop, title: "second" }));

    disposeFirst();

    expect(Actions.get("document:share")?.title).toBe("second");
  });

  it("drops the keyboard shortcut along with the action", () => {
    let dispose!: () => void;
    createRoot((d) => {
      dispose = d;
      registerScopedAction("document:archive", noop);
    });
    // A plain modifier, not "mod-": the platform-aware one resolves to meta or
    // ctrl depending on the host running the suite.
    Actions.mapShortcut("shift-a", "document:archive");

    const event = new KeyboardEvent("keydown", { key: "a", shiftKey: true });
    expect(Actions.getActionForShortcut(event)).toBe("document:archive");

    dispose();

    // The mapping survives (shortcuts.json owns it), but it resolves to nothing
    // while no document is open, so the key press cannot run the action.
    expect(Actions.getActionForShortcut(event)).toBeUndefined();
    Actions.unmapShortcut("shift-a", "document:archive");
  });
});

describe("document-scoped actions in components", () => {
  /**
   * A source scan, because the failure is an omission: `Actions.register` in a
   * component without a matching cleanup looks perfectly fine and only shows up
   * as a stale menu entry two navigations later. `registerScopedAction` cannot
   * be forgotten the same way.
   *
   * Keyed on the group rather than the id, because the group is what makes an
   * action document-scoped: `document`, `document:danger` and `document:dev` are
   * exactly what DocumentActions renders into the document context menu. An id
   * like `document:create` is space-scoped and belongs to the shell.
   *
   * Components only. `useEditor` registers the save actions around an explicit
   * editor session (register on start, unregister on stop) rather than around an
   * owner lifetime, which this rule would wrongly flag.
   */
  it("register through the owner-scoped helper", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join, relative, resolve } = await import("node:path");

    const root = resolve(process.cwd(), "src/components");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(path)) files.push(path);
      }
    };
    walk(root);

    const offenders = files.flatMap((file) => {
      const lines = readFileSync(file, "utf8").split("\n");
      return lines.flatMap((line, index) => {
        if (!/Actions\.register\(/.test(line)) return [];
        // The group sits in the options object opened on this line.
        const options = lines.slice(index, index + 12).join("\n");
        if (!/group:\s*"document(?::danger|:dev)?"/.test(options)) return [];
        return [`${relative(root, file)}:${index + 1}`];
      });
    });

    expect(offenders).toEqual([]);
  });
});

describe("Actions.unregister", () => {
  it("matches the lowercasing register() applies", () => {
    Actions.register("Document:MixedCase", noop);
    Actions.unregister("Document:MixedCase");
    expect(Actions.get("document:mixedcase")).toBeUndefined();
  });
});
