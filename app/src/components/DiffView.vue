<script setup lang="ts">
import { computed } from "vue";
import { parsePatch } from "diff";

interface DiffLine {
  type: "add" | "remove" | "context" | "empty";
  content: string;
}

interface DiffRow {
  left: DiffLine;
  right: DiffLine;
}

interface DiffHunk {
  header: string;
  rows: DiffRow[];
}

interface Props {
  patch: string;
  leftLabel?: string;
  rightLabel?: string;
}

const props = withDefaults(defineProps<Props>(), {
  leftLabel: "Base",
  rightLabel: "Revision",
});

const hunks = computed<DiffHunk[]>(() => {
  const result: DiffHunk[] = [];

  try {
    const patches = parsePatch(props.patch);

    for (const file of patches) {
      for (const hunk of file.hunks) {
        const rows: DiffRow[] = [];
        let pendingRemove: string[] = [];
        let pendingAdd: string[] = [];

        const flushPending = () => {
          const maxLength = Math.max(pendingRemove.length, pendingAdd.length);
          for (let index = 0; index < maxLength; index += 1) {
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

        for (const line of hunk.lines) {
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

        result.push({
          header: hunk.content,
          rows,
        });
      }
    }
  } catch (error) {
    console.error("Failed to parse patch:", error);
  }

  return result;
});

function lineClass(line: DiffLine) {
  if (line.type === "remove") {
    return "bg-red-50 text-red-800";
  }

  if (line.type === "add") {
    return "bg-green-50 text-green-800";
  }

  if (line.type === "empty") {
    return "bg-neutral-50 text-neutral-300";
  }

  return "text-neutral-900";
}
</script>

<template>
  <div class="space-y-4">
    <section
      v-for="(hunk, hunkIndex) in hunks"
      :key="`${hunk.header}-${hunkIndex}`"
      class="border border-neutral-200 rounded-lg overflow-hidden bg-white"
    >
      <header class="px-4 py-2 border-b border-neutral-200 bg-neutral-50">
        <code class="text-xs text-neutral-600">{{ hunk.header }}</code>
      </header>

      <div class="grid grid-cols-2 divide-x divide-neutral-200">
        <div class="px-3 py-2 text-xs font-medium uppercase tracking-wide text-neutral-500 bg-neutral-50 border-b border-neutral-200">
          {{ leftLabel }}
        </div>
        <div class="px-3 py-2 text-xs font-medium uppercase tracking-wide text-neutral-500 bg-neutral-50 border-b border-neutral-200">
          {{ rightLabel }}
        </div>
      </div>

      <div class="grid grid-cols-2 divide-x divide-neutral-200 font-mono text-sm">
        <template v-for="(row, rowIndex) in hunk.rows" :key="rowIndex">
          <div
            class="whitespace-pre-wrap break-words px-3 py-1.5 min-h-8"
            :class="lineClass(row.left)"
            v-text="row.left.content || ' '"
          ></div>
          <div
            class="whitespace-pre-wrap break-words px-3 py-1.5 min-h-8"
            :class="lineClass(row.right)"
            v-text="row.right.content || ' '"
          ></div>
        </template>
      </div>
    </section>
  </div>
</template>
