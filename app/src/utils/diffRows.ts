export interface DiffLine {
  type: "add" | "remove" | "context" | "empty";
  content: string;
}

export interface DiffRow {
  left: DiffLine;
  right: DiffLine;
}

/**
 * Convert a unified-diff hunk's lines into side-by-side diff rows,
 * pairing removed lines on the left with added lines on the right.
 */
export function hunkLinesToRows(lines: string[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let pendingRemove: string[] = [];
  let pendingAdd: string[] = [];

  const flushPending = () => {
    const rowCount = Math.max(pendingRemove.length, pendingAdd.length);
    for (let index = 0; index < rowCount; index += 1) {
      rows.push({
        left: pendingRemove[index]
          ? { type: "remove", content: pendingRemove[index] }
          : { type: "empty", content: "" },
        right: pendingAdd[index]
          ? { type: "add", content: pendingAdd[index] }
          : { type: "empty", content: "" },
      });
    }

    pendingRemove = [];
    pendingAdd = [];
  };

  for (const line of lines) {
    const marker = line[0];
    const content = line.slice(1);

    if (marker === "-") {
      pendingRemove.push(content);
      continue;
    }

    if (marker === "+") {
      pendingAdd.push(content);
      continue;
    }

    if (marker === "\\") {
      continue;
    }

    flushPending();
    rows.push({
      left: { type: "context", content },
      right: { type: "context", content },
    });
  }

  flushPending();

  return rows;
}
