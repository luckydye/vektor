import { createRenderEffect } from "solid-js";
import { isServer } from "solid-js/web";
import { twMerge } from "tailwind-merge";
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
  missingIcon,
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
  recordIcon,
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
import { sanitizeSvgMarkup } from "#utils/html.ts";

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
  missing: missingIcon,
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
  record: recordIcon,
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

const FALLBACK = icons.missing;

const templates = new Map<string, HTMLTemplateElement>();
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

  if (!stamped.has(element) && element.firstChild) {
    stamped.set(element, svg);
    return;
  }

  element.replaceChildren(iconNode(svg));
  stamped.set(element, svg);
}

export function iconMarkup(name: IconName): string {
  return icons[name] ?? FALLBACK;
}

interface Props {
  name?: IconName;
  svg?: string;
  class?: string;
}

export function Icon(props: Props) {
  const svg = () => {
    // `svg` is untrusted: a space logo and an extension icon are both markup a
    // user stored (`preferences.logoSvg`), and both end up in `innerHTML` here
    // and in the SSR branch below. A value that is not an SVG document — a URL,
    // or a payload dressed up as one — sanitizes to "" and shows the fallback.
    if (props.svg) return sanitizeSvgMarkup(props.svg) || FALLBACK;
    if (props.name) return icons[props.name] ?? FALLBACK;
    return "";
  };
  const className = () => twMerge("svg-icon", props.class);

  if (isServer) {
    return <span class={className()} innerHTML={svg()} aria-hidden="true" />;
  }

  return (
    <span
      class={className()}
      aria-hidden="true"
      ref={(element) => createRenderEffect(() => stamp(element, svg()))}
    />
  );
}
