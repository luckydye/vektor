/**
 * Block types for the `customBlock` node (`documents/schema/specs.ts`). The
 * built-in "html" type lives in core; extensions register theirs through
 * `ctx.blocks`, under the type id `<extension id>.<name>` that documents store.
 */

/** What a mounted block returns: called on prop changes and on unmount. */
export type BlockInstance = {
  /** New props from the document. Without it, the block is mounted again. */
  update?: (props: unknown) => void;
  destroy?: () => void;
} | void;

export type BlockRenderContext = {
  props: unknown;
  /** Replaces the block's props in the document. */
  update: (props: unknown) => void;
};

export type BlockType = {
  /** Shown in the Add Content and slash menus. */
  title: string;
  description?: string;
  /** SVG markup; sanitized before it is rendered. */
  icon?: string;
  /** Props of a newly inserted block. */
  defaults: unknown;
  /** The block's editing UI in the editor. */
  render: (container: HTMLElement, context: BlockRenderContext) => BlockInstance;
  /** A read-only rendering for read mode. Without it, read mode shows the block's title. */
  view?: (container: HTMLElement, props: unknown) => BlockInstance;
};

export type RegisteredBlockType = BlockType & { id: string };

export function createBlockTypes() {
  const types = new Map<string, RegisteredBlockType>();
  const listeners = new Set<() => void>();

  function changed() {
    for (const listener of [...listeners]) listener();
  }

  return {
    register(id: string, type: BlockType) {
      if (types.has(id)) throw new Error(`Block type is already registered: ${id}`);
      types.set(id, { ...type, id });
      changed();
    },
    unregister(id: string) {
      if (types.delete(id)) changed();
    },
    get: (id: string) => types.get(id),
    list: () => [...types.values()],
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type BlockTypes = ReturnType<typeof createBlockTypes>;
