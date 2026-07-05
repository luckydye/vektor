---
title: Run a workflow and check its results
keywords: workflow, run, status, logs, automation
---

1. Start with `run_workflow` using the workflow document ID and optional inputs.
2. Poll `get_workflow_run` with the returned run ID until it finishes.
3. Use `get_workflow_log` for all logs or pass a node ID for one node.
4. Use `list_workflow_runs` to inspect past runs, optionally filtered by document ID.
