// Load the native NAPI addon.
// Bun supports require() for .node files even in ESM context.
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const native = require("./vektor-executor.node");
export const {
  evalJsSync,
  workflowVmCreate,
  workflowVmStep,
  workflowVmResolveJob,
  workflowVmRejectJob,
  workflowVmDestroy,
} = native;
