export type EditOperation =
  | { op: "insert"; line: string; content: string }
  | { op: "replace"; range: string; content: string }
  | { op: "delete"; range: string }
  | { op: "set"; path: string; value: unknown }
  | { op: "unset"; path: string }
  | { op: "push"; path: string; value: unknown };

export type JsonPathSegment = string | number;

/** Parses a simplified jq path like `.a.b[0]["weird key"]` into segments. */
export function parseJsonPath(path: string): JsonPathSegment[] | null {
  if (!path.startsWith(".") && !path.startsWith("[")) return null;
  const segments: JsonPathSegment[] = [];
  const segmentRe = /\.([A-Za-z_$][\w$-]*)|\["((?:[^"\\]|\\.)*)"\]|\[(\d+)\]/y;
  let index = 0;
  while (index < path.length) {
    segmentRe.lastIndex = index;
    const match = segmentRe.exec(path);
    if (!match) return null;
    if (match[1] !== undefined) segments.push(match[1]);
    else if (match[2] !== undefined) segments.push(match[2].replace(/\\(.)/g, "$1"));
    else segments.push(Number(match[3]));
    index = segmentRe.lastIndex;
  }
  return segments.length > 0 ? segments : null;
}

/** Walks to the parent of the final segment. Returns null if the path doesn't resolve. */
function resolveJsonParent(
  root: unknown,
  segments: JsonPathSegment[],
): { parent: Record<string, unknown> | unknown[]; key: JsonPathSegment } | null {
  let current: unknown = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i]!;
    if (Array.isArray(current) && typeof segment === "number") {
      current = current[segment];
    } else if (current && typeof current === "object" && !Array.isArray(current)) {
      current = (current as Record<string, unknown>)[String(segment)];
    } else {
      return null;
    }
  }
  const key = segments[segments.length - 1]!;
  if (Array.isArray(current)) {
    return typeof key === "number" ? { parent: current, key } : null;
  }
  if (current && typeof current === "object") {
    return { parent: current as Record<string, unknown>, key };
  }
  return null;
}

/** Parses a 1-based line reference (`5`, `$` for the line after the last). */
function parseLineRef(ref: string, lineCount: number): number | null {
  if (ref === "$") return lineCount;
  if (!/^\d+$/.test(ref)) return null;
  const line = Number(ref);
  return line >= 1 && line <= lineCount ? line : null;
}

/** Parses `<start>[:<end>]` into a 1-based inclusive range. */
function parseLineRange(
  ref: string,
  lineCount: number,
): { start: number; end: number } | null {
  const [startRef, endRef, ...extra] = ref.split(":");
  if (extra.length > 0 || !startRef) return null;
  const start = parseLineRef(startRef, lineCount);
  if (start === null) return null;
  const end = endRef === undefined ? start : parseLineRef(endRef, lineCount);
  if (end === null || end < start) return null;
  return { start, end };
}

function splitContentLines(content: string): string[] {
  return content.replace(/\n$/, "").split("\n");
}

function applyJsonOperation(
  root: unknown,
  operation: Extract<EditOperation, { op: "set" | "unset" | "push" }>,
): void {
  const segments = parseJsonPath(operation.path);
  if (!segments) {
    throw new Error(`invalid path '${operation.path}'`);
  }
  const resolved = resolveJsonParent(root, segments);
  if (!resolved) {
    throw new Error(`path '${operation.path}' does not resolve`);
  }
  const { parent, key } = resolved;

  if (operation.op === "set") {
    if (Array.isArray(parent)) {
      if (typeof key !== "number" || key > parent.length) {
        throw new Error(`index out of bounds at '${operation.path}'`);
      }
      parent[key] = operation.value;
    } else {
      parent[String(key)] = operation.value;
    }
    return;
  }

  if (operation.op === "unset") {
    if (Array.isArray(parent)) {
      if (typeof key !== "number" || key >= parent.length) {
        throw new Error(`index out of bounds at '${operation.path}'`);
      }
      parent.splice(key, 1);
    } else if (String(key) in parent) {
      delete parent[String(key)];
    } else {
      throw new Error(`path '${operation.path}' does not resolve`);
    }
    return;
  }

  const target = Array.isArray(parent) ? parent[key as number] : parent[String(key)];
  if (!Array.isArray(target)) {
    throw new Error(`'${operation.path}' is not an array`);
  }
  target.push(operation.value);
}

/**
 * Applies edit operations to document content. Line operations treat the
 * content as plain text/HTML; json operations require the content to be valid
 * JSON. Throws an Error with a user-facing message on invalid operations.
 */
export function applyEditOperations(
  content: string,
  operations: EditOperation[],
): string {
  let current = content;

  for (const operation of operations) {
    switch (operation.op) {
      case "insert": {
        const lines = current.split("\n");
        const line = parseLineRef(operation.line, lines.length + 1);
        if (line === null) {
          throw new Error(`invalid line '${operation.line}'`);
        }
        lines.splice(line - 1, 0, ...splitContentLines(operation.content));
        current = lines.join("\n");
        break;
      }
      case "replace":
      case "delete": {
        const lines = current.split("\n");
        const range = parseLineRange(operation.range, lines.length);
        if (range === null) {
          throw new Error(`invalid range '${operation.range}'`);
        }
        const replacement =
          operation.op === "replace" ? splitContentLines(operation.content) : [];
        lines.splice(range.start - 1, range.end - range.start + 1, ...replacement);
        current = lines.join("\n");
        break;
      }
      case "set":
      case "unset":
      case "push": {
        let root: unknown;
        try {
          root = JSON.parse(current);
        } catch {
          throw new Error("document is not valid JSON");
        }
        applyJsonOperation(root, operation);
        current = JSON.stringify(root, null, 2);
        break;
      }
      default:
        throw new Error(`unknown operation '${(operation as { op: string }).op}'`);
    }
  }

  return current;
}

/** Validates a request payload into edit operations. Throws on malformed input. */
export function parseEditOperations(raw: unknown): EditOperation[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("operations must be a non-empty array");
  }

  return raw.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`operations[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    const op = record.op;

    switch (op) {
      case "insert":
        if (typeof record.line !== "string" || typeof record.content !== "string") {
          throw new Error(
            `operations[${index}]: insert requires line and content strings`,
          );
        }
        return { op, line: record.line, content: record.content };
      case "replace":
        if (typeof record.range !== "string" || typeof record.content !== "string") {
          throw new Error(
            `operations[${index}]: replace requires range and content strings`,
          );
        }
        return { op, range: record.range, content: record.content };
      case "delete":
        if (typeof record.range !== "string") {
          throw new Error(`operations[${index}]: delete requires a range string`);
        }
        return { op, range: record.range };
      case "set":
      case "push":
        if (typeof record.path !== "string" || !("value" in record)) {
          throw new Error(`operations[${index}]: ${op} requires path and value`);
        }
        return { op, path: record.path, value: record.value };
      case "unset":
        if (typeof record.path !== "string") {
          throw new Error(`operations[${index}]: unset requires a path string`);
        }
        return { op, path: record.path };
      default:
        throw new Error(`operations[${index}]: unknown op '${String(op)}'`);
    }
  });
}
