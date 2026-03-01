import type { Editor } from "@tiptap/core";

/**
 * Set the width of the currently selected image
 *
 * @example
 * // Set to specific pixel width
 * setImageWidth(editor, 400);
 *
 * @example
 * // Set to percentage width
 * setImageWidth(editor, '50%');
 *
 * @example
 * // Clear width (reset to auto)
 * setImageWidth(editor, null);
 *
 * @example
 * // Use in a toolbar button
 * <button onclick={() => setImageWidth(globalThis.__editor, 300)}>
 *   Small (300px)
 * </button>
 */
export function setImageWidth(editor: Editor, width: number | string | null) {
  const { state } = editor;
  const { selection } = state;
  const { $from } = selection;

  const node =
    $from.parent.type.name === "image" ? $from.parent : state.doc.nodeAt(selection.from);

  if (!node || node.type.name !== "image") {
    return false;
  }

  return editor.commands.updateAttributes("image", {
    width,
    display: null, // Clear display when setting specific width
  });
}

/**
 * Toggle full-width display for the currently selected image
 * Switches between full-width (100%) and original size
 *
 * @example
 * // Toggle full-width on/off
 * toggleImageFullWidth(editor);
 *
 * @example
 * // Use in a toolbar button
 * <button onclick={() => toggleImageFullWidth(globalThis.__editor)}>
 *   Toggle Full Width
 * </button>
 *
 * @example
 * // Use with keyboard shortcut (Alt + F)
 * editor.on('keydown', (event) => {
 *   if (event.altKey && event.key === 'f' && isImageSelected(editor)) {
 *     event.preventDefault();
 *     toggleImageFullWidth(editor);
 *   }
 * });
 */
export function toggleImageFullWidth(editor: Editor) {
  const { state } = editor;
  const { selection } = state;
  const { $from } = selection;

  const node =
    $from.parent.type.name === "image" ? $from.parent : state.doc.nodeAt(selection.from);

  if (!node || node.type.name !== "image") {
    return false;
  }

  const currentDisplay = node.attrs.display;
  const newDisplay = currentDisplay === "full" ? null : "full";

  return editor.commands.updateAttributes("image", {
    display: newDisplay,
    width: null, // Clear width when setting display mode
  });
}

/**
 * Set image to full width (100% of container)
 *
 * @example
 * setImageFullWidth(editor);
 *
 * @example
 * // Create multiple size buttons in toolbar
 * <div>
 *   <button onclick={() => setImageWidth(globalThis.__editor, 300)}>Small</button>
 *   <button onclick={() => setImageWidth(globalThis.__editor, 600)}>Medium</button>
 *   <button onclick={() => setImageFullWidth(globalThis.__editor)}>Full</button>
 * </div>
 */
export function setImageFullWidth(editor: Editor) {
  return editor.commands.updateAttributes("image", {
    display: "full",
    width: null,
  });
}

/**
 * Reset image to its original size (removes width and display attributes)
 *
 * @example
 * resetImageSize(editor);
 *
 * @example
 * // Use with keyboard shortcut (Alt + R)
 * editor.on('keydown', (event) => {
 *   if (event.altKey && event.key === 'r' && isImageSelected(editor)) {
 *     event.preventDefault();
 *     resetImageSize(editor);
 *   }
 * });
 */
export function resetImageSize(editor: Editor) {
  return editor.commands.updateAttributes("image", {
    width: null,
    display: null,
  });
}

/**
 * Check if the currently selected node is an image
 * Useful for enabling/disabling image-related toolbar buttons
 *
 * @example
 * if (isImageSelected(editor)) {
 *   console.log("An image is selected!");
 * }
 *
 * @example
 * // Disable toolbar button when no image is selected
 * <button
 *   disabled={!isImageSelected(editor)}
 *   onclick={() => setImageFullWidth(editor)}
 * >
 *   Full Width
 * </button>
 */
export function isImageSelected(editor: Editor): boolean {
  const { state } = editor;
  const { selection } = state;
  const { $from } = selection;

  const node =
    $from.parent.type.name === "image" ? $from.parent : state.doc.nodeAt(selection.from);

  return node?.type.name === "image";
}

/**
 * Get the current image attributes (width, display, src, etc.)
 * Returns null if no image is selected
 *
 * @example
 * const attrs = getImageAttributes(editor);
 * if (attrs) {
 *   console.log("Width:", attrs.width);
 *   console.log("Display:", attrs.display);
 *   console.log("Source:", attrs.src);
 * }
 *
 * @example
 * // Show current image dimensions in UI
 * const attrs = getImageAttributes(editor);
 * const statusText = attrs
 *   ? `${attrs.display === 'full' ? 'Full Width' : attrs.width || 'Auto'}`
 *   : 'No image selected';
 *
 * @example
 * // Programmatically resize all images in document
 * function resizeAllImages(editor, width) {
 *   const { state } = editor;
 *   let tr = state.tr;
 *
 *   state.doc.descendants((node, pos) => {
 *     if (node.type.name === 'image') {
 *       tr = tr.setNodeMarkup(pos, null, {
 *         ...node.attrs,
 *         width: width,
 *         display: null
 *       });
 *     }
 *   });
 *
 *   editor.view.dispatch(tr);
 * }
 */
export function getImageAttributes(editor: Editor) {
  const { state } = editor;
  const { selection } = state;
  const { $from } = selection;

  const node =
    $from.parent.type.name === "image" ? $from.parent : state.doc.nodeAt(selection.from);

  if (!node || node.type.name !== "image") {
    return null;
  }

  return node.attrs;
}
