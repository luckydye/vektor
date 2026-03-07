import { html, render } from "lit-html";
import { bitmapToBlob, blobToUri, debounce, rgbToHex, rgbToHsl } from "../utils.ts";
import { Canvas, CanvasRenderer } from "../Canvas.ts";
import "./Toolbar.ts";
import { ContextMenu } from "./ContextMenu.ts";
import TextNode from "./nodes/TextNode.ts";
import ImageNode from "./nodes/ImageNode.ts";
import Pen from "./tools/Pen.ts";
import Select from "./tools/Select.ts";
import { DataHandler } from "../files/Handlers.ts";
import type { PresenceEnvelope } from "../../utils/realtime.ts";

function dragElement(ele, callback) {
  let lastEvent = null;
  let dragging = false;

  let state = null;
  const pointers = {};

  ele.addEventListener("pointerdown", (e) => {
    dragging = true;
    lastEvent = e;

    pointers[e.pointerId] = e;

    state = {
      button: e.button,
      x: e.x,
      y: e.y,
      delta: [0, 0],
      absolute: [0, 0],
      mousedown: true,
      mouseup: false,
      target: e.target,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      pressure: 1.0,
    };

    callback(state);
  });

  window.addEventListener("pointerup", (e) => {
    if (dragging) {
      dragging = false;
      lastEvent = null;

      state.x = e.x;
      state.y = e.y;
      state.mousedown = false;
      state.mouseup = true;
      state.target = e.target;

      callback(state);
    }

    delete pointers[e.pointerId];
  });

  window.addEventListener("pointermove", (e) => {
    if (dragging && lastEvent) {
      state.x = e.x;
      state.y = e.y;
      state.delta = [e.movementX, e.movementY];
      state.absolute = [lastEvent.x - e.x, lastEvent.y - e.y];
      state.mousedown = false;
      state.mouseup = false;
      state.target = e.target;
      state.ctrlKey = e.ctrlKey;
      state.altKey = e.altKey;
      state.shiftKey = e.shiftKey;
      state.pressure = e.pressure;
      state.type = e.pointerType;
      state.pointerId = e.pointerId;

      callback(state);
    }
  });
}

const renderer = new CanvasRenderer();

const NODE_TYPES = {
  "text/plain": TextNode,
  "image/jpg": ImageNode,
  "image/png": ImageNode,
  "image/webp": ImageNode,
  "image/gif": ImageNode,
};

const TOOLS = [Select, Pen];

const TOOLS_MAP = {
  select: Select,
  pen: Pen,
};

export default class CanvasElement extends HTMLElement {
  canvas: Canvas;
  remotePresences = new Map();

  setCanvas(canvas) {
    this.canvas = canvas;
  }

  setRemotePresences(presences: Map<string, PresenceEnvelope>) {
    this.remotePresences = presences;
  }

  getPresenceState() {
    return {
      kind: "canvas",
      pointer: Number.isFinite(this.pointer.canvasX) && Number.isFinite(this.pointer.canvasY)
        ? { x: this.pointer.canvasX, y: this.pointer.canvasY }
        : null,
      view: {
        x: this.canvas.canvas.view[0],
        y: this.canvas.canvas.view[1],
        scale: this.canvas.canvas.scale,
      },
      selectionIds: this.selection.map((node) => node.id),
      focusedNodeId: this.pointer.focusedElement?.id ?? null,
      activeTool: TOOLS[this.activeTool]?.name?.toLowerCase?.() ?? null,
    };
  }

  async handleDataItems(items) {
    for (const item of items) {
      let uri;

      if (item.kind === "file") {
        const file = item.getAsFile();
        uri = await blobToUri(file);

        if (uri) {
          const node = this.canvas.createNode(uri);
          this.canvas.mutateNode(node, (data) => ({
            ...data,
            position: [this.pointer.canvasX, this.pointer.canvasY],
          }));
        }
      } else if (item instanceof File) {
        DataHandler.importFiles([item]);
      } else if (item instanceof Blob) {
        if (item.type.match("image")) {
          const uri = await blobToUri(item);
          const node = this.canvas.createNode(uri);
          this.canvas.mutateNode(node, (data) => ({
            ...data,
            position: [this.pointer.canvasX, this.pointer.canvasY],
          }));
        } else if (item.type.match("text/plain")) {
          const str = await item.text();
          DataHandler.handleUrl(str);
        }
      } else {
        if (item.type !== "text/html") {
          item.getAsString((uri) => {
            try {
              DataHandler.handleUrl(uri);
            } catch (_err) {
              const node = this.canvas.createNode(uri);
              this.canvas.mutateNode(node, (data) => ({
                ...data,
                position: [this.pointer.canvasX, this.pointer.canvasY],
              }));
            }
          });
        }
      }
    }
  }

