<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  reactive,
  ref,
  watch,
} from "vue";
import { api } from "../api/client.ts";
import type {
  DocumentWithProperties,
  WorkflowNodeState,
  WorkflowRunStatus,
} from "../api/ApiClient.ts";
import {
  buildTransform,
  createViewportControls,
  drawWorldGrid,
  screenToWorld,
  type FitReference,
  type ScreenSize,
  type ViewportCamera,
  type ViewportControls,
} from "../viewport/index.ts";

const props = defineProps<{
  documentId: string;
  spaceId: string;
}>();

type WorkflowInput = { key: string; value: string };
type WorkflowNodeDef = {
  extensionId: string;
  jobId: string;
  inputs: WorkflowInput[];
  depends: string[];
  position?: { x: number; y: number };
  disabled?: boolean;
};
type WorkflowDef = Record<string, WorkflowNodeDef>;
type JobIOField = {
  type: string;
  required?: boolean;
  description?: string;
  options?: string[];
};
type AvailableJob = {
  extensionId: string;
  extensionName: string;
  jobId: string;
  jobName: string;
  inputs?: Record<string, JobIOField>;
  outputs?: Record<string, JobIOField>;
};
type DocRef = { id: string; slug: string; title?: string; type?: string };
type GraphNode = WorkflowNodeDef & {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
};
type GraphEdge = { id: string; source: string; target: string };
type DragState = {
  nodeId: string;
  pointerId: number;
  startPointer: { x: number; y: number };
  startNode: { x: number; y: number };
};
type PendingConnection = {
  from: string;
  toPointer: { x: number; y: number };
};
type WorkflowInputMapping = { inputKey: string; alias: string };

const FIT_REFERENCE: FitReference = { x: -1200, y: -900, width: 2400, height: 1800 };
const NODE_W = 340;
const NODE_MIN_H = 132;
const PORT_Y = 64;

const viewportRef = ref<HTMLElement | null>(null);
const gridRef = ref<HTMLCanvasElement | null>(null);
const worldContentRef = ref<HTMLElement | null>(null);
const edgeSvgRef = ref<SVGSVGElement | null>(null);

const title = ref("");
const nodes = reactive(new Map<string, GraphNode>());
const edges = ref<GraphEdge[]>([]);
const availableJobs = ref<AvailableJob[]>([]);
const docRefs = ref<DocRef[]>([]);
const runStatus = ref<WorkflowRunStatus | null>(null);
const running = ref(false);
const saving = ref(false);
const loading = ref(true);
const error = ref<string | null>(null);
const selectedNodeId = ref<string | null>(null);
const mode = ref<"idle" | "placing" | "connecting">("idle");
const search = ref("");
const camera = ref<ViewportCamera>({ centerX: 0, centerY: 0, zoom: 1 });
const screen = ref<ScreenSize>({ width: 1, height: 1 });
const pendingConnection = ref<PendingConnection | null>(null);
const activeDrag = ref<DragState | null>(null);
const uploadErrors = reactive<Record<string, string>>({});

let viewportControls: ViewportControls | null = null;
let resizeObserver: ResizeObserver | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let dpr = window.devicePixelRatio || 1;

const selectedNode = computed(() =>
  selectedNodeId.value ? nodes.get(selectedNodeId.value) ?? null : null,
);

const groupedJobs = computed(() => {
  const groups = new Map<string, AvailableJob[]>();
  const query = search.value.trim().toLowerCase();
  for (const job of availableJobs.value) {
    if (
      query &&
      !job.jobName.toLowerCase().includes(query) &&
      !job.jobId.toLowerCase().includes(query) &&
      !job.extensionName.toLowerCase().includes(query)
    ) {
      continue;
    }
    const group = groups.get(job.extensionName);
    if (group) {
      group.push(job);
    } else {
      groups.set(job.extensionName, [job]);
    }
  }
  return [...groups.entries()].map(([name, jobs]) => ({
    name,
    jobs: jobs.toSorted((a, b) => a.jobName.localeCompare(b.jobName)),
  }));
});

const jobsByKey = computed(
  () =>
    new Map(
      availableJobs.value.map((job) => [
        `${job.extensionId}::${job.jobId}`,
        job,
      ]),
    ),
);

const sortedNodes = computed(() =>
  [...nodes.values()].toSorted((a, b) => a.id.localeCompare(b.id)),
);

const selectedJob = computed(() => {
  const node = selectedNode.value;
  if (!node) return null;
  return jobsByKey.value.get(`${node.extensionId}::${node.jobId}`) ?? null;
});

const retryableFailedNodeId = computed(() => {
  const entries = Object.entries(runStatus.value?.nodes ?? {}).filter(
    ([, state]) => state.status === "failed",
  );
  if (entries.length === 0) return null;
  entries.sort(([leftId, left], [rightId, right]) => {
    const diff = getLastExecutedAt(left) - getLastExecutedAt(right);
    return diff || leftId.localeCompare(rightId);
  });
  return entries[0]?.[0] ?? null;
});

const statusText = computed(() => {
  const edgeCount = edges.value.length;
  const zoom = camera.value.zoom.toFixed(2);
  if (mode.value === "placing") return `${nodes.size} nodes, ${edgeCount} edges, click canvas to place`;
  if (mode.value === "connecting") return `${nodes.size} nodes, ${edgeCount} edges, choose an input port`;
  return `${nodes.size} nodes, ${edgeCount} edges, zoom ${zoom}`;
});

const connectionsByNodeId = computed(() => buildNodeIoConnections());

function transform() {
  return buildTransform(camera.value, screen.value, FIT_REFERENCE);
}

function pointerWorld(event: PointerEvent | MouseEvent) {
  const rect = viewportRef.value?.getBoundingClientRect();
  const x = event.clientX - (rect?.left ?? 0);
  const y = event.clientY - (rect?.top ?? 0);
  return screenToWorld(x, y, transform());
}

