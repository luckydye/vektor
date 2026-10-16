import { createEffect, createSignal, on } from "solid-js";

/** A set of selected ids out of `ids`, in order, with shift-click range selection. */
export function useSelection(ids: () => string[]) {
  const [selectedIds, setSelectedIds] = createSignal(new Set<string>());
  let lastClickedId: string | null = null;

  // Takes the event structurally: a tile selects from a keydown, a row from a click.
  function toggleSelect(id: string, event: { shiftKey: boolean }) {
    const next = new Set(selectedIds());

    if (event.shiftKey && lastClickedId && lastClickedId !== id) {
      const all = ids();
      const from = all.indexOf(lastClickedId);
      const to = all.indexOf(id);
      if (from !== -1 && to !== -1) {
        const [start, end] = from < to ? [from, to] : [to, from];
        for (let i = start; i <= end; i++) next.add(all[i]);
        setSelectedIds(next);
        return;
      }
    }

    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
    lastClickedId = id;
  }

  function selectAll() {
    setSelectedIds(new Set(ids()));
  }

  function deselectAll() {
    setSelectedIds(new Set<string>());
  }

  // Ids that are gone can no longer be acted on.
  createEffect(
    on(
      ids,
      (current) => {
        const available = new Set(current);
        const next = new Set([...selectedIds()].filter((id) => available.has(id)));
        if (next.size !== selectedIds().size) setSelectedIds(next);
      },
      { defer: true },
    ),
  );

  return { selectedIds, toggleSelect, selectAll, deselectAll };
}
