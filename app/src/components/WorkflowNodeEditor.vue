<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import type {
  DocumentWithProperties,
  WorkflowNodeState,
  WorkflowRunStatus,
} from "../api/ApiClient.ts";
import { api } from "../api/client.ts";
import { realtimeTopics } from "../utils/realtime.ts";
import {
  buildTransform,
  createViewportControls,
  drawWorldGrid,
  type FitReference,
  type ScreenSize,
  screenToWorld,
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
const latestRunId = ref<string | null>(null);
const running = ref(false);
const saving = ref(false);
const savedAt = ref<number | null>(null);
const error = ref<string | null>(null);
const selectedNodeId = ref<string | null>(null);
const mode = ref<"idle" | "placing" | "connecting">("idle");
const camera = ref<ViewportCamera>({ centerX: 0, centerY: 0, zoom: 1 });
const screen = ref<ScreenSize>({ width: 1, height: 1 });
const pendingConnection = ref<PendingConnection | null>(null);
const activeDrag = ref<DragState | null>(null);
const uploadErrors = reactive<Record<string, string>>({});

let viewportControls: ViewportControls | null = null;
let resizeObserver: ResizeObserver | null = null;
let unsubscribeRuns: (() => void) | null = null;
let savedTimer: ReturnType<typeof setTimeout> | null = null;
let dpr = window.devicePixelRatio || 1;

const selectedNode = computed(() =>
  selectedNodeId.value ? (nodes.get(selectedNodeId.value) ?? null) : null,
);

const groupedJobs = computed(() => {
  const groups = new Map<string, AvailableJob[]>();
  for (const job of availableJobs.value) {
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
    new Map(availableJobs.value.map((job) => [`${job.extensionId}::${job.jobId}`, job])),
);

const sortedNodes = computed(() =>
  [...nodes.values()].toSorted((a, b) => a.id.localeCompare(b.id)),
);

const connectionsByNodeId = computed(() => buildNodeIoConnections());

function getLastExecutedAt(status?: WorkflowNodeState): number {
  const timestamps = [status?.startedAt, status?.completedAt].filter(
    (value): value is string => value != null,
  );
  if (timestamps.length === 0) return -1;
  return Math.max(
    ...timestamps.map((timestamp) => {
      const value = Date.parse(timestamp);
      return Number.isNaN(value) ? -1 : value;
    }),
  );
}

const retryableFailedNodeId = computed(() => {
  const failedEntries = Object.entries(runStatus.value?.nodes ?? {}).filter(
    ([, status]) => status.status === "failed",
  );
  failedEntries.sort(([leftId, leftStatus], [rightId, rightStatus]) => {
    const executedDiff = getLastExecutedAt(leftStatus) - getLastExecutedAt(rightStatus);
    if (executedDiff !== 0) return executedDiff;
    return leftId.localeCompare(rightId);
  });
  return failedEntries[0]?.[0] ?? null;
});

const agentToolOptions = computed(() =>
  availableJobs.value
    .filter((job) => !(job.extensionId === "workflow-builder" && job.jobId === "agent"))
    .map((job) => ({
      value: toolNameForJob(job),
      label: `${job.jobName} (${job.extensionName})`,
    }))
    .toSorted((a, b) => a.label.localeCompare(b.label)),
);

function transform() {
  return buildTransform(camera.value, screen.value, FIT_REFERENCE);
}

function pointerWorld(event: PointerEvent | MouseEvent) {
  const rect = viewportRef.value?.getBoundingClientRect();
  const x = event.clientX - (rect?.left ?? 0);
  const y = event.clientY - (rect?.top ?? 0);
  return screenToWorld(x, y, transform());
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
  error.value = null;
  try {
    const [doc, docs, extResult, latestRun] = await Promise.all([
      api.document.get(props.spaceId, props.documentId, { draft: true }),
      api.documents.get(props.spaceId, { limit: 500 }),
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
      latestRunId.value = latestRun.runId;
      runStatus.value = await api.workflows.getRun(props.spaceId, latestRun.runId);
    }

    await nextTick();
    resize();
    fitGraph(false);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function refreshRunStatus() {
  const latest = await api.workflows.getLatestRun(props.spaceId, props.documentId);
  if (!latest?.runId) {
    latestRunId.value = null;
    runStatus.value = null;
    return;
  }
  latestRunId.value = latest.runId;
  runStatus.value = await api.workflows.getRun(props.spaceId, latest.runId);
}

async function saveWorkflow(): Promise<boolean> {
  if (saving.value) return false;
  saving.value = true;
  error.value = null;
  savedAt.value = null;
  try {
    const content = JSON.stringify(buildDefinition(), null, 2);
    const response = await fetch(
      `/api/v1/spaces/${props.spaceId}/documents/${props.documentId}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      },
    );
    if (!response.ok) {
      throw new Error(await response.text());
    }
    const revision = await api.document.post(props.spaceId, props.documentId, {
      html: content,
      message: "Workflow saved",
    });
    const draft = await api.document.get(props.spaceId, props.documentId, {
      draft: true,
    });
    if (draft.publishedRev !== revision.rev) {
      await api.document.patch(props.spaceId, props.documentId, {
        publishedRev: revision.rev,
      });
    }
    if (title.value.trim()) {
      await api.document.patch(props.spaceId, props.documentId, {
        properties: { title: title.value.trim() },
      });
    }
    savedAt.value = Date.now();
    if (savedTimer) clearTimeout(savedTimer);
    savedTimer = setTimeout(() => {
      savedAt.value = null;
      savedTimer = null;
    }, 1800);
    return true;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    return false;
  } finally {
    saving.value = false;
  }
}

function handleSaveClick() {
  void saveWorkflow();
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
    latestRunId.value = runId;
    runStatus.value = await api.workflows.getRun(props.spaceId, runId);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    running.value = false;
  }
}

function retryFromFailure() {
  if (!latestRunId.value || !retryableFailedNodeId.value) return;
  void startRun({
    fromRunId: latestRunId.value,
    fromNodeId: retryableFailedNodeId.value,
  });
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

function setJobForNode(node: WorkflowNodeDef, value: string) {
  const job = jobsByKey.value.get(value);
  node.extensionId = job?.extensionId ?? "";
  node.jobId = job?.jobId ?? "";
  node.inputs = [];
  render();
}

function jobForNode(node: WorkflowNodeDef): AvailableJob | null {
  return jobsByKey.value.get(`${node.extensionId}::${node.jobId}`) ?? null;
}

function renameNode(node: GraphNode, nextId: string) {
  if (node.id === selectedNodeId.value) {
    renameSelectedNode(nextId);
    return;
  }

  const oldId = node.id;
  const trimmed = nextId.trim();
  if (!trimmed || trimmed === oldId || nodes.has(trimmed)) return;
  nodes.delete(oldId);
  node.id = trimmed;
  nodes.set(trimmed, node);
  edges.value = edges.value.map((edge) => {
    const source = edge.source === oldId ? trimmed : edge.source;
    const target = edge.target === oldId ? trimmed : edge.target;
    return { id: `${source}->${target}`, source, target };
  });
  render();
}

function updateNode(node: WorkflowNodeDef, update: Partial<WorkflowNodeDef>) {
  Object.assign(node, update);
  render();
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
  mappings[index] = {
    ...(mappings[index] ?? { inputKey: "", alias: "" }),
    [field]: value,
  };
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
    const result = await api.uploads.post(
      props.spaceId,
      file,
      file.name,
      props.documentId,
    );
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
  const result: Record<
    string,
    Record<string, { nodeId: string; jobName: string }[]>
  > = {};
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

function inputConnections(nodeId: string, inputKey: string) {
  return connectionsByNodeId.value[nodeId]?.[inputKey] ?? [];
}

function subJobForNode(node: WorkflowNodeDef): AvailableJob | null {
  if (node.extensionId !== "workflow-builder" || node.jobId !== "for-each-file") {
    return null;
  }
  const subJobId = getInputValue(node, "subJobId");
  if (!subJobId) return null;
  return availableJobs.value.find((job) => job.jobId === subJobId) ?? null;
}

function primaryInputEntries(node: WorkflowNodeDef): [string, JobIOField][] {
  return Object.entries(jobForNode(node)?.inputs ?? {});
}

function subJobInputEntries(node: WorkflowNodeDef): [string, JobIOField][] {
  const subJob = subJobForNode(node);
  if (!subJob?.inputs) return [];
  const inputKey = getInputValue(node, "inputKey");
  return Object.entries(subJob.inputs).filter(([key]) => key !== inputKey);
}

function outputEntries(node: WorkflowNodeDef): [string, JobIOField | null, unknown][] {
  const job = jobForNode(node);
  const statusOutputs = runStatus.value?.nodes?.[node.id]?.outputs ?? {};
  const keys = new Set<string>(Object.keys(statusOutputs));

  if (job) {
    for (const key of outputKeysForNode(node, job)) keys.add(key);
  }

  return [...keys]
    .toSorted((a, b) => a.localeCompare(b))
    .map((key) => [key, job?.outputs?.[key] ?? null, statusOutputs[key]]);
}

function parseToolSelection(value: string): Set<string> {
  const trimmed = value.trim();
  if (!trimmed) return new Set();
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return new Set(parsed.map(String));
  } catch {
    // Support older comma-separated values.
  }
  return new Set(
    trimmed
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );
}

function toggleAllowedTool(node: WorkflowNodeDef, key: string, tool: string) {
  const selected = parseToolSelection(getInputValue(node, key));
  if (selected.has(tool)) {
    selected.delete(tool);
  } else {
    selected.add(tool);
  }
  const next = [...selected];
  setInputValue(node, key, next.length ? JSON.stringify(next) : "");
}

function encodeToolSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_]/g, (char) => {
    const hex = char.charCodeAt(0).toString(16).padStart(2, "0");
    return `_x${hex}_`;
  });
}

function toolNameForJob(job: AvailableJob): string {
  return `job__${encodeToolSegment(job.extensionId)}__${encodeToolSegment(job.jobId)}`;
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
    path.setAttribute(
      "d",
      edgePath(portPosition(source, "output"), portPosition(target, "input")),
    );
    svg.appendChild(path);
  }
  if (pendingConnection.value) {
    const source = nodes.get(pendingConnection.value.from);
    if (source) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.classList.add("workflow-edge-path", "preview");
      path.setAttribute(
        "d",
        edgePath(portPosition(source, "output"), pendingConnection.value.toPointer),
      );
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
  const key = event.key.toLowerCase();
  if ((event.metaKey || event.ctrlKey) && key === "s") {
    event.preventDefault();
    void saveWorkflow();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    void startRun();
    return;
  }
  if (event.key === "Delete" || event.key === "Backspace") {
    if (selectedNodeId.value) removeNode(selectedNodeId.value);
  }
  if (key === "a") addNodeAt();
  if (key === "f") fitGraph();
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
  // Refresh from realtime run events instead of polling.
  unsubscribeRuns = api.subscribeToTopics(
    props.spaceId,
    [realtimeTopics.workflowRuns],
    () => {
      void refreshRunStatus();
    },
  );
});

onUnmounted(() => {
  viewportControls?.dispose();
  resizeObserver?.disconnect();
  window.removeEventListener("pointermove", handlePointerMove);
  window.removeEventListener("pointerup", handlePointerUp);
  window.removeEventListener("pointercancel", handlePointerUp);
  window.removeEventListener("keydown", handleKeydown);
  unsubscribeRuns?.();
  if (savedTimer) clearTimeout(savedTimer);
});
</script>

<template>
  <div class="workflow-node-editor">
    <div
      ref="viewportRef"
      class="workflow-viewport"
      @pointerdown="handleViewportPointerDown"
      @dblclick="addNodeAt(pointerWorld($event))"
    >
      <canvas ref="gridRef" class="workflow-grid"></canvas>
      <div class="workflow-canvas-actions" @pointerdown.stop @dblclick.stop>
        <button
          type="button"
          class="workflow-canvas-button"
          :disabled="saving"
          @click.stop.prevent="handleSaveClick"
        >
          {{ saving ? "Saving..." : savedAt ? "Saved" : "Save" }}
        </button>
        <button
          v-if="runStatus?.status === 'failed' && latestRunId && retryableFailedNodeId"
          type="button"
          class="workflow-canvas-button retry"
          :disabled="running"
          :title="`Restart from failed node ${retryableFailedNodeId}`"
          @click.stop="retryFromFailure"
        >
          {{ running ? "Starting..." : "Retry" }}
        </button>
      </div>
      <div v-if="error" class="workflow-error">{{ error }}</div>
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
            @dblclick.stop
          >
            <label
              class="workflow-enable-toggle"
              :title="node.disabled ? 'Enable node' : 'Disable node'"
              @pointerdown.stop
            >
              <input
                type="checkbox"
                :checked="!node.disabled"
                @change="updateNode(node, { disabled: !($event.target as HTMLInputElement).checked })"
              />
            </label>
            <button
              type="button"
              class="workflow-node-delete"
              title="Delete node"
              @pointerdown.stop
              @click.stop="removeNode(node.id)"
            >
              ×
            </button>
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
              <input
                class="workflow-node-id-input"
                :value="node.id"
                @pointerdown.stop
                @change="renameNode(node, ($event.target as HTMLInputElement).value)"
              />
              <span class="workflow-node-state">
                {{ runStatus?.nodes?.[node.id]?.status ?? "" }}
              </span>
            </div>

            <div class="workflow-node-body">
              <select
                class="workflow-input workflow-job-select"
                :value="`${node.extensionId}::${node.jobId}`"
                @pointerdown.stop
                @change="setJobForNode(node, ($event.target as HTMLSelectElement).value)"
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

              <div class="workflow-section" v-if="primaryInputEntries(node).length">
                <div class="workflow-section-title">Inputs</div>
                <div v-for="[key, meta] in primaryInputEntries(node)" :key="key" class="workflow-field">
                  <label class="workflow-field-label">
                    {{ key }}<span v-if="meta.required">*</span>
                  </label>
                  <div v-if="hasInputConnection(node.id, key)" class="workflow-connected">
                    From {{ inputConnections(node.id, key).map((connection) => connection.nodeId).join(", ") }}
                  </div>
                  <template v-else-if="node.extensionId === 'workflow-builder' && node.jobId === 'workflow-inputs' && key === 'mappings'">
                    <div
                      v-for="(mapping, index) in readWorkflowInputMappings(getInputValue(node, key))"
                      :key="index"
                      class="workflow-mapping"
                    >
                      <input
                        class="workflow-input"
                        :value="mapping.inputKey"
                        placeholder="Input key"
                        @pointerdown.stop
                        @input="updateWorkflowInputMapping(node, key, index, 'inputKey', ($event.target as HTMLInputElement).value)"
                      />
                      <input
                        class="workflow-input"
                        :value="mapping.alias"
                        placeholder="Alias"
                        @pointerdown.stop
                        @input="updateWorkflowInputMapping(node, key, index, 'alias', ($event.target as HTMLInputElement).value)"
                      />
                      <button type="button" class="workflow-mini-button" @click.stop="removeWorkflowInputMapping(node, key, index)">
                        Remove
                      </button>
                    </div>
                    <button type="button" class="workflow-mini-button" @click.stop="addWorkflowInputMapping(node, key)">
                      Add Mapping
                    </button>
                  </template>
                  <select
                    v-else-if="key === 'documentId'"
                    class="workflow-input"
                    :value="getInputValue(node, key)"
                    @pointerdown.stop
                    @change="setInputValue(node, key, ($event.target as HTMLSelectElement).value)"
                  >
                    <option value="">Select document...</option>
                    <option
                      v-for="doc in (node.extensionId === 'workflow-builder' && node.jobId === 'run-workflow' ? docRefs.filter((d) => d.type === 'workflow') : docRefs)"
                      :key="doc.id"
                      :value="doc.id"
                    >
                      {{ doc.title || doc.slug }}
                    </option>
                  </select>
                  <div v-else-if="key === 'allowedTools'" class="workflow-tool-list">
                    <label
                      v-for="tool in agentToolOptions"
                      :key="tool.value"
                      class="workflow-tool-option"
                      @pointerdown.stop
                    >
                      <input
                        type="checkbox"
                        :checked="parseToolSelection(getInputValue(node, key)).has(tool.value)"
                        @change="toggleAllowedTool(node, key, tool.value)"
                      />
                      <span>{{ tool.label }}</span>
                    </label>
                  </div>
                  <select
                    v-else-if="key === 'subJobId'"
                    class="workflow-input"
                    :value="getInputValue(node, key)"
                    @pointerdown.stop
                    @change="setInputValue(node, key, ($event.target as HTMLSelectElement).value)"
                  >
                    <option value="">Select sub-job...</option>
                    <option
                      v-for="job in availableJobs"
                      :key="`${job.extensionId}::${job.jobId}`"
                      :value="job.jobId"
                    >
                      {{ job.jobName }} ({{ job.extensionName }})
                    </option>
                  </select>
                  <select
                    v-else-if="key === 'inputKey' && subJobForNode(node)?.inputs"
                    class="workflow-input"
                    :value="getInputValue(node, key)"
                    @pointerdown.stop
                    @change="setInputValue(node, key, ($event.target as HTMLSelectElement).value)"
                  >
                    <option value="">Select sub-job input...</option>
                    <option
                      v-for="inputName in Object.keys(subJobForNode(node)?.inputs ?? {})"
                      :key="inputName"
                      :value="inputName"
                    >
                      {{ inputName }}
                    </option>
                  </select>
                  <select
                    v-else-if="meta.options?.length"
                    class="workflow-input"
                    :value="getInputValue(node, key)"
                    @pointerdown.stop
                    @change="setInputValue(node, key, ($event.target as HTMLSelectElement).value)"
                  >
                    <option value="">Select...</option>
                    <option v-for="option in meta.options" :key="option" :value="option">
                      {{ option }}
                    </option>
                  </select>
                  <label v-else-if="meta.type === 'boolean'" class="workflow-toggle" @pointerdown.stop>
                    <input
                      type="checkbox"
                      :checked="getInputValue(node, key) === 'true'"
                      @change="setInputValue(node, key, String(($event.target as HTMLInputElement).checked))"
                    />
                    <span>{{ getInputValue(node, key) === "true" ? "True" : "False" }}</span>
                  </label>
                  <div v-else-if="meta.type === 'file'" class="workflow-file-control">
                    <input
                      class="workflow-input"
                      :value="getInputValue(node, key)"
                      placeholder="File URL"
                      @pointerdown.stop
                      @input="setInputValue(node, key, ($event.target as HTMLInputElement).value)"
                    />
                    <label class="workflow-mini-button" @pointerdown.stop>
                      Upload
                      <input type="file" hidden @change="uploadFile(node.id, key, $event)" />
                    </label>
                    <small v-if="uploadErrors[`${node.id}:${key}`]" class="workflow-upload-error">
                      {{ uploadErrors[`${node.id}:${key}`] }}
                    </small>
                  </div>
                  <textarea
                    v-else-if="meta.type === 'object'"
                    class="workflow-textarea"
                    :value="getInputValue(node, key)"
                    :placeholder="meta.description || meta.type"
                    @pointerdown.stop
                    @input="setInputValue(node, key, ($event.target as HTMLTextAreaElement).value)"
                  />
                  <input
                    v-else
                    class="workflow-input"
                    :value="getInputValue(node, key)"
                    :placeholder="meta.description || meta.type"
                    @pointerdown.stop
                    @input="setInputValue(node, key, ($event.target as HTMLInputElement).value)"
                  />
                </div>
              </div>

              <div class="workflow-section" v-if="subJobInputEntries(node).length">
                <div class="workflow-section-title">{{ subJobForNode(node)?.jobName }} Inputs</div>
                <div v-for="[key, meta] in subJobInputEntries(node)" :key="key" class="workflow-field">
                  <label class="workflow-field-label">
                    {{ key }}<span v-if="meta.required">*</span>
                  </label>
                  <div v-if="hasInputConnection(node.id, key)" class="workflow-connected">
                    From {{ inputConnections(node.id, key).map((connection) => connection.nodeId).join(", ") }}
                  </div>
                  <select
                    v-else-if="meta.options?.length"
                    class="workflow-input"
                    :value="getInputValue(node, key)"
                    @pointerdown.stop
                    @change="setInputValue(node, key, ($event.target as HTMLSelectElement).value)"
                  >
                    <option value="">Select...</option>
                    <option v-for="option in meta.options" :key="option" :value="option">
                      {{ option }}
                    </option>
                  </select>
                  <label v-else-if="meta.type === 'boolean'" class="workflow-toggle" @pointerdown.stop>
                    <input
                      type="checkbox"
                      :checked="getInputValue(node, key) === 'true'"
                      @change="setInputValue(node, key, String(($event.target as HTMLInputElement).checked))"
                    />
                    <span>{{ getInputValue(node, key) === "true" ? "True" : "False" }}</span>
                  </label>
                  <input
                    v-else
                    class="workflow-input"
                    :value="getInputValue(node, key)"
                    :placeholder="meta.description || meta.type"
                    @pointerdown.stop
                    @input="setInputValue(node, key, ($event.target as HTMLInputElement).value)"
                  />
                </div>
              </div>

              <div class="workflow-section" v-if="outputEntries(node).length">
                <div class="workflow-section-title">Outputs</div>
                <div v-for="[key, meta, value] in outputEntries(node)" :key="key" class="workflow-output-row">
                  <span class="workflow-output-key">{{ key }}</span>
                  <span class="workflow-output-value">
                    {{ value == null ? (meta?.type ?? "text") : outputValueText(value).slice(0, 300) }}
                  </span>
                </div>
              </div>

              <div v-if="runStatus?.nodes?.[node.id]" class="workflow-run-card">
                <strong>{{ runStatus.nodes[node.id].status }}</strong>
                <p v-if="runStatus.nodes[node.id].error">{{ runStatus.nodes[node.id].error }}</p>
                <pre v-if="runStatus.nodes[node.id].logs?.length">{{ runStatus.nodes[node.id].logs?.join('\n') }}</pre>
              </div>
            </div>
          </article>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.workflow-node-editor {
  height: 100%;
  min-height: 0;
  background: #eef2f7;
  color: #111827;
}

.workflow-viewport {
  position: relative;
  width: 100%;
  height: 100%;
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

.workflow-canvas-actions {
  position: absolute;
  top: 12px;
  left: 12px;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 8px;
}

.workflow-canvas-button {
  border: 1px solid #d1d5db;
  border-radius: 7px;
  background: #ffffff;
  padding: 7px 12px;
  color: #374151;
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  font-weight: 650;
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.14);
}

.workflow-canvas-button:hover {
  background: #f8fafc;
}

.workflow-canvas-button.retry {
  border-color: #fcd34d;
  background: #fffbeb;
  color: #92400e;
}

.workflow-canvas-button.retry:hover {
  background: #fef3c7;
}

.workflow-canvas-button:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

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

.workflow-textarea {
  min-height: 76px;
  resize: vertical;
}

.workflow-mini-button {
  border: 1px solid #d1d5db;
  border-radius: 7px;
  background: #ffffff;
  padding: 5px 8px;
  color: #374151;
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
}

.workflow-mini-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.workflow-mini-button:hover {
  background: #f3f4f6;
}

.workflow-mini-button.danger {
  border-color: #fecaca;
  background: #fff1f2;
  color: #b91c1c;
}

.workflow-error {
  position: absolute;
  top: 52px;
  left: 12px;
  z-index: 5;
  max-width: min(520px, calc(100% - 24px));
  border: 1px solid #fecaca;
  border-radius: 7px;
  background: #fff1f2;
  padding: 8px 10px;
  color: #b91c1c;
  font-size: 13px;
  pointer-events: none;
}

.workflow-field-label {
  color: #6b7280;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.workflow-field,
.workflow-file-control,
.workflow-section,
.workflow-tool-list {
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

.workflow-enable-toggle {
  position: absolute;
  top: -8px;
  left: -8px;
  z-index: 4;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: 1px solid #cbd5e1;
  border-radius: 5px;
  background: #ffffff;
  box-shadow: 0 3px 10px rgba(15, 23, 42, 0.16);
  cursor: pointer;
}

.workflow-enable-toggle input {
  width: 12px;
  height: 12px;
  margin: 0;
  cursor: pointer;
}

.workflow-node-delete {
  position: absolute;
  top: -9px;
  right: -9px;
  z-index: 4;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: 1px solid #fecaca;
  border-radius: 999px;
  background: #fff1f2;
  color: #b91c1c;
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
  box-shadow: 0 3px 10px rgba(15, 23, 42, 0.16);
}

.workflow-node-delete:hover {
  background: #ffe4e6;
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

.workflow-node-card.status-skipped {
  border-color: #94a3b8;
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

.workflow-node-id-input {
  min-width: 0;
  max-width: 140px;
  border: 0;
  border-radius: 5px;
  background: #f1f5f9;
  padding: 3px 6px;
  color: #475569;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  outline: none;
}

.workflow-node-state {
  color: #64748b;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
}

.workflow-node-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  overflow: auto;
  user-select: text;
}

.workflow-job-select {
  font-weight: 650;
}

.workflow-section {
  border-top: 1px solid #edf0f5;
  padding-top: 10px;
}

.workflow-section-title {
  color: #94a3b8;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.workflow-tool-option {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  line-height: 1.35;
}

.workflow-output-row {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  gap: 8px;
  align-items: start;
  font-size: 12px;
}

.workflow-output-key {
  overflow: hidden;
  color: #64748b;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workflow-output-value {
  min-width: 0;
  overflow: hidden;
  color: #334155;
  overflow-wrap: anywhere;
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
.workflow-empty {
  border: 1px solid #e5e7eb;
  border-radius: 7px;
  background: #f8fafc;
  padding: 8px;
  font-size: 12px;
}

.workflow-run-card pre {
  max-height: 180px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 11px;
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
</style>