function getLastExecutedAt(status?: WorkflowNodeState): number {
  const timestamps = [status?.startedAt, status?.completedAt].filter(
    (value): value is string => value != null,
  );
  if (timestamps.length === 0) return -1;
  return Math.max(...timestamps.map((value) => Date.parse(value) || -1));
}

function readDefinition(content: string | null | undefined): WorkflowDef {
  if (!content) return {};
  const parsed = JSON.parse(content) as WorkflowDef;
  if (!parsed || typeof parsed !== "object") return {};
  return parsed;
}

function normalizeNode(node: WorkflowNodeDef): WorkflowNodeDef {
  if (node.extensionId !== "workflow-builder" || node.jobId !== "write-document") {
    return node;
  }
  if (node.inputs.some((input) => input.key === "type")) return node;
  return {
    ...node,
    inputs: [...node.inputs, { key: "type", value: "html" }],
  };
}

function loadDefinition(def: WorkflowDef) {
  nodes.clear();
  edges.value = [];
  let index = 0;
  for (const [id, rawNode] of Object.entries(def)) {
    const node = normalizeNode({
      extensionId: rawNode.extensionId ?? "",
      jobId: rawNode.jobId ?? "",
      inputs: Array.isArray(rawNode.inputs) ? rawNode.inputs : [],
      depends: Array.isArray(rawNode.depends) ? rawNode.depends : [],
      position: rawNode.position,
      disabled: rawNode.disabled,
    });
    nodes.set(id, {
      ...node,
      id,
      x: node.position?.x ?? index * 420,
      y: node.position?.y ?? 0,
      width: NODE_W,
      height: NODE_MIN_H,
    });
    for (const dep of node.depends) {
      edges.value.push({ id: `${dep}->${id}`, source: dep, target: id });
    }
    index += 1;
  }
  selectedNodeId.value = nodes.keys().next().value ?? null;
}

function buildDefinition(): WorkflowDef {
  const def: WorkflowDef = {};
  for (const node of nodes.values()) {
    def[node.id] = {
      extensionId: node.extensionId,
      jobId: node.jobId,
      inputs: node.inputs,
      disabled: node.disabled,
      depends: edges.value
        .filter((edge) => edge.target === node.id)
        .map((edge) => edge.source),
      position: { x: node.x, y: node.y },
    };
  }
  return def;
}

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const [doc, docs, extResult, latestRun] = await Promise.all([
      api.document.get(props.spaceId, props.documentId),
      api.documents.get(props.spaceId),
      api.extensions.get(props.spaceId),
      api.workflows.getLatestRun(props.spaceId, props.documentId),
    ]);

    title.value = String(doc.properties?.title ?? doc.slug ?? "");
    loadDefinition(readDefinition(doc.content));

    docRefs.value = (docs.documents ?? []).map((d: DocumentWithProperties) => ({
      id: d.id,
      slug: d.slug,
      title: d.properties?.title,
      type: d.type,
    }));

    const jobs: AvailableJob[] = [];
    for (const ext of extResult.extensions ?? []) {
      for (const job of ext.jobs ?? []) {
        jobs.push({
          extensionId: ext.id,
          extensionName: ext.name,
          jobId: job.id,
          jobName: job.name,
          inputs: job.inputs as Record<string, JobIOField> | undefined,
          outputs: job.outputs as Record<string, JobIOField> | undefined,
        });
      }
    }
    availableJobs.value = jobs.toSorted((a, b) => a.jobName.localeCompare(b.jobName));

    if (latestRun?.runId) {
      runStatus.value = await api.workflows.getRun(props.spaceId, latestRun.runId);
    }

    await nextTick();
    resize();
    fitGraph(false);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

async function refreshRunStatus() {
  const latest = await api.workflows.getLatestRun(props.spaceId, props.documentId);
  if (!latest?.runId) {
    runStatus.value = null;
    return;
  }
  runStatus.value = await api.workflows.getRun(props.spaceId, latest.runId);
}

