import { defineCommand } from "just-bash";

// Plain-text recipe bodies, embedded via Bun's `with { type: "text" }`.
// Kept as `.txt` rather than `.md` because Astro's ambient `*.md` module
// type treats markdown as page content (default export `AstroComponentFactory`),
// which would conflict with the plain string these imports need.
import appDocRaw from "./recipes/app-doc.txt" with { type: "text" };
import canvasRaw from "./recipes/canvas.txt" with { type: "text" };
import createDocRaw from "./recipes/create-doc.txt" with { type: "text" };
import databaseRaw from "./recipes/database.txt" with { type: "text" };
import editJsonRaw from "./recipes/edit-json.txt" with { type: "text" };
import editTextRaw from "./recipes/edit-text.txt" with { type: "text" };
import extensionRaw from "./recipes/extension.txt" with { type: "text" };
import findDocsRaw from "./recipes/find-docs.txt" with { type: "text" };
import largeOutputRaw from "./recipes/large-output.txt" with { type: "text" };
import uploadRaw from "./recipes/upload.txt" with { type: "text" };
import workflowRaw from "./recipes/workflow.txt" with { type: "text" };

export type Recipe = {
  title: string;
  keywords: string[];
  body: string;
};

function parseRecipe(raw: string): Recipe {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error("Invalid recipe format");
  const [, frontmatter, body] = match;
  const title = frontmatter?.match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const keywordsLine = frontmatter?.match(/^keywords:\s*(.+)$/m)?.[1] ?? "";
  const keywords = keywordsLine
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  return { title, keywords, body: body?.trim() };
}

const RECIPES: Record<string, Recipe> = {
  "edit-text": parseRecipe(editTextRaw),
  "edit-json": parseRecipe(editJsonRaw),
  canvas: parseRecipe(canvasRaw),
  "create-doc": parseRecipe(createDocRaw),
  database: parseRecipe(databaseRaw),
  "find-docs": parseRecipe(findDocsRaw),
  "app-doc": parseRecipe(appDocRaw),
  workflow: parseRecipe(workflowRaw),
  upload: parseRecipe(uploadRaw),
  extension: parseRecipe(extensionRaw),
  "large-output": parseRecipe(largeOutputRaw),
};

/** Returns a recipe's title + body for inlining into prompts. Null if unknown. */
export function getRecipe(name: string): Recipe | null {
  return RECIPES[name] ?? null;
}

function listRecipes(): string {
  const lines = Object.entries(RECIPES).map(
    ([name, recipe]) => `${name.padEnd(14)} ${recipe.title}`,
  );
  return `${lines.join("\n")}\n\nusage: recipes <name> | recipes search <words>\n`;
}

function searchRecipes(words: string[]): string {
  const terms = words.map((word) => word.toLowerCase()).filter(Boolean);
  const matches = Object.entries(RECIPES).filter(([name, recipe]) => {
    const haystack = [name, recipe.title.toLowerCase(), ...recipe.keywords].join(" ");
    return terms.some((term) => haystack.includes(term));
  });
  if (matches.length === 0) {
    return "";
  }
  if (matches.length === 1) {
    const [name, recipe] = matches[0]!;
    return `# ${recipe.title} (${name})\n${recipe.body}\n`;
  }
  return `${matches
    .map(([name, recipe]) => `${name.padEnd(14)} ${recipe.title}`)
    .join("\n")}\n`;
}

export function recipesCommand() {
  return defineCommand("recipes", async (args, _ctx) => {
    const [first, ...rest] = args.filter((arg) => !arg.startsWith("-"));

    if (!first || first === "list") {
      return { stdout: listRecipes(), stderr: "", exitCode: 0 };
    }

    const direct = RECIPES[first];
    if (direct) {
      return { stdout: `# ${direct.title}\n${direct.body}\n`, stderr: "", exitCode: 0 };
    }

    const terms = first === "search" ? rest : [first, ...rest];
    const result = searchRecipes(terms);
    if (result) {
      return { stdout: result, stderr: "", exitCode: 0 };
    }
    return {
      stdout: "",
      stderr: `recipes: no recipe matching '${terms.join(" ")}'\n\n${listRecipes()}`,
      exitCode: 1,
    };
  });
}
