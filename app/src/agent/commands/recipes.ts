import { defineCommand } from "just-bash";

type Recipe = {
  title: string;
  keywords: string[];
  body: string;
};

/**
 * Task-oriented recipes the agent can look up on demand, instead of carrying
 * all instructions in the system prompt. Keep each recipe short and
 * copy-paste ready.
 */
const RECIPES: Record<string, Recipe> = {
  "edit-text": {
    title: "Edit an HTML/text document by line numbers",
    keywords: ["edit", "html", "text", "line", "insert", "replace", "delete", "document"],
    body: `1. Read the document with line numbers (returns the live draft):
   vektor read <id> -n        # or: vektor current -n
2. Apply one operation per call (1-based lines, $ = end):
   vektor edit <id> insert 3 --content '<p>new paragraph</p>'   # insert before line 3
   vektor edit <id> replace 2:4 --content '<p>replacement</p>'  # replace lines 2-4
   vektor edit <id> delete 5                                    # delete line 5
   vektor edit <id> insert $ --content '<p>appended</p>'        # append at end
3. Longer content can come from a file (vektor edit <id> replace 2 fix.html) or stdin.
4. Re-read with -n after each edit — line numbers shift.
Edits merge with concurrent changes from other users — never rewrite the whole
document with 'vektor update' unless replacing everything is the goal.`,
  },
  "edit-json": {
    title: "Edit a JSON document with jq-style paths",
    keywords: ["edit", "json", "set", "unset", "push", "path", "jq"],
    body: `1. Read it first: vektor read <id>
2. Operations (paths are simplified jq; values parsed as JSON, else taken as string):
   vektor edit <id> set .config.timeout 30
   vektor edit <id> set .items[0].name "Widget"
   vektor edit <id> push .items '{"name":"new entry"}'    # append to array
   vektor edit <id> unset .items[2]                       # remove element/key
Quoted keys work too: set '.["weird key"].x' 1`,
  },
  canvas: {
    title: "Add or edit notes/shapes on a canvas document",
    keywords: ["canvas", "note", "shape", "sticky", "stroke", "board"],
    body: `Canvas documents are JSON: {version, shapes: [...], strokes: [...]}.
Each shape: {id, type: "note"|"text"|"image"|"section", x, y, width, height, text, color}.
1. Read the canvas to see existing shapes and pick a free x/y spot:
   vektor current      # or: vektor read <id>
2. Add a note (id must be unique — use a suffix like the current timestamp):
   vektor edit current push .shapes '{"id":"shape-note-1718000000","type":"note","x":300,"y":100,"width":240,"height":150,"text":"Hello","color":"#fef3c7"}'
3. Edit or remove by array index from the read output:
   vektor edit current set .shapes[2].text "updated text"
   vektor edit current unset .shapes[2]
Changes appear live for users viewing the canvas. Note colors: #fef3c7 yellow,
#dbeafe blue, #fee2e2 red, #fae8ff purple, #fff7ed orange.`,
  },
  "create-doc": {
    title: "Create a new document",
    keywords: ["create", "new", "document", "page", "title", "parent"],
    body: `Content comes from a file or stdin (HTML or Markdown):
   echo "<h1>Notes</h1><p>...</p>" | vektor create --title "Notes"
   vektor create --title "Child page" --parent <parent-document-id> page.html
   vektor create --title "My App" --type app app.html     # sandboxed HTML app
The result prints the new document id. Use --json for full metadata.`,
  },
  "find-docs": {
    title: "Find and read documents",
    keywords: ["search", "find", "list", "read", "lookup"],
    body: `   vektor list --json                       # all documents (id, title, type)
   vektor search "quarterly report" --json  # full-text search -> take id
   vektor read <id>                         # returns live draft content
   vektor read <id> > doc.html              # save to a virtual file
"this document"/"the page" means: vektor current`,
  },
  "app-doc": {
    title: "Create or update an HTML app document",
    keywords: ["app", "iframe", "html", "application", "widget"],
    body: `Type "app" documents are full HTML apps rendered in a sandboxed iframe.
Create: write complete HTML (inline CSS/JS) to a file, then:
   vektor create --title "My App" --type app app.html
Update (full rewrite is correct for apps):
   vektor update <id> app.html
For small fixes prefer line edits: vektor read <id>, then vektor edit <id> replace <n> ...`,
  },
  workflow: {
    title: "Run a workflow and check its results",
    keywords: ["workflow", "run", "status", "logs", "automation"],
    body: `   vektor workflow run <workflow-document-id> [--inputs '{"key":"value"}']
   vektor workflow status <run-id>            # poll until finished
   vektor workflow logs <run-id> [--node <node-id>]
   vektor workflow list [--document-id <id>]  # past runs`,
  },
  upload: {
    title: "Upload and share a file",
    keywords: ["upload", "share", "file", "artifact", "url", "image"],
    body: `   upload report.pdf      # prints JSON with a shareable URL
Never share sandbox file paths with the user — always upload first and share the URL.
Only include final output files in zips; exclude intermediates.`,
  },
  extension: {
    title: "Build and install an extension",
    keywords: ["extension", "plugin", "install", "manifest", "activate"],
    body: `ZIP layout: manifest.json at root + dist/ with plain ESM JS.
Minimum manifest:
   {"id":"my-ext","name":"My Extension","version":"1.0.0","entries":{"frontend":"dist/main.js"}}
IDs: lowercase alphanumeric + hyphens. Frontend entry exports activate(ctx)/deactivate(ctx);
ctx provides ctx.actions.register, ctx.suggestions.register, ctx.views.register, ctx.api.
Jobs: manifest "jobs":[{"id","name","entry","inputs","outputs"}]; entry uses worker_threads
and posts {type:"result",success:true,outputs:{...}}.
Install: zip the folder, then: extension install my-ext.zip
Only install extensions when the user explicitly asks.`,
  },
  "large-output": {
    title: "Handle output too large for one tool result",
    keywords: ["large", "output", "truncated", "pagination", "jq", "file"],
    body: `Tool output is capped at ~6000 chars. When truncated:
   command > out.json && jq '.items | length' out.json   # process from a file
For paginated APIs, loop pages and append to a file; stop when a page is empty.
Read large files in slices: sed -n '100,160p' out.json`,
  },
};

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
