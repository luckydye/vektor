# Workflows

This document explains how to define and run workflows directly as JSON, and lists the jobs currently available in the `workflow-builder` extension.

## Workflow Document Format

A workflow is a normal document with:

- `type: "workflow"`
- `content`: a JSON string representing a workflow definition

Each top-level key in the JSON object is a node ID.

```json
{
  "node1": {
    "extensionId": "workflow-builder",
    "jobId": "read-document",
    "inputs": [{ "key": "documentId", "value": "doc_123" }],
    "depends": []
  },
  "node2": {
    "extensionId": "workflow-builder",
    "jobId": "log",
    "inputs": [{ "key": "message", "value": "Done reading" }],
    "depends": ["node1"]
  }
}
```

## Node Schema

Each node supports:

- `extensionId` (`string`, required): extension that owns the job.
- `jobId` (`string`, required): job ID from that extension manifest.
- `inputs` (`array`, required): list of `{ key, value }` input entries.
- `depends` (`string[]`, required): node IDs that must run first.
- `disabled` (`boolean`, optional): if `true`, node is skipped.
- `position` (optional): editor metadata, ignored by backend execution.

## Execution Semantics

- Nodes are executed in topological order based on `depends`.
- Cycles are rejected.
- Each dependency node's outputs are inherited by dependents as inputs.
- Typed outputs are unwrapped when inherited:
- `{ "type": "text", "value": "x" }` becomes `"x"`
- `{ "type": "file", "url": "/api/..." }` becomes the file URL string
- Explicit `inputs` on a node override inherited keys from dependencies.
- If any node fails, the run status becomes `failed` and execution stops.
- `disabled: true` nodes are marked `skipped`.

## Start And Inspect Runs

Use these endpoints:

- `POST /api/v1/spaces/:spaceId/workflows/runs` with `{ "documentId": "<workflowDocId>" }` to start a run (`202`, returns `{ runId }`).
- `GET /api/v1/spaces/:spaceId/workflows/runs/:runId` for run/node status.
- `DELETE /api/v1/spaces/:spaceId/workflows/runs/:runId` to cancel.

For API details, see `app/docs/api.md`.

## Example: Read -> Prompt -> Agent -> Create Document

```json
{
  "readSource": {
    "extensionId": "workflow-builder",
    "jobId": "read-document",
    "inputs": [{ "key": "documentId", "value": "source_doc_id" }],
    "depends": []
  },
  "readPromptTemplate": {
    "extensionId": "workflow-builder",
    "jobId": "prompt",
    "inputs": [{ "key": "documentId", "value": "prompt_template_doc_id" }],
    "depends": []
  },
  "agent": {
    "extensionId": "workflow-builder",
    "jobId": "agent",
    "inputs": [{ "key": "model", "value": "qwen/qwen3.5-397b-a17b" }],
    "depends": ["readSource", "readPromptTemplate"]
  },
  "writeNewDoc": {
    "extensionId": "workflow-builder",
    "jobId": "create-document",
    "inputs": [],
    "depends": ["agent"]
  }
}
```

How this wiring works:

- `readSource` outputs `content`.
- `readPromptTemplate` outputs `prompt`.
- `agent` receives both via inheritance (`content`, `prompt`).
- `agent` outputs `content`.
- `create-document` receives that `content` and creates a new doc.

## Available Jobs In `workflow-builder`

Source: `/Users/tihav/source/wiki-extensions/extensions/workflow-builder/manifest.json` and `src/jobs/*`.

### 1) `read-document`

- Inputs:
- `documentId` (`string`, required)
- Outputs:
- `content` (`text`)
- `documentId` (`text`)
- Notes:
- Reads a wiki document and returns its content.

### 2) `prompt`

- Inputs:
- `documentId` (`string`, required)
- Outputs:
- `prompt` (`text`)
- `documentId` (`text`)
- Notes:
- Same document read behavior as `read-document`, but output key is `prompt`.

### 3) `log`

- Inputs:
- `message` (`string`, required)
- Outputs:
- `message` (`text`)

### 4) `http-fetch`

- Inputs:
- `url` (`string`, required)
- `method` (`string`, optional, default `GET`)
- Outputs:
- `status` (`text`)
- `body` (`text`)
- `content` (`text`)

### 5) `write-document`

- Inputs:
- `documentId` (`string`, required)
- `content` (`string`, required)
- Outputs:
- `documentId` (`text`)
- Notes:
- Overwrites an existing wiki document.

### 6) `create-document`

- Inputs:
- `content` (`string`, required)
- Outputs:
- `documentId` (`text`)
- Notes:
- Creates a new document and returns its ID.

### 7) `agent`

- Inputs:
- `prompt` (`string`, required)
- `content` (`string`, optional)
- `model` (`string`, optional, default `qwen/qwen3.5-397b-a17b`)
- `allowedTools` (`string`, optional): JSON array of tool names to allow
- `debug` (`boolean`, optional): if true, skips model call and returns empty content
- Outputs:
- `content` (`text`)
- Notes:
- Tool-calling agent loop that can invoke other jobs.
- Sub-agents:
- You can run sub-agents by wiring one `agent` node into another (for example, parent agent -> child agent via inherited `prompt`/`content`).
- If you do this, constrain each layer with `allowedTools` so child agents have a narrow tool set and predictable behavior.
- Prefer explicit dependency edges and clear input keys per layer to avoid accidental prompt/content collisions.

### 8) `chat-completion`

- Inputs:
- `prompt` (`string`, required)
- `content` (`string`, optional)
- `system` (`string`, optional)
- `outputKey` (`string`, optional, default `"output"`)
- Outputs:
- `output` (`text`)
- Notes:
- Makes one non-streaming call to `POST /chat/completions`.
- Use this when you want one model response without tool calls or an agent loop.

### 9) `search-documents`

- Inputs:
- `query` (`string`, required)
- `limit` (`string`, optional, default `"10"`)
- Outputs:
- `content` (`text`): newline-formatted snippets
- `results` (`text`): JSON array string

### 10) `upload-artifact`

- Inputs:
- `content` (`string`, required)
- `filename` (`string`, required)
- Outputs:
- `file` (`file`)
- Notes:
- Uploads content and returns a file artifact object.

### 11) `html-to-markdown`

- Inputs:
- `content` (`string`, required)
- `selector` (`string`, optional): CSS selector pre-filter via `htmlq`
- Outputs:
- `content` (`text`)
- Notes:
- Uses `pandoc` for conversion.

### 12) `sitemap-download`

- Inputs:
- `content` (`string`, required): sitemap XML
- `limit` (`number`, optional): max URLs to fetch
- Outputs:
- `file` (`file`): ZIP of downloaded HTML files
- `count` (`text`)

### 13) `json-to-table`

- Inputs:
- `results` (`string`, required): JSON array string
- Outputs:
- `content` (`text`): HTML table

### 14) `for-each-file`

- Inputs:
- `file` (`file`, required): ZIP artifact URL
- `subJobId` (`string`, required): job to run for each file
- `inputKey` (`string`, required): input key on the sub-job to receive file text
- `resultsKey` (`string`, optional): output key name for the outer table output; defaults to `result`
- Any additional keys are passed through to each sub-job invocation.
- Outputs:
- `file` (`file`): ZIP of per-file results
- `count` (`text`)
- `results` (`text`): JSON table of per-file outputs
- Notes:
- Expects stored ZIP entries (works with ZIP produced by `sitemap-download`).