async function saveWorkflow(): Promise<boolean> {
  saving.value = true;
  error.value = null;
  try {
    const response = await fetch(`/api/v1/spaces/${props.spaceId}/documents/${props.documentId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: JSON.stringify(buildDefinition(), null, 2) }),
    });
    if (!response.ok) {
      throw new Error(await response.text());
    }
    if (title.value.trim()) {
      await api.document.patch(props.spaceId, props.documentId, {
        properties: { title: title.value.trim() },
      });
    }
    return true;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    return false;
  } finally {
    saving.value = false;
  }
}

async function startRun(options?: { fromRunId?: string; fromNodeId?: string }) {
  running.value = true;
  error.value = null;
  try {
    const saved = await saveWorkflow();
    if (!saved) return;
    const { runId } = await api.workflows.startRun(
      props.spaceId,
      props.documentId,
      {},
      options,
    );
    runStatus.value = await api.workflows.getRun(props.spaceId, runId);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    running.value = false;
  }
}

async function cancelRun() {
  if (!runStatus.value?.runId) return;
  await api.workflows.cancelRun(props.spaceId, runStatus.value.runId);
  await refreshRunStatus();
}

function setMode(nextMode: typeof mode.value) {
  mode.value = nextMode;
  if (nextMode !== "connecting") pendingConnection.value = null;
  render();
}

function nextNodeId() {
  let index = nodes.size + 1;
  while (nodes.has(`node${index}`)) index += 1;
  return `node${index}`;
}

function addNodeAt(point?: { x: number; y: number }, job?: AvailableJob) {
  const id = nextNodeId();
  const position = point ?? {
    x: camera.value.centerX - NODE_W / 2,
    y: camera.value.centerY - NODE_MIN_H / 2,
  };
  nodes.set(id, {
    id,
    extensionId: job?.extensionId ?? "",
    jobId: job?.jobId ?? "",
    inputs: [],
    depends: [],
    x: position.x,
    y: position.y,
    width: NODE_W,
    height: NODE_MIN_H,
  });
  selectedNodeId.value = id;
  setMode("idle");
  render();
}

function removeNode(id: string) {
  nodes.delete(id);
  edges.value = edges.value.filter((edge) => edge.source !== id && edge.target !== id);
  if (selectedNodeId.value === id) selectedNodeId.value = null;
  render();
}

function duplicateSelectedNode() {
  const source = selectedNode.value;
  if (!source) return;
  const id = nextNodeId();
  nodes.set(id, {
    ...source,
    id,
    inputs: source.inputs.map((input) => ({ ...input })),
    x: source.x + 40,
    y: source.y + 40,
  });
  selectedNodeId.value = id;
  render();
}

function updateSelectedNode(update: Partial<WorkflowNodeDef>) {
  const node = selectedNode.value;
  if (!node) return;
  Object.assign(node, update);
  render();
}

function renameSelectedNode(nextId: string) {
  const node = selectedNode.value;
  const oldId = selectedNodeId.value;
  const trimmed = nextId.trim();
  if (!node || !oldId || !trimmed || trimmed === oldId || nodes.has(trimmed)) return;
  nodes.delete(oldId);
  node.id = trimmed;
  nodes.set(trimmed, node);
  edges.value = edges.value.map((edge) => {
    const source = edge.source === oldId ? trimmed : edge.source;
    const target = edge.target === oldId ? trimmed : edge.target;
    return { id: `${source}->${target}`, source, target };
  });
  selectedNodeId.value = trimmed;
  render();
}

function setJobForSelected(value: string) {
  const node = selectedNode.value;
  if (!node) return;
  const job = jobsByKey.value.get(value);
  updateSelectedNode({
    extensionId: job?.extensionId ?? "",
    jobId: job?.jobId ?? "",
    inputs: [],
  });
}

function getInputValue(node: WorkflowNodeDef, key: string) {
  return node.inputs.find((input) => input.key === key)?.value ?? "";
}

function setInputValue(node: WorkflowNodeDef, key: string, value: string) {
  const existing = node.inputs.find((input) => input.key === key);
  if (!value) {
    node.inputs = node.inputs.filter((input) => input.key !== key);
  } else if (existing) {
    existing.value = value;
  } else {
    node.inputs.push({ key, value });
  }
  render();
}

function readWorkflowInputMappings(value: string): WorkflowInputMapping[] {
  if (!value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as WorkflowInputMapping[];
    return Array.isArray(parsed)
      ? parsed.filter(
          (mapping) =>
            mapping &&
            typeof mapping.inputKey === "string" &&
            typeof mapping.alias === "string",
        )
      : [];
  } catch {
    return [];
  }
}

function updateWorkflowInputMapping(
  node: WorkflowNodeDef,
  key: string,
  index: number,
  field: keyof WorkflowInputMapping,
  value: string,
) {
  const mappings = readWorkflowInputMappings(getInputValue(node, key));
  mappings[index] = { ...(mappings[index] ?? { inputKey: "", alias: "" }), [field]: value };
  setInputValue(node, key, JSON.stringify(mappings));
}

function addWorkflowInputMapping(node: WorkflowNodeDef, key: string) {
  const mappings = readWorkflowInputMappings(getInputValue(node, key));
  mappings.push({ inputKey: "", alias: "" });
  setInputValue(node, key, JSON.stringify(mappings));
}

function removeWorkflowInputMapping(node: WorkflowNodeDef, key: string, index: number) {
  const mappings = readWorkflowInputMappings(getInputValue(node, key));
  mappings.splice(index, 1);
  setInputValue(node, key, mappings.length ? JSON.stringify(mappings) : "");
}

async function uploadFile(nodeId: string, key: string, event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  uploadErrors[`${nodeId}:${key}`] = "";
  try {
    const result = await api.uploads.post(props.spaceId, file, file.name, props.documentId);
    const url = typeof result?.url === "string" ? result.url : "";
    if (!url) throw new Error("Upload did not return a URL");
    const node = nodes.get(nodeId);
    if (node) setInputValue(node, key, url);
  } catch (err) {
    uploadErrors[`${nodeId}:${key}`] = err instanceof Error ? err.message : String(err);
  }
}

function outputKeysForNode(node: WorkflowNodeDef, job: AvailableJob): Set<string> {
  const outputKeys = new Set(Object.keys(job.outputs ?? {}));
  if (node.extensionId === "workflow-builder" && node.jobId === "workflow-inputs") {
    try {
      return new Set(
        readWorkflowInputMappings(getInputValue(node, "mappings")).map(
          (mapping) => mapping.alias,
        ),
      );
    } catch {
      return new Set();
    }
  }
  if (node.extensionId === "workflow-builder" && node.jobId === "read-document") {
    outputKeys.delete("content");
    outputKeys.add(getInputValue(node, "outputKey").trim() || "content");
  }
  if (node.extensionId === "workflow-builder" && node.jobId === "for-each-file") {
    outputKeys.delete("result");
    outputKeys.add(getInputValue(node, "outputKey").trim() || "result");
  }
  if (
    node.extensionId === "workflow-builder" &&
    (node.jobId === "agent" || node.jobId === "chat-completion")
  ) {
    outputKeys.delete("output");
    outputKeys.add(getInputValue(node, "outputKey").trim() || "output");
  }
  return outputKeys;
}

function inputKeysForNode(node: WorkflowNodeDef, job: AvailableJob): Set<string> {
  const inputKeys = new Set(Object.keys(job.inputs ?? {}));
  if (node.extensionId !== "workflow-builder" || node.jobId !== "for-each-file") {
    return inputKeys;
  }
  const subJobId = getInputValue(node, "subJobId");
  const inputKey = getInputValue(node, "inputKey");
  const subJob = availableJobs.value.find((candidate) => candidate.jobId === subJobId);
  for (const key of Object.keys(subJob?.inputs ?? {})) {
    if (key !== inputKey) inputKeys.add(key);
  }
  return inputKeys;
}

function buildNodeIoConnections() {
  const result: Record<string, Record<string, { nodeId: string; jobName: string }[]>> = {};
  for (const node of nodes.values()) result[node.id] = {};
  for (const edge of edges.value) {
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    if (!source || !target) continue;
    const sourceJob = jobsByKey.value.get(`${source.extensionId}::${source.jobId}`);
    const targetJob = jobsByKey.value.get(`${target.extensionId}::${target.jobId}`);
    if (!sourceJob || !targetJob) continue;
    const sourceOutputs = outputKeysForNode(source, sourceJob);
    const targetInputs = inputKeysForNode(target, targetJob);
    for (const key of sourceOutputs) {
      if (!targetInputs.has(key)) continue;
      if (!result[target.id][key]) result[target.id][key] = [];
      const bucket = result[target.id][key];
      if (!bucket.some((entry) => entry.nodeId === source.id)) {
        bucket.push({ nodeId: source.id, jobName: sourceJob.jobName });
      }
    }
  }
  return result;
}

function hasInputConnection(nodeId: string, inputKey: string) {
  return Boolean(connectionsByNodeId.value[nodeId]?.[inputKey]?.length);
}

function beginDrag(nodeId: string, event: PointerEvent) {
  const node = nodes.get(nodeId);
  if (!node) return;
  activeDrag.value = {
    nodeId,
    pointerId: event.pointerId,
    startPointer: pointerWorld(event),
    startNode: { x: node.x, y: node.y },
  };
  selectedNodeId.value = nodeId;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  event.preventDefault();
  event.stopPropagation();
  render();
}

function portPosition(node: GraphNode, port: "input" | "output") {
  return {
    x: port === "input" ? node.x : node.x + node.width,
    y: node.y + PORT_Y,
  };
}

function edgePath(from: { x: number; y: number }, to: { x: number; y: number }) {
  const tension = Math.max(90, Math.abs(to.x - from.x) * 0.5);
  return `M ${from.x} ${from.y} C ${from.x + tension} ${from.y}, ${to.x - tension} ${to.y}, ${to.x} ${to.y}`;
}

function beginConnection(nodeId: string, event: PointerEvent) {
  selectedNodeId.value = nodeId;
  pendingConnection.value = { from: nodeId, toPointer: pointerWorld(event) };
  mode.value = "connecting";
  event.preventDefault();
  event.stopPropagation();
  render();
}

function completeConnection(nodeId: string, event: PointerEvent) {
  if (!pendingConnection.value || pendingConnection.value.from === nodeId) return;
  const source = pendingConnection.value.from;
  edges.value = edges.value.filter(
    (edge) => !(edge.source === source && edge.target === nodeId),
  );
  edges.value.push({ id: `${source}->${nodeId}`, source, target: nodeId });
  pendingConnection.value = null;
  mode.value = "idle";
  event.preventDefault();
  event.stopPropagation();
  render();
}

function removeEdge(edgeId: string) {
  edges.value = edges.value.filter((edge) => edge.id !== edgeId);
  render();
}

function renderEdges() {
  const svg = edgeSvgRef.value;
  if (!svg) return;
  while (svg.firstChild) svg.firstChild.remove();
  for (const edge of edges.value) {
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    if (!source || !target) continue;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.classList.add("workflow-edge-path");
    path.setAttribute("d", edgePath(portPosition(source, "output"), portPosition(target, "input")));
    svg.appendChild(path);
  }
  if (pendingConnection.value) {
    const source = nodes.get(pendingConnection.value.from);
    if (source) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.classList.add("workflow-edge-path", "preview");
      path.setAttribute("d", edgePath(portPosition(source, "output"), pendingConnection.value.toPointer));
      svg.appendChild(path);
    }
  }
}

function render() {
  const canvas = gridRef.value;
  const context = canvas?.getContext("2d");
  const t = transform();
  if (!canvas || !context) return;

  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, screen.value.width, screen.value.height);
  drawWorldGrid(context, t, screen.value, {
    levels: [
      { size: 40, color: "rgba(15, 23, 42, 0.07)", lineWidth: 1, minScreenSpacing: 8 },
      { size: 200, color: "rgba(15, 23, 42, 0.13)", lineWidth: 1, minScreenSpacing: 24 },
    ],
  });
  if (worldContentRef.value) {
    worldContentRef.value.style.transform = `translate(${t.dx}px, ${t.dy}px) scale(${t.scale})`;
  }
  renderEdges();
}

function resize() {
  const rect = viewportRef.value?.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect?.width ?? 1));
  const height = Math.max(1, Math.round(rect?.height ?? 1));
  screen.value = { width, height };
  dpr = window.devicePixelRatio || 1;
  const canvas = gridRef.value;
  if (canvas) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }
  render();
}

function fitGraph(renderAfter = true) {
  const graphNodes = [...nodes.values()];
  if (graphNodes.length === 0) {
    camera.value = { centerX: 0, centerY: 0, zoom: 1 };
    if (renderAfter) render();
    return;
  }
  const minX = Math.min(...graphNodes.map((node) => node.x));
  const minY = Math.min(...graphNodes.map((node) => node.y));
  const maxX = Math.max(...graphNodes.map((node) => node.x + node.width));
  const maxY = Math.max(...graphNodes.map((node) => node.y + node.height));
  const graphW = Math.max(1, maxX - minX + 260);
  const graphH = Math.max(1, maxY - minY + 260);
  const fitScale = Math.min(screen.value.width / graphW, screen.value.height / graphH);
  const baseScale = Math.min(
    screen.value.width / FIT_REFERENCE.width,
    screen.value.height / FIT_REFERENCE.height,
  );
  camera.value = {
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    zoom: Math.max(0.25, Math.min(2.2, fitScale / baseScale)),
  };
  if (renderAfter) render();
}

function handleViewportPointerDown(event: PointerEvent) {
  if (mode.value === "placing") {
    addNodeAt(pointerWorld(event));
    return;
  }
  selectedNodeId.value = null;
  if (mode.value === "connecting") pendingConnection.value = null;
  mode.value = "idle";
  render();
}

function handlePointerMove(event: PointerEvent) {
  if (activeDrag.value) {
    const node = nodes.get(activeDrag.value.nodeId);
    if (!node) return;
    const world = pointerWorld(event);
    node.x = activeDrag.value.startNode.x + world.x - activeDrag.value.startPointer.x;
    node.y = activeDrag.value.startNode.y + world.y - activeDrag.value.startPointer.y;
    render();
    return;
  }
  if (pendingConnection.value) {
    pendingConnection.value.toPointer = pointerWorld(event);
    render();
  }
}

function handlePointerUp(event: PointerEvent) {
  if (activeDrag.value?.pointerId === event.pointerId) {
    activeDrag.value = null;
  }
}

function handleKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  if (target?.closest("input, textarea, select")) return;
  if (event.key === "Delete" || event.key === "Backspace") {
    if (selectedNodeId.value) removeNode(selectedNodeId.value);
  }
  if (event.key === "Escape") setMode("idle");
}

function nodeStatusClass(id: string) {
  const status = runStatus.value?.nodes?.[id]?.status;
  if (status === "running") return "status-running";
  if (status === "completed") return "status-completed";
  if (status === "failed") return "status-failed";
  if (status === "skipped") return "status-skipped";
  return "";
}

function outputValueText(value: unknown) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.value === "string") return record.value;
    if (typeof record.url === "string") return record.url;
  }
  return JSON.stringify(value);
}

watch([nodes, edges, camera, pendingConnection], () => render(), { deep: true });

onMounted(async () => {
  viewportControls = createViewportControls({
    target: viewportRef.value ?? window,
    getCamera: () => camera.value,
    setCamera: (nextCamera) => {
      camera.value = nextCamera;
      render();
    },
    getScreen: () => screen.value,
    getFit: () => FIT_REFERENCE,
    minZoom: 0.25,
    maxZoom: 3,
  });

  resizeObserver = new ResizeObserver(resize);
  if (viewportRef.value) resizeObserver.observe(viewportRef.value);
  window.addEventListener("pointermove", handlePointerMove);
  window.addEventListener("pointerup", handlePointerUp);
  window.addEventListener("pointercancel", handlePointerUp);
  window.addEventListener("keydown", handleKeydown);

  await load();
  pollTimer = setInterval(() => {
    if (runStatus.value?.status === "running" || runStatus.value?.status === "pending") {
      void refreshRunStatus();
    }
  }, 2000);
});

onUnmounted(() => {
  viewportControls?.dispose();
  resizeObserver?.disconnect();
  window.removeEventListener("pointermove", handlePointerMove);
  window.removeEventListener("pointerup", handlePointerUp);
  window.removeEventListener("pointercancel", handlePointerUp);
  window.removeEventListener("keydown", handleKeydown);
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<template>
  <div class="workflow-node-editor">
    <header class="workflow-toolbar">
      <input v-model="title" class="workflow-title-input" placeholder="Workflow name" />
      <button type="button" class="workflow-button" :disabled="saving" @click="saveWorkflow">
        {{ saving ? "Saving..." : "Save" }}
      </button>
      <button
        v-if="runStatus?.status === 'running' || runStatus?.status === 'pending'"
        type="button"
        class="workflow-button danger"
        @click="cancelRun"
      >
        Cancel
      </button>
      <button v-else type="button" class="workflow-button primary" :disabled="running" @click="startRun()">
        {{ running ? "Starting..." : "Run" }}
      </button>
      <button
        v-if="runStatus?.status === 'failed' && runStatus.runId && retryableFailedNodeId"
        type="button"
        class="workflow-button"
        :disabled="running"
        @click="startRun({ fromRunId: runStatus.runId!, fromNodeId: retryableFailedNodeId! })"
      >
        Retry
      </button>
      <button type="button" class="workflow-button" @click="addNodeAt()">Add Node</button>
      <button type="button" class="workflow-button" @click="fitGraph()">Fit</button>
    </header>

    <div v-if="error" class="workflow-error">{{ error }}</div>

    <main class="workflow-body">
      <aside class="workflow-sidebar">
        <div class="workflow-sidebar-section">
          <label class="workflow-label">Jobs</label>
          <input v-model="search" class="workflow-input" placeholder="Search jobs" />
          <div class="workflow-job-list">
            <div v-for="group in groupedJobs" :key="group.name" class="workflow-job-group">
              <div class="workflow-job-group-title">{{ group.name }}</div>
              <button
                v-for="job in group.jobs"
                :key="`${job.extensionId}::${job.jobId}`"
                type="button"
                class="workflow-job"
                @click="addNodeAt(undefined, job)"
              >
                <span>{{ job.jobName }}</span>
                <small>{{ job.jobId }}</small>
              </button>
            </div>
          </div>
        </div>

        <div v-if="selectedNode" class="workflow-sidebar-section editor-section">
          <label class="workflow-label">Selected Node</label>
          <input
            class="workflow-input"
            :value="selectedNode.id"
            @change="renameSelectedNode(($event.target as HTMLInputElement).value)"
          />
          <select
            class="workflow-input"
            :value="`${selectedNode.extensionId}::${selectedNode.jobId}`"
            @change="setJobForSelected(($event.target as HTMLSelectElement).value)"
          >
            <option value="::">Select job...</option>
            <optgroup v-for="group in groupedJobs" :key="group.name" :label="group.name">
              <option
                v-for="job in group.jobs"
                :key="`${job.extensionId}::${job.jobId}`"
                :value="`${job.extensionId}::${job.jobId}`"
              >
                {{ job.jobName }}
              </option>
            </optgroup>
          </select>

          <label class="workflow-toggle">
            <input
              type="checkbox"
              :checked="!selectedNode.disabled"
              @change="updateSelectedNode({ disabled: !($event.target as HTMLInputElement).checked })"
            />
            <span>Enabled</span>
          </label>

          <div v-if="selectedJob?.inputs" class="workflow-fields">
            <div v-for="[key, meta] in Object.entries(selectedJob.inputs)" :key="key" class="workflow-field">
              <label class="workflow-field-label">
                {{ key }}<span v-if="meta.required">*</span>
              </label>
              <div v-if="hasInputConnection(selectedNode.id, key)" class="workflow-connected">
                From
                {{
                  connectionsByNodeId[selectedNode.id][key]
                    .map((connection) => connection.nodeId)
                    .join(", ")
                }}
              </div>
              <template v-else-if="selectedNode.extensionId === 'workflow-builder' && selectedNode.jobId === 'workflow-inputs' && key === 'mappings'">
                <div
                  v-for="(mapping, index) in readWorkflowInputMappings(getInputValue(selectedNode, key))"
                  :key="index"
                  class="workflow-mapping"
                >
                  <input
                    class="workflow-input"
                    :value="mapping.inputKey"
                    placeholder="Input key"
                    @input="updateWorkflowInputMapping(selectedNode, key, index, 'inputKey', ($event.target as HTMLInputElement).value)"
                  />
                  <input
                    class="workflow-input"
                    :value="mapping.alias"
                    placeholder="Alias"
                    @input="updateWorkflowInputMapping(selectedNode, key, index, 'alias', ($event.target as HTMLInputElement).value)"
                  />
                  <button type="button" class="workflow-mini-button" @click="removeWorkflowInputMapping(selectedNode, key, index)">
                    Remove
                  </button>
                </div>
                <button type="button" class="workflow-mini-button" @click="addWorkflowInputMapping(selectedNode, key)">
                  Add Mapping
                </button>
              </template>
              <select
                v-else-if="key === 'documentId'"
                class="workflow-input"
                :value="getInputValue(selectedNode, key)"
                @change="setInputValue(selectedNode, key, ($event.target as HTMLSelectElement).value)"
              >
                <option value="">Select document...</option>
                <option
                  v-for="doc in (selectedNode.extensionId === 'workflow-builder' && selectedNode.jobId === 'run-workflow' ? docRefs.filter((d) => d.type === 'workflow') : docRefs)"
                  :key="doc.id"
                  :value="doc.id"
                >
                  {{ doc.title || doc.slug }}
                </option>
              </select>
              <select
                v-else-if="meta.options?.length"
                class="workflow-input"
                :value="getInputValue(selectedNode, key)"
                @change="setInputValue(selectedNode, key, ($event.target as HTMLSelectElement).value)"
              >
                <option value="">Select...</option>
                <option v-for="option in meta.options" :key="option" :value="option">
                  {{ option }}
                </option>
              </select>
              <label v-else-if="meta.type === 'boolean'" class="workflow-toggle">
                <input
                  type="checkbox"
                  :checked="getInputValue(selectedNode, key) === 'true'"
                  @change="setInputValue(selectedNode, key, String(($event.target as HTMLInputElement).checked))"
                />
                <span>{{ getInputValue(selectedNode, key) === "true" ? "True" : "False" }}</span>
              </label>
              <div v-else-if="meta.type === 'file'" class="workflow-file-control">
                <input
                  class="workflow-input"
                  :value="getInputValue(selectedNode, key)"
                  placeholder="File URL"
                  @input="setInputValue(selectedNode, key, ($event.target as HTMLInputElement).value)"
                />
                <label class="workflow-mini-button">
                  Upload
                  <input type="file" hidden @change="uploadFile(selectedNode.id, key, $event)" />
                </label>
                <small v-if="uploadErrors[`${selectedNode.id}:${key}`]" class="workflow-upload-error">
                  {{ uploadErrors[`${selectedNode.id}:${key}`] }}
                </small>
              </div>
              <textarea
                v-else-if="meta.type === 'object'"
                class="workflow-textarea"
                :value="getInputValue(selectedNode, key)"
                :placeholder="meta.description || meta.type"
                @input="setInputValue(selectedNode, key, ($event.target as HTMLTextAreaElement).value)"
              />
              <input
                v-else
                class="workflow-input"
                :value="getInputValue(selectedNode, key)"
                :placeholder="meta.description || meta.type"
                @input="setInputValue(selectedNode, key, ($event.target as HTMLInputElement).value)"
              />
            </div>
          </div>

          <div v-if="runStatus?.nodes?.[selectedNode.id]" class="workflow-run-card">
            <strong>{{ runStatus.nodes[selectedNode.id].status }}</strong>
            <p v-if="runStatus.nodes[selectedNode.id].error">{{ runStatus.nodes[selectedNode.id].error }}</p>
            <pre v-if="runStatus.nodes[selectedNode.id].logs?.length">{{ runStatus.nodes[selectedNode.id].logs?.join('\n') }}</pre>
          </div>

          <div class="workflow-node-actions">
            <button type="button" class="workflow-mini-button" @click="duplicateSelectedNode">Duplicate</button>
            <button type="button" class="workflow-mini-button danger" @click="removeNode(selectedNode.id)">Delete</button>
          </div>
        </div>
      </aside>

      <section class="workflow-canvas-shell">
        <div ref="viewportRef" class="workflow-viewport" @pointerdown="handleViewportPointerDown">
          <canvas ref="gridRef" class="workflow-grid"></canvas>
          <div class="workflow-world-layer">
            <div ref="worldContentRef" class="workflow-world-content">
              <svg ref="edgeSvgRef" class="workflow-edge-layer"></svg>
              <article
                v-for="node in sortedNodes"
                :key="node.id"
                class="workflow-node-card"
                :class="[
                  { selected: node.id === selectedNodeId, disabled: node.disabled },
                  nodeStatusClass(node.id),
                ]"
                :style="{
                  left: `${node.x}px`,
                  top: `${node.y}px`,
                  width: `${node.width}px`,
                  minHeight: `${node.height}px`,
                }"
                @pointerdown.stop="selectedNodeId = node.id"
              >
                <button
                  type="button"
                  class="workflow-port input"
                  title="Input"
                  @pointerdown.stop="completeConnection(node.id, $event)"
                />
                <button
                  type="button"
                  class="workflow-port output"
                  title="Output"
                  @pointerdown.stop="beginConnection(node.id, $event)"
                />
                <div class="workflow-node-header" @pointerdown="beginDrag(node.id, $event)">
                  <span class="workflow-node-id">{{ node.id }}</span>
                  <span class="workflow-node-state">{{ runStatus?.nodes?.[node.id]?.status ?? "" }}</span>
                </div>
                <div class="workflow-node-main">
                  <strong>{{ jobsByKey.get(`${node.extensionId}::${node.jobId}`)?.jobName || "Unconfigured node" }}</strong>
                  <span>{{ jobsByKey.get(`${node.extensionId}::${node.jobId}`)?.extensionName || "Select a job" }}</span>
                  <small>{{ node.inputs.length }} inputs, {{ edges.filter((edge) => edge.target === node.id).length }} dependencies</small>
                </div>
              </article>
            </div>
          </div>
        </div>
        <footer class="workflow-canvas-status">
          <span>{{ loading ? "Loading..." : statusText }}</span>
          <div class="workflow-edge-list">
            <button
              v-for="edge in edges"
              :key="edge.id"
              type="button"
              class="workflow-edge-chip"
              title="Remove dependency"
              @click="removeEdge(edge.id)"
            >
              {{ edge.source }} -> {{ edge.target }}
            </button>
          </div>
        </footer>
      </section>

      <aside class="workflow-logs">
        <div class="workflow-sidebar-section">
          <label class="workflow-label">Latest Run</label>
          <div v-if="!runStatus" class="workflow-empty">No run yet.</div>
          <template v-else>
            <div class="workflow-run-summary">
              <strong>{{ runStatus.status }}</strong>
              <span>{{ runStatus.runId }}</span>
            </div>
            <div class="workflow-log-list">
              <details v-for="[nodeId, state] in Object.entries(runStatus.nodes ?? {})" :key="nodeId">
                <summary>{{ nodeId }} · {{ state.status }}</summary>
                <p v-if="state.error" class="workflow-upload-error">{{ state.error }}</p>
                <pre v-if="state.logs?.length">{{ state.logs.join('\n') }}</pre>
                <div v-if="state.outputs" class="workflow-output-list">
                  <div v-for="[key, value] in Object.entries(state.outputs)" :key="key">
                    <strong>{{ key }}</strong>
                    <span>{{ outputValueText(value).slice(0, 220) }}</span>
                  </div>
                </div>
              </details>
            </div>
          </template>
        </div>
      </aside>
    </main>
  </div>
</template>

<style scoped>
.workflow-node-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: #f8fafc;
  color: #111827;
}

.workflow-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px;
  border-bottom: 1px solid #e5e7eb;
  background: #ffffff;
}

.workflow-title-input,
.workflow-input,
.workflow-textarea {
  width: 100%;
  min-width: 0;
  border: 1px solid #d1d5db;
  border-radius: 7px;
  background: #ffffff;
  padding: 7px 9px;
  font: inherit;
  font-size: 13px;
}

.workflow-title-input {
  flex: 1 1 220px;
  font-weight: 600;
}

.workflow-textarea {
  min-height: 76px;
  resize: vertical;
}

.workflow-button,
.workflow-mini-button {
  border: 1px solid #d1d5db;
  border-radius: 7px;
  background: #ffffff;
  padding: 7px 10px;
  color: #374151;
  cursor: pointer;
  font-size: 13px;
  white-space: nowrap;
}

.workflow-mini-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  font-size: 12px;
}

.workflow-button:hover,
.workflow-mini-button:hover {
  background: #f3f4f6;
}

.workflow-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.workflow-button.primary {
  border-color: #2563eb;
  background: #2563eb;
  color: #ffffff;
}

.workflow-button.danger,
.workflow-mini-button.danger {
  border-color: #fecaca;
  background: #fff1f2;
  color: #b91c1c;
}

.workflow-error {
  margin: 8px 10px 0;
  border: 1px solid #fecaca;
  border-radius: 7px;
  background: #fff1f2;
  padding: 8px 10px;
  color: #b91c1c;
  font-size: 13px;
}

.workflow-body {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr) 260px;
  min-height: 0;
  flex: 1;
}

.workflow-sidebar,
.workflow-logs {
  min-height: 0;
  overflow: auto;
  border-right: 1px solid #e5e7eb;
  background: #ffffff;
}

.workflow-logs {
  border-right: 0;
  border-left: 1px solid #e5e7eb;
}

.workflow-sidebar-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
}

.editor-section {
  border-top: 1px solid #e5e7eb;
}

.workflow-label,
.workflow-field-label {
  color: #6b7280;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.workflow-job-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.workflow-job-group-title {
  margin-bottom: 4px;
  color: #9ca3af;
  font-size: 11px;
  font-weight: 700;
}

.workflow-job {
  display: flex;
  width: 100%;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  border: 1px solid #e5e7eb;
  border-radius: 7px;
  background: #ffffff;
  padding: 8px;
  text-align: left;
  cursor: pointer;
}

.workflow-job:hover {
  border-color: #bfdbfe;
  background: #eff6ff;
}

.workflow-job small,
.workflow-node-main span,
.workflow-node-main small,
.workflow-run-summary span {
  color: #6b7280;
  font-size: 12px;
}

.workflow-fields,
.workflow-field,
.workflow-file-control,
.workflow-node-actions,
.workflow-log-list,
.workflow-output-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.workflow-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.workflow-connected {
  border-radius: 7px;
  background: #eff6ff;
  padding: 7px 9px;
  color: #1d4ed8;
  font-size: 12px;
}

.workflow-mapping {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  gap: 6px;
}

.workflow-upload-error {
  color: #dc2626;
  font-size: 12px;
}

.workflow-canvas-shell {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
}

.workflow-viewport {
  position: relative;
  min-height: 0;
  flex: 1;
  overflow: hidden;
  background: #eef2f7;
  touch-action: none;
}

.workflow-grid {
  position: absolute;
  inset: 0;
  display: block;
  pointer-events: none;
}

.workflow-canvas-status {
  display: flex;
  min-height: 40px;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border-top: 1px solid #e5e7eb;
  background: #ffffff;
  padding: 7px 10px;
  color: #64748b;
  font-size: 12px;
}

.workflow-edge-list {
  display: flex;
  overflow: auto;
  gap: 6px;
}

.workflow-edge-chip {
  border: 1px solid #e5e7eb;
  border-radius: 999px;
  background: #f8fafc;
  padding: 3px 8px;
  color: #475569;
  cursor: pointer;
  font-size: 11px;
  white-space: nowrap;
}

.workflow-node-card {
  position: absolute;
  z-index: 2;
  overflow: visible;
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  background: #ffffff;
  box-shadow: 0 12px 28px rgba(15, 23, 42, 0.14);
  pointer-events: auto;
  user-select: none;
}

.workflow-node-card.selected {
  border-color: #2563eb;
  box-shadow:
    0 0 0 3px rgba(37, 99, 235, 0.16),
    0 12px 28px rgba(15, 23, 42, 0.14);
}

.workflow-node-card.disabled {
  opacity: 0.55;
}

.workflow-node-card.status-running {
  border-color: #f59e0b;
}

.workflow-node-card.status-completed {
  border-color: #22c55e;
}

.workflow-node-card.status-failed {
  border-color: #ef4444;
}

.workflow-node-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border-bottom: 1px solid #e5e7eb;
  padding: 10px 12px;
  cursor: grab;
}

.workflow-node-id {
  border-radius: 5px;
  background: #f1f5f9;
  padding: 3px 6px;
  color: #475569;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
}

.workflow-node-state {
  color: #64748b;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
}

.workflow-node-main {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px;
}

.workflow-port {
  position: absolute;
  top: 57px;
  z-index: 3;
  width: 14px;
  height: 14px;
  border: 2px solid #64748b;
  border-radius: 999px;
  background: #ffffff;
  cursor: crosshair;
}

.workflow-port.input {
  left: -7px;
}

.workflow-port.output {
  right: -7px;
  border-color: #2563eb;
}

.workflow-port:hover {
  background: #2563eb;
  border-color: #bfdbfe;
}

.workflow-run-card,
.workflow-run-summary,
.workflow-empty {
  border: 1px solid #e5e7eb;
  border-radius: 7px;
  background: #f8fafc;
  padding: 8px;
  font-size: 12px;
}

.workflow-run-card pre,
.workflow-log-list pre {
  max-height: 180px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 11px;
}

.workflow-log-list details {
  border: 1px solid #e5e7eb;
  border-radius: 7px;
  background: #ffffff;
  padding: 8px;
  font-size: 12px;
}

.workflow-output-list > div {
  display: grid;
  gap: 2px;
}

.workflow-world-layer {
  position: absolute;
  inset: 0;
  z-index: 1;
  overflow: hidden;
  pointer-events: none;
}

.workflow-world-content {
  position: absolute;
  left: 0;
  top: 0;
  width: 0;
  height: 0;
  transform-origin: 0 0;
  will-change: transform;
  pointer-events: none;
}

.workflow-edge-layer {
  position: absolute;
  left: 0;
  top: 0;
  width: 1px;
  height: 1px;
  overflow: visible;
  pointer-events: none;
}

:deep(.workflow-edge-path) {
  fill: none;
  stroke: #64748b;
  stroke-width: 3;
  vector-effect: non-scaling-stroke;
}

:deep(.workflow-edge-path.preview) {
  stroke: #2563eb;
  stroke-dasharray: 6 6;
}

/* Keep the generated SVG path selectors available when paths are created by JS. */
:global(.workflow-edge-path) {
  fill: none;
  stroke: #64748b;
  stroke-width: 3;
  vector-effect: non-scaling-stroke;
}

:global(.workflow-edge-path.preview) {
  stroke: #2563eb;
  stroke-dasharray: 6 6;
}

@media (max-width: 1050px) {
  .workflow-body {
    grid-template-columns: 220px minmax(0, 1fr);
  }

  .workflow-logs {
    display: none;
  }
}
</style>
