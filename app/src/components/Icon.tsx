import { createRenderEffect } from "solid-js";
import { isServer } from "solid-js/web";
import {
  activityIcon,
  addAttachmentsIcon,
  addColumnLeftIcon,
  addColumnRightIcon,
  addIcon,
  addRowBottomIcon,
  addRowTopIcon,
  agentChatIcon,
  alertCircleIcon,
  archiveBoxIcon,
  archiveDocumentIcon,
  arrowLeftIcon,
  boldIcon,
  boltIcon,
  cancelIcon,
  canvasIcon,
  categoryIcon,
  cellFillIcon,
  chevronDownIcon,
  chevronLeftLargeIcon,
  chevronLeftThinIcon,
  chevronRightSmallIcon,
  chevronRightThinIcon,
  cmdIcon,
  collapseSidebarIcon,
  commandPaletteIcon,
  commentIcon,
  confirmationIcon,
  contextMenuMoreIcon,
  copyIcon,
  csvFileIcon,
  ctrlIcon,
  cutIcon,
  databaseIcon,
  dateIcon,
  deleteColumnIcon,
  deleteElementIcon,
  deleteEntryIcon,
  deleteRowIcon,
  documentIcon,
  documentWidthFullIcon,
  documentWidthStandardIcon,
  downloadIcon,
  dragDotsIcon,
  editDocumentIcon,
  editEntryIcon,
  enableNotificationsIcon,
  extensionIcon,
  eyeIcon,
  fileAttachmentIcon,
  fileIcon,
  fitViewToElementsIcon,
  folderIcon,
  fourColumnsIcon,
  frameSectionToolIcon,
  functionIcon,
  genericPropertyIcon,
  gridCleanIcon,
  gridDotsIcon,
  gridGridIcon,
  headerImageIcon,
  homeIcon,
  htmlIcon,
  imageFullWidthIcon,
  imageIcon,
  indentIcon,
  infoIcon,
  italicIcon,
  justifyBlockIcon,
  justifyCenterIcon,
  justifyLeftIcon,
  justifyRightIcon,
  linkIcon,
  listIcon,
  lockElementIcon,
  mergeCellsIcon,
  muteNotificationsIcon,
  newDocumentIcon,
  noteToolIcon,
  numberedListIcon,
  outdentIcon,
  pasteIcon,
  penToolIcon,
  peopleIcon,
  pinToHomeIcon,
  playCircleFilledIcon,
  preferencesIcon,
  presentationIcon,
  printIcon,
  publishIcon,
  redoIcon,
  refreshIcon,
  resizeHandleIcon,
  restoreArrowIcon,
  searchIcon,
  selectToolIcon,
  sendFeedbackIcon,
  sendMessageIcon,
  settingsIcon,
  shapeCircleIcon,
  shapeRectangleIcon,
  shapesToolIcon,
  shiftIcon,
  signOutIcon,
  sourceCodeIcon,
  spinnerIcon,
  splitCellsIcon,
  stopIcon,
  strikeThroughIcon,
  tableIcon,
  taskListIcon,
  textColorIcon,
  textToolIcon,
  thinkingIcon,
  threeColumnsIcon,
  twoColumnsIcon,
  underlineIcon,
  undoIcon,
  unlockElementIcon,
  uploadFileIcon,
  usersGroupIcon,
  usersIcon,
  videoIcon,
  warningTriangleIcon,
} from "#assets/icons.ts";

/**
 * The icon set, keyed by file name.
 *
 * This is the only module that imports SVG markup: components name the icon
 * they want and never hold the bytes. Non-Solid callers that build DOM
 * themselves — canvas overlays, editor toolbars — take the markup from
 * `iconMarkup` for the same reason.
 */