  deleteSelection() {
    for (const node of this.lastLastSelection) {
      this.deleteNode(node);
    }
  }

  undo() {
    this.canvas.stepBack();
  }

  redo() {
    this.canvas.stepForward();
  }

  selectAll() {
    this.selection = [...this.canvas.nodes];
  }

  async copyAsImage() {
    const items = [];
    for (const node of this.lastLastSelection) {
      const element = this.canvas.getNodeBlob(node);
      const blob = await bitmapToBlob(element.image);
      items.push(new ClipboardItem({ "image/png": blob }));
    }

    navigator.clipboard.write(items);
  }

  previewImage(state) {
    this.pointer.zoomImage = state;
  }

  handTool(state) {
    this.pointer.moveCanvas = state;
    if (state) {
      this.canvasElement.style.cursor = "grab";
    } else {
      this.canvasElement.style.cursor = "";
    }
  }

  penTool(state) {
    this.pointer.drawTool = state;
    if (state) {
      this.canvasElement.style.cursor = "url(./images/pen.svg), auto";
    } else {
      this.canvasElement.style.cursor = "";
    }
  }

  eraserTool(state) {
    if (TOOLS[this.activeTool] === TOOLS_MAP.pen) {
      this.pointer.drawTool = state;
      if (!this.pointer.moveCanvas) {
        this.pointer.eraser = state;
      }
      if (state) {
        this.canvasElement.style.cursor = makeBrushCursor(this.pointer.brushSize);
      } else {
        this.canvasElement.style.cursor = "";
      }
    }
  }

  colorPicker(state) {
    this.pointer.colorPicker = state;
    if (state) {
      this.colorPickerInterval = setInterval(() => {
        if (this.pointer.color) {
          const uri = makeColorPickerCursor(this.pointer.color);
          this.canvasElement.style.cursor = uri;
        }
      }, 1000 / 24);
    } else {
      clearInterval(this.colorPickerInterval);
      this.canvasElement.style.cursor = "";
    }
  }

  pointer = {
    x: 0,
    y: 0,
    selection: [
      [0, 0],
      [0, 0],
    ],
    selecting: false,
    scaleCorner: false,
    colorPicker: false,
    deleteCorner: false,
    scaling: false,
    zoomImage: false,
    moveCanvas: false,
    brushSize: 20,
    focusedElement: null,
    color: null,
    node: null,
    lastNode: null,
  };

  connectedCallback() {
    this.tabIndex = 0;
  }

  constructor() {
    super();

    this.canvas = new Canvas();
    this.canvasElement = document.createElement("canvas");
    this.context = this.canvasElement.getContext("2d");
    this.selection = [];

    this.activeTool = 0;
    this.lastUsedTool = null;

    this.currentScale = 0.1;
    this.scaleCornerSize = 30;
    this.gridSize = 100;
    this.colors = {
      line_color: "#eee",
      grid_1: "#171717",
      grid_2: "#101010",
      selection_border: "#333",
      selection_background: "#33333333",
    };
    this.uiElements = {};

    this.attachShadow({ mode: "open" });

    // contextMenu
    const ctxtMenuStartPos = [0, 0];
    this.canvasElement.addEventListener("mousedown", (e) => {
      ctxtMenuStartPos[0] = e.x;
      ctxtMenuStartPos[1] = e.y;
    });

    this.addEventListener("paste", (e) => {
      this.handleDataItems(e.clipboardData?.items);
    });

    const menu = new ContextMenu({
      items: [
        {
          title: "Create Text Element",
          action: () => {
            const node = this.canvas.createNode("Text");
            this.canvas.mutateNode(node, (data) => ({
              ...data,
              position: [this.pointer.canvasX, this.pointer.canvasY],
            }));
          },
        },
        {
          title: "Import Image",
          action: () => {
            window.importImage();
          },
        },
        {
          title: "Paste",
          action: () => {
            window.pasteImage();
          },
        },
      ],
    });
    document.body.appendChild(menu);

    this.canvasElement.oncontextmenu = (e) => {
      if (ctxtMenuStartPos[0] === e.x && ctxtMenuStartPos[1] === e.y) {
        menu.setPosition(e.x, e.y);
        e.preventDefault();
      } else {
        e.preventDefault();
      }
    };
    // contextMenu end

    window.addEventListener("resize", this.resize.bind(this));

    this.canvasElement.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.setScale(
        this.canvas.canvas.scale - e.deltaY * this.canvas.canvas.scale * 0.001,
      );
    });

    // Arrowkey node movement
    this.addEventListener("keydown", (e) => {
      // input for text elements
      if (this.pointer.focusedElement) {
        const element = this.canvas.getNodeBlob(this.pointer.focusedElement);
        if (element && element.type === "text/plain") {
          if (e.key.length > 1) {
            switch (e.key) {
              case "Backspace":
                element.data = element.data.slice(0, element.data.length - 1);
                break;
              default:
                break;
            }
          } else {
            element.data += e.key;
          }
          return;
        }
      }

      // global key controls
      let index = 1;
      let dir = 1;

      const keys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
      switch (e.key) {
        case "ArrowUp":
          index = 1;
          dir = -1;
          break;
        case "ArrowDown":
          index = 1;
          dir = 1;
          break;
        case "ArrowLeft":
          index = 0;
          dir = -1;
          break;
        case "ArrowRight":
          index = 0;
          dir = 1;
          break;
      }

      if (keys.indexOf(e.key) !== -1) {
        for (const node of this.lastLastSelection) {
          node.position[index] += (1 / this.currentScale) * dir;
          this.canvas.mutateNode(node, (data) => ({
            ...data,
            position: node.position,
          }));
        }
      }
    });
    window.addEventListener("pointerup", (_e) => {
      if (this.pointer.deleteCorner) {
        for (const node of this.selection) {
          this.deleteNode(node);
        }
      }
      if (this.pointer.colorPicker && this.pointer.color) {
        const hex = rgbToHex(...this.pointer.color);
        navigator.clipboard.writeText(hex);
      }
    });

    const pickColorDebounced = debounce((_e) => {
      this.pointer.color = this.pickColor(this.pointer.x, this.pointer.y);
      this.style.setProperty(
        "--colorPicker-color",
        `
                rgb(${this.pointer.color[0]}, ${this.pointer.color[1]}, ${this.pointer.color[2]})
            `,
      );
    }, 200);

    this.canvasElement.addEventListener("pointermove", (e) => {
      this.pointer.x = e.x;
      this.pointer.y = e.y;
      const conv = this.viewToCanvas(e.x, e.y);
      this.pointer.canvasX = conv[0];
      this.pointer.canvasY = conv[1];

      if (this.pointer.colorPicker) {
        pickColorDebounced(e);
      }
    });

    this.canvasElement.addEventListener("dragover", (e) => {
      const conv = this.viewToCanvas(e.x, e.y);
      this.pointer.canvasX = conv[0];
      this.pointer.canvasY = conv[1];
    });

    this.canvasElement.addEventListener("dblclick", (e) => {
      const node = this.hitTestNode(e.x, e.y);
      if (node) {
        this.bringNodeToFront(node);
      }
    });

    dragElement(this.canvasElement, this.handleMouseInput.bind(this));

    this.update();

    DataHandler.enableDragAndDrop(this);
  }

  deleteNode(node) {
    const id = node.element;
    this.canvas.deleteNode(node);

    // update ui
    if (id in this.uiElements) {
      this.uiElements[id].remove();
      this.uiElements[id] = null;
    }
  }

  getNodeType(node) {
    const element = this.canvas.getNodeBlob(node);
    return NODE_TYPES[element.type];
  }

  setActiveTool(toolIndex) {
    if (TOOLS[toolIndex]) {
      this.lastUsedTool = this.activeTool;
      this.activeTool = toolIndex;
    }
  }

  handleMouseInput(data) {
    // redirect to tools
    if (data.button === 0) {
      const tool = TOOLS[this.activeTool];

      const currentNode = this.pointer.node;
      const lastNode = this.pointer.lastNode;
      const focusedNode = this.pointer.focusedElement;

      if (tool) {
        if (data.mousedown) {
          if (currentNode && focusedNode !== currentNode) {
            const NodeType = this.getNodeType(currentNode);
            NodeType.onFocus(this, currentNode);
          }
          if (currentNode !== lastNode && focusedNode === lastNode && lastNode) {
            const NodeType = this.getNodeType(lastNode);
            NodeType.onBlur(this, lastNode);
          }

          tool.onMouseDown(this, data);
        } else if (data.mouseup) {
          tool.onMouseUp(this, data);
        } else {
          tool.onMouseDrag(this, data);
        }
      } else {
        console.error("No tool selected");
      }
    }

    // global tool
    if (data.button !== 0) {
      if (
        data.button === 1 ||
        data.button === 2 ||
        (this.pointer.moveCanvas && data.button === 0)
      ) {
        // (not mbtn 0) or (move canvas(from pressing space) and mbtn 0)
        this.moveCanvas(data.delta);
      }
    }
  }

  moveCanvas(delta) {
    this.canvas.canvas.view[0] += delta[0] / this.currentScale;
    this.canvas.canvas.view[1] += delta[1] / this.currentScale;
  }

  addSelection(node) {
    const id = node.id;
    if (!this.selection.find((n) => n.id === id)) {
      this.selection.push(node);
    }
  }

  removeSelection(node) {
    if (this.selection.indexOf(node) !== -1) {
      this.selection.splice(this.selection.indexOf(node), 1);
    }
  }

  evaluatePointerSelection() {
    for (const node of [...this.canvas.nodes]) {
      const p1 = [node.position[0], node.position[1]];
      const p2 = [node.position[0] + node.size[0], node.position[1]];
      const p3 = [node.position[0] + node.size[0], node.position[1] + node.size[1]];
      const p4 = [node.position[0], node.position[1] + node.size[1]];

      const selection = this.pointer.selection;

      let selectionP1 = this.viewToCanvas(...selection[0]);
      let selectionP2 = this.viewToCanvas(...selection[1]);

      if (selectionP1[0] > selectionP2[0]) {
        const temp = selectionP1;
        selectionP1 = selectionP2;
        selectionP2 = temp;
      }

      const check = pointsInRect([p1, p2, p3, p4], [selectionP1, selectionP2]);

      if (check) {
        this.addSelection(node);
      } else {
        this.removeSelection(node);
      }

      // check if every corner point of the node is inside the pointer selection rect
      // if true, push it to the selection
      //  also multi select notes with holding shift + click on nodes?
    }
  }

  get width() {
    return this.canvasElement.width;
  }
  get height() {
    return this.canvasElement.height;
  }

  bringNodeToFront(node) {
    const tempNode = this.canvas.nodes.splice(this.canvas.nodes.indexOf(node), 1);
    this.canvas.nodes.push(...tempNode);
  }

  setScale(scale) {
    this.canvas.canvas.scale = Math.max(0.01, scale);
  }

  hitTestNode(x, y) {
    // in canvas space
    const conv = this.viewToCanvas(x, y);
    x = conv[0];
    y = conv[1];

    const allNodes = [...this.canvas.nodes, ...this.selection];

    for (const node of allNodes.reverse()) {
      // scale corner
      const offset = this.scaleCornerSize / this.currentScale;
      this.pointer.scaleCorner = pointInRect(
        [x, y],
        [
          node.position[0] + (node.size[0] - offset),
          node.position[1] + (node.size[1] - offset),
        ],
        offset,
        offset,
      );

      // delete corner
      this.pointer.deleteCorner = pointInRect(
        [x, y],
        [node.position[0] + (node.size[0] - offset), node.position[1]],
        offset,
        offset,
      );

      if (pointInRect([x, y], node.position, node.size[0], node.size[1])) {
        return node;
      }
    }
  }

  viewToCanvas(x, y) {
    const bounds = this.getBoundingClientRect();

    // bounds
    x = x - bounds.left;
    y = y - bounds.top;

    // center
    x = x - this.width / 2;
    y = y - this.height / 2;

    // scale
    x = x / this.currentScale;
    y = y / this.currentScale;

    // offset view
    x = x - this.canvas.canvas.view[0];
    y = y - this.canvas.canvas.view[1];

    return [x, y];
  }

  canvasToView(x, y) {
    // offset view
    x = x + this.canvas.canvas.view[0];
    y = y + this.canvas.canvas.view[1];
    // scale
    x = x * this.currentScale;
    y = y * this.currentScale;
    // center
    x = x + this.width / 2;
    y = y + this.height / 2;

    return [x, y];
  }

  _drawGrid(ctxt) {
    const view = this.canvas.canvas.view;
    const maxX = (this.width + Math.abs(view[0])) / this.currentScale;
    const maxY = (this.height + Math.abs(view[1])) / this.currentScale;

    let size = this.gridSize;
    if (this.currentScale < 0.125) {
      size *= 2;
    }
    if (this.currentScale < 0.125 / 2) {
      size *= 3;
    }

    ctxt.strokeStyle = this.colors.grid_1;

    for (let x = 0; x < maxX; x += size) {
      ctxt.moveTo(x, -maxY);
      ctxt.lineTo(x, maxY);
    }
    for (let x = 0; x > -maxX; x -= size) {
      ctxt.moveTo(x, -maxY);
      ctxt.lineTo(x, maxY);
    }

    for (let y = 0; y < maxY; y += size) {
      ctxt.moveTo(-maxX, y);
      ctxt.lineTo(maxX, y);
    }
    for (let y = 0; y > -maxY; y -= size) {
      ctxt.moveTo(-maxX, y);
      ctxt.lineTo(maxX, y);
    }

    ctxt.stroke();

    // ctxt.beginPath();
    // ctxt.strokeStyle = this.colors.grid_2;
    // ctxt.moveTo(0, -maxY);
    // ctxt.lineTo(0, maxY);
    // ctxt.moveTo(-maxX, 0);
    // ctxt.lineTo(maxX, 0);

    // ctxt.stroke();
  }

  _drawUI(ctxt) {
    for (const node of this.canvas.nodes) {
      const _element = this.canvas.getNodeBlob(node);

      if (node === this.pointer.node) {
        ctxt.strokeStyle = this.colors.line_color;
        ctxt.lineWidth = 1 / this.currentScale;
        ctxt.strokeRect(node.position[0], node.position[1], node.size[0], node.size[1]);
      }

      if (this.pointer.focusedElement === node) {
        ctxt.strokeStyle = this.colors.line_color;
        ctxt.lineWidth = 1 / this.currentScale;
        ctxt.strokeRect(node.position[0], node.position[1], node.size[0], node.size[1]);

        // scale corner
        const csize = this.scaleCornerSize / this.currentScale;
        const cx = node.position[0] + node.size[0] - csize;
        const cy = node.position[1] + node.size[1] - csize;

        ctxt.globalAlpha = 0.5;
        if (this.pointer.scaleCorner || this.pointer.scaling) {
          ctxt.globalAlpha = 1;
        }

        const pad = 10 / this.currentScale;
        ctxt.lineWidth = 2 / this.currentScale;
        ctxt.beginPath();
        ctxt.moveTo(cx, cy + (csize - pad));
        ctxt.lineTo(cx + (csize - pad), cy + (csize - pad));
        ctxt.lineTo(cx + (csize - pad), cy);
        ctxt.stroke();

        ctxt.lineWidth = 2 / this.currentScale;

        ctxt.globalAlpha = 1;

        // delete corner
        ctxt.globalAlpha = 0.5;
        if (this.pointer.deleteCorner) {
          ctxt.globalAlpha = 1;
        }

        ctxt.strokeStyle = this.colors.line_color;

        const dpad = 8 / this.currentScale;
        const dcx = node.position[0] + node.size[0] - csize + dpad;
        const dcy = node.position[1] + dpad;
        ctxt.beginPath();
        ctxt.moveTo(dcx, dcy);
        ctxt.lineTo(dcx + (csize - dpad * 2), dcy + (csize - dpad * 2));
        ctxt.moveTo(dcx + (csize - dpad * 2), dcy);
        ctxt.lineTo(dcx, dcy + (csize - dpad * 2));
        ctxt.stroke();

        ctxt.globalAlpha = 1;
      }
    }

    // draw selection bounds
    ctxt.lineWidth = 1 / this.currentScale;
    const bounds = this.canvas.getNodeBounds(this.selection);

    ctxt.beginPath();
    ctxt.moveTo(bounds.minX, bounds.minY);
    ctxt.lineTo(bounds.maxX, bounds.minY);
    ctxt.lineTo(bounds.maxX, bounds.maxY);
    ctxt.lineTo(bounds.minX, bounds.maxY);
    ctxt.closePath();
    ctxt.stroke();
    ctxt.beginPath();
    ctxt.arc(bounds.originX, bounds.originY, 5 / this.currentScale, 0, Math.PI * 180);
    ctxt.stroke();

    ctxt.strokeStyle = this.colors.line_color;
    ctxt.strokeRect(bounds.minX, bounds.minY, bounds.width, bounds.height);

    // update html ui
    for (const node of this.canvas.nodes) {
      const id = node.element;
      const element = this.canvas.getNodeBlob(node);

      if (this.uiElements[id]) {
        // is text node by default
        if (this.pointer.focusedElement === node) {
          this.uiElements[id].removeAttribute("invisible");
        } else {
          this.uiElements[id].setAttribute("invisible", "");
        }
      }

      // draw ui nodes
      const uiNodeId = `node_${id}`;
      if (!this.uiElements[uiNodeId]) {
        if (element?.type in NODE_TYPES) {
          const NodeUIElement = NODE_TYPES[element.type].NodeUIElement;
          if (NodeUIElement) {
            this.uiElements[uiNodeId] = new NodeUIElement(this);
            this.uiElements[uiNodeId].setAttribute("node-id", id);
            this.shadowRoot
              .querySelector("#canvasOverlay")
              .appendChild(this.uiElements[uiNodeId]);

            this.uiElements[uiNodeId].addEventListener("change", (e) => {
              node.properties[e.key] = e.value;
            });
          }
        }
      } else {
        const ele = this.uiElements[uiNodeId];
        const pos = this.canvasToView(...node.position);
        ele.style.setProperty("--x", pos[0]);
        ele.style.setProperty("--y", pos[1]);
        ele.style.setProperty("--w", node.size[0] * this.currentScale);
        ele.style.setProperty("--h", node.size[1] * this.currentScale);
        ele.style.setProperty("--s", this.currentScale);

        ele.onDraw(node, element);
      }

      if (element?.type in NODE_TYPES) {
        const Node = NODE_TYPES[element.type];
        Node.onUiDraw(node, this);
      }

      // draw overlay elements
      if (!this.uiElements[id]) {
        if (element?.type in NODE_TYPES) {
          const OverlayElement = NODE_TYPES[element.type].OverlayElement;
          if (OverlayElement) {
            this.uiElements[id] = new OverlayElement();
            this.uiElements[id].setAttribute("node-id", id);
            this.shadowRoot
              .querySelector("#canvasOverlay")
              .appendChild(this.uiElements[id]);

            this.uiElements[id].addEventListener("change", (e) => {
              node.properties[e.key] = e.value;
            });
          }
        }
      } else {
        const ele = this.uiElements[id];
        const pos = this.canvasToView(...node.position);
        ele.style.setProperty("--x", pos[0]);
        ele.style.setProperty("--y", pos[1]);
        ele.style.setProperty("--w", node.size[0] * this.currentScale);
        ele.style.setProperty("--h", node.size[1] * this.currentScale);
        ele.style.setProperty("--s", this.currentScale);
      }
    }
  }

  getNodeUiElement(node) {
    const id = node.element;
    const uiNodeId = `node_${id}`;
    return this.uiElements[uiNodeId];
  }

  _drawPointer(ctxt) {
    ctxt.strokeStyle = this.colors.selection_border;
    ctxt.fillStyle = this.colors.selection_background;
    ctxt.lineWidth = 1;
    ctxt.beginPath();
    ctxt.moveTo(this.pointer.selection[0][0], this.pointer.selection[0][1]);
    ctxt.lineTo(this.pointer.selection[1][0], this.pointer.selection[0][1]);
    ctxt.lineTo(this.pointer.selection[1][0], this.pointer.selection[1][1]);
    ctxt.lineTo(this.pointer.selection[0][0], this.pointer.selection[1][1]);
    ctxt.closePath();
    ctxt.stroke();
    ctxt.fill();
  }

  _drawRemotePresences(ctxt) {
    for (const presence of this.remotePresences.values()) {
      const state = presence.state;
      if (state?.kind !== "canvas" || !state.pointer) {
        continue;
      }

      const color = presence.user.color ?? "#3b82f6";
      const [x, y] = this.canvasToView(state.pointer.x, state.pointer.y);

      ctxt.save();
      ctxt.fillStyle = color;
      ctxt.beginPath();
      ctxt.arc(x, y, 6, 0, Math.PI * 2);
      ctxt.fill();

      ctxt.font = "12px sans-serif";
      ctxt.textBaseline = "top";
      const label = presence.user.name;
      const width = ctxt.measureText(label).width + 12;
      ctxt.fillRect(x + 10, y - 8, width, 22);
      ctxt.fillStyle = "#111";
      ctxt.fillText(label, x + 16, y - 3);
      ctxt.restore();
    }
  }

  _drawResolutionPreview(ctxt) {
    ctxt.globalAlpha = 0.25;
    ctxt.strokeStyle = "white";
    ctxt.fillStyle = "rgb(238 238 238 / 0.5)";
    ctxt.lineWidth = 1 / this.currentScale;
    const w = 1920;
    const h = 1080;
    ctxt.fillRect(-w / 2, -h / 2, w, h);
    ctxt.strokeRect(-w / 2, -h / 2, w, h);
    ctxt.globalAlpha = 1;
  }

  draw(ctxt) {
    if (!this.canvas) return;

    this.resize();

    ctxt.save();
    ctxt.translate(this.width / 2, this.height / 2);
    ctxt.scale(this.currentScale, this.currentScale);
    ctxt.translate(this.canvas.canvas.view[0], this.canvas.canvas.view[1]);

    ctxt.lineWidth = 1 / this.currentScale;

    const drawChain = [
      // this._drawGrid.bind(this),
      (_ctxt) => {},
      () => {
        renderer.render(ctxt, this.canvas);
      },
      this._drawUI.bind(this),
    ];

    for (const f of drawChain) {
      f(ctxt);
    }

    ctxt.restore();

    this._drawRemotePresences(ctxt);

    // draw pointer selection
    this._drawPointer(ctxt);

    // drwa full frame image
    if (this.pointer.zoomImage && this.pointer.node) {
      const node = this.pointer.node;
      const element = this.canvas.getNodeBlob(node);
      if (element.image) {
        const ar = element.image.width / element.image.height;
        const size = this.height - 300;

        if (element.image.width > 0) {
          ctxt.drawImage(
            element.image,
            0,
            0,
            element.image.width,
            element.image.height,
            20,
            this.height - size / ar - 20,
            size,
            size / ar,
          );
        }
      }

      if (element?.type in NODE_TYPES) {
        const Node = NODE_TYPES[element.type];
        Node.onDraw(node, ctxt);
      }
    }
  }

  drawPreview() {
    return renderer.renderSnapshot(this.canvas);
  }

  resize() {
    this.canvasElement.width = this.clientWidth;
    this.canvasElement.height = this.clientHeight;
  }

  update() {
    this.draw(this.context);

    if (!this.pointer.selecting) {
      const node = this.hitTestNode(this.pointer.x, this.pointer.y);
      this.pointer.node = node;

      if (node) {
        this.pointer.lastNode = node;
      }
    }

    this.currentScale += (this.canvas.canvas.scale - this.currentScale) * 0.2;

    requestAnimationFrame(this.update.bind(this));

    this.render();
  }

  pickColor(x, y) {
    const data = this.context.getImageData(x, y, 1, 1);
    return data.data;
  }

  render() {
    render(
      html`
            <style>
                :host {
                    image-rendering: pixelated;
                }
                canvas {
                    position: absolute;
                    top: 0;
                    left: 0;
                    image-rendering: pixelated;
                }
                .canvas-overlay {
                    position: absolute;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    pointer-events: none;
                }
                .toolbar {
                    position: absolute;
                    bottom: 2rem;
                    left: 50%;
                    transform: translateX(-50%);
                }
            </style>

            ${this.canvasElement}

            <div class="canvas-overlay" id="canvasOverlay"></div>

            <tolbar-element class="toolbar" @change="${(e) => {
              const tool = TOOLS_MAP[e.target.activeTool];
              const index = TOOLS.indexOf(tool);
              this.setActiveTool(index);
            }}">
                <tolbar-tool value="select">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="white" width="18px" height="18px"><path d="M0 0h24v24H0z" fill="none"/><path d="M17 5h-2V3h2v2zm-2 16h2v-2.59L19.59 21 21 19.59 18.41 17H21v-2h-6v6zm4-12h2V7h-2v2zm0 4h2v-2h-2v2zm-8 8h2v-2h-2v2zM7 5h2V3H7v2zM3 17h2v-2H3v2zm2 4v-2H3c0 1.1.9 2 2 2zM19 3v2h2c0-1.1-.9-2-2-2zm-8 2h2V3h-2v2zM3 9h2V7H3v2zm4 12h2v-2H7v2zm-4-8h2v-2H3v2zm0-8h2V3c-1.1 0-2 .9-2 2z"/></svg>
                </tolbar-tool>
                <tolbar-tool value="pen">
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="white" width="18px" height="18px"><path d="M0 0h24v24H0z" fill="none"/><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
                </tolbar-tool>
            </tolbar-element>
        `,
      this.shadowRoot,
    );
  }
}