const icons = {
  "2-columns": twoColumnsIcon,
  "3-columns": threeColumnsIcon,
  "4-columns": fourColumnsIcon,
  activity: activityIcon,
  add: addIcon,
  "add-attachments": addAttachmentsIcon,
  "add-column-left": addColumnLeftIcon,
  "add-column-right": addColumnRightIcon,
  "add-row-bottom": addRowBottomIcon,
  "add-row-top": addRowTopIcon,
  "agent-chat": agentChatIcon,
  "alert-circle": alertCircleIcon,
  archive: archiveBoxIcon,
  "archive-document": archiveDocumentIcon,
  "arrow-left": arrowLeftIcon,
  bold: boldIcon,
  bolt: boltIcon,
  cancel: cancelIcon,
  canvas: canvasIcon,
  category: categoryIcon,
  "cell-fill": cellFillIcon,
  "chevron-down": chevronDownIcon,
  "chevron-left-large": chevronLeftLargeIcon,
  "chevron-left-thin": chevronLeftThinIcon,
  "chevron-right-small": chevronRightSmallIcon,
  "chevron-right-thin": chevronRightThinIcon,
  cmd: cmdIcon,
  "collapse-sidebar": collapseSidebarIcon,
  "command-palette": commandPaletteIcon,
  comment: commentIcon,
  confirmation: confirmationIcon,
  "context-menu-more": contextMenuMoreIcon,
  copy: copyIcon,
  "csv-file": csvFileIcon,
  ctrl: ctrlIcon,
  cut: cutIcon,
  database: databaseIcon,
  date: dateIcon,
  "delete-column": deleteColumnIcon,
  "delete-element": deleteElementIcon,
  "delete-entry": deleteEntryIcon,
  "delete-row": deleteRowIcon,
  document: documentIcon,
  "document-width-full": documentWidthFullIcon,
  "document-width-standard": documentWidthStandardIcon,
  download: downloadIcon,
  "drag-dots": dragDotsIcon,
  "edit-document": editDocumentIcon,
  "edit-entry": editEntryIcon,
  "enable-notifications": enableNotificationsIcon,
  extension: extensionIcon,
  eye: eyeIcon,
  file: fileIcon,
  "file-attachment": fileAttachmentIcon,
  "fit-view-to-elements": fitViewToElementsIcon,
  folder: folderIcon,
  "frame-section-tool": frameSectionToolIcon,
  function: functionIcon,
  "generic-property": genericPropertyIcon,
  "grid-clean": gridCleanIcon,
  "grid-dots": gridDotsIcon,
  "grid-grid": gridGridIcon,
  "header-image": headerImageIcon,
  home: homeIcon,
  html: htmlIcon,
  image: imageIcon,
  "image-full-width": imageFullWidthIcon,
  indent: indentIcon,
  info: infoIcon,
  italic: italicIcon,
  "justify-block": justifyBlockIcon,
  "justify-center": justifyCenterIcon,
  "justify-left": justifyLeftIcon,
  "justify-right": justifyRightIcon,
  link: linkIcon,
  list: listIcon,
  "lock-element": lockElementIcon,
  "merge-cells": mergeCellsIcon,
  "mute-notifications": muteNotificationsIcon,
  "new-document": newDocumentIcon,
  "note-tool": noteToolIcon,
  "numbered-list": numberedListIcon,
  outdent: outdentIcon,
  paste: pasteIcon,
  "pen-tool": penToolIcon,
  people: peopleIcon,
  "pin-to-home": pinToHomeIcon,
  "play-circle-filled": playCircleFilledIcon,
  preferences: preferencesIcon,
  presentation: presentationIcon,
  print: printIcon,
  publish: publishIcon,
  redo: redoIcon,
  refresh: refreshIcon,
  "resize-handle": resizeHandleIcon,
  restore: restoreArrowIcon,
  search: searchIcon,
  "select-tool": selectToolIcon,
  "send-feedback": sendFeedbackIcon,
  "send-message": sendMessageIcon,
  settings: settingsIcon,
  "shape-circle": shapeCircleIcon,
  "shape-rectangle": shapeRectangleIcon,
  "shapes-tool": shapesToolIcon,
  shift: shiftIcon,
  "sign-out": signOutIcon,
  "source-code": sourceCodeIcon,
  spinner: spinnerIcon,
  "split-cells": splitCellsIcon,
  stop: stopIcon,
  "strike-through": strikeThroughIcon,
  table: tableIcon,
  "task-list": taskListIcon,
  "text-color": textColorIcon,
  "text-tool": textToolIcon,
  thinking: thinkingIcon,
  underline: underlineIcon,
  undo: undoIcon,
  "unlock-element": unlockElementIcon,
  "upload-file": uploadFileIcon,
  users: usersIcon,
  "users-group": usersGroupIcon,
  video: videoIcon,
  "warning-triangle": warningTriangleIcon,
} as const;

export type IconName = keyof typeof icons;

/**
 * One parse per distinct icon.
 *
 * `element.innerHTML = svg` runs the HTML parser on every assignment, and an
 * icon is the same few hundred bytes every time — a list of 500 rows parsed the
 * same handful of icons 500 times over, which measured as the single largest
 * cost in an initial render. A `<template>` parses once and every use after
 * that is a clone, which the browser does without going near the parser.
 */
const templates = new Map<string, HTMLTemplateElement>();
/** The icon each element currently holds, so a re-stamp only happens on change. */
const stamped = new WeakMap<Element, string>();

function iconNode(svg: string): Node {
  let template = templates.get(svg);
  if (!template) {
    template = document.createElement("template");
    template.innerHTML = svg;
    templates.set(svg, template);
  }
  return template.content.cloneNode(true);
}

function stamp(element: Element, svg: string): void {
  if (stamped.get(element) === svg) return;

  // A hydrated element already holds what the server wrote, and re-stamping it
  // would throw that markup away to rebuild the same thing. This matches what
  // `innerHTML` did here before — dom-expressions skips property writes on
  // hydrated nodes, so the server's markup was already the one that stood.
  if (!stamped.has(element) && element.firstChild) {
    stamped.set(element, svg);
    return;
  }

  element.replaceChildren(iconNode(svg));
  stamped.set(element, svg);
}

/**
 * The icon box itself: `svg-icon` carries the display and the rule that makes
 * the glyph fill it, `.icon` is the hook `button-with-icon` spaces a following
 * label against. Callers add size and colour, not mechanics.
 */
const BASE_CLASS = "icon svg-icon";

/** An icon's markup, for callers that build DOM without Solid. */
export function iconMarkup(name: IconName): string {
  return icons[name] ?? icons.home;
}

interface Props {
  /** Which icon to draw. Unknown names — an extension's, say — draw nothing. */
  name?: IconName;
  /**
   * Markup instead of a name, for SVG that arrives as *data* rather than from
   * the icon set: an uploaded space logo, a cosmetic glyph, an extension's own
   * artwork. Anything in the set is named, never passed as bytes.
   */
  svg?: string;
  /** Size and colour, merged onto the root; attributes do not fall through. */
  class?: string;
  classList?: Record<string, boolean | undefined>;
}

export function Icon(props: Props) {
  const svg = () => props.svg ?? (props.name ? (icons[props.name] ?? "") : "");
  const className = () => (props.class ? `${BASE_CLASS} ${props.class}` : BASE_CLASS);

  // The server has no DOM to clone from, and the markup has to reach the
  // response so the shell paints its icons before hydration. Both branches
  // render the same element, so hydration adopts it either way.
  if (isServer) {
    return (
      <span
        class={className()}
        classList={props.classList}
        innerHTML={svg()}
        aria-hidden="true"
      />
    );
  }

  return (
    <span
      class={className()}
      classList={props.classList}
      aria-hidden="true"
      ref={(element) => createRenderEffect(() => stamp(element, svg()))}
    />
  );
}