// util functions
const cursorCanvas = document.createElement("canvas");
function makeBrushCursor(r = 10) {
  const size = r * 2 + 2;
  cursorCanvas.width = size;
  cursorCanvas.height = size;
  const ctxt = cursorCanvas.getContext("2d");
  ctxt.arc(size / 2, size / 2, r, 0, Math.PI * 180);
  ctxt.shadowColor = "black";
  ctxt.shadowBlur = 1.5;
  ctxt.strokeStyle = "#eee";
  ctxt.lineWidth = 1;
  ctxt.stroke();
  return `url(${cursorCanvas.toDataURL()}) ${size / 2} ${size / 2}, auto`;
}

function makeColorPickerCursor(color = [0, 0, 0]) {
  const r = 15;
  const cssColor = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
  const padding = 5;
  cursorCanvas.width = 125;
  cursorCanvas.height = 69;
  const ctxt = cursorCanvas.getContext("2d");
  ctxt.shadowColor = "rgba(0, 0, 0, 0.25)";
  ctxt.shadowBlur = 12;

  ctxt.fillStyle = cssColor;
  ctxt.lineWidth = 1;
  ctxt.strokeStyle = "#eee";

  const size = r * 2 + 2;
  ctxt.arc(padding + size / 2, padding + size / 2, r, 0, Math.PI * 180);
  ctxt.fill();
  ctxt.stroke();

  ctxt.shadowBlur = 0;

  ctxt.fillStyle = "#fff";
  ctxt.shadowColor = "rgba(0, 0, 0, 1)";
  ctxt.shadowBlur = 1;
  ctxt.shadowOffsetX = 1;
  ctxt.shadowOffsetY = 1;

  ctxt.font = "12px Roboto";
  const lineHeight = 14;
  const x = r * 2 + 10 + padding;
  ctxt.fillText(`R ${color[0]}`, x, 10 + padding);
  ctxt.fillText(`G ${color[1]}`, x, 10 + padding + lineHeight);
  ctxt.fillText(`B ${color[2]}`, x, 10 + padding + lineHeight * 2);

  const hsl = rgbToHsl(...color);
  ctxt.fillText(`H ${hsl[0]}`, x + 40, 10 + padding);
  ctxt.fillText(`S ${hsl[1]}`, x + 40, 10 + padding + lineHeight);
  ctxt.fillText(`L ${hsl[2]}`, x + 40, 10 + padding + lineHeight * 2);

  ctxt.font = "14px sans-serif";
  ctxt.fillText(rgbToHex(...color).toLocaleUpperCase(), x, padding + 55);

  ctxt.shadowOffsetX = 0;
  ctxt.shadowOffsetY = 0;

  return `url(${cursorCanvas.toDataURL()}) ${size / 2 + padding} ${size / 2 + padding}, auto`;
}

function pointInRect(p, p2, width, height) {
  return p[0] > p2[0] && p[0] < p2[0] + width && p[1] > p2[1] && p[1] < p2[1] + height;
}

function pointsInRect(points, verts) {
  let result = true;
  for (const point of points) {
    result =
      point[0] > verts[0][0] &&
      point[0] < verts[1][0] &&
      point[1] > verts[0][1] &&
      point[1] < verts[1][1];

    if (result === false) {
      break;
    }
  }
  return result;
}

customElements.define("canvas-element", CanvasElement);
