#![deny(clippy::all)]

mod marshal;
mod sync_eval;
mod workflow_vm;

use std::cell::RefCell;
use std::collections::HashMap;

use napi::bindgen_prelude::*;
use napi_derive::napi;

use serde_json::Value as Json;
use sync_eval::{SyncGlobals, eval_sync};
use workflow_vm::{VmStep, WorkflowVm};

// ─────────────────────────────────────────────────────────────────────────────
// Sync eval — replaces jsExec's QuickJS sync context
// ─────────────────────────────────────────────────────────────────────────────

#[napi(object)]
pub struct JsExecGlobals {
    pub argv: Vec<String>,
    pub cwd: String,
    pub env: Vec<Vec<String>>,
    pub platform: String,
    pub version: String,
}

#[napi(object)]
pub struct JsExecOptions {
    pub timeout_ms: Option<u32>,
    pub filename: Option<String>,
}

#[napi(object)]
pub struct JsExecResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

#[napi]
pub fn eval_js_sync(
    code: String,
    globals: JsExecGlobals,
    options: Option<JsExecOptions>,
) -> JsExecResult {
    let timeout_ms = options
        .as_ref()
        .and_then(|o| o.timeout_ms)
        .unwrap_or(10_000) as u64;
    let filename = options
        .and_then(|o| o.filename)
        .unwrap_or_else(|| "js-exec".to_string());

    let sg = SyncGlobals {
        argv: globals.argv,
        cwd: globals.cwd,
        env: globals
            .env
            .into_iter()
            .filter_map(|pair| {
                if pair.len() == 2 {
                    Some((pair[0].clone(), pair[1].clone()))
                } else {
                    None
                }
            })
            .collect(),
        platform: globals.platform,
        version: globals.version,
    };

    let result = eval_sync(code, sg, None, timeout_ms, filename);

    JsExecResult {
        stdout: result.stdout,
        stderr: result.stderr,
        exit_code: result.exit_code,
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Workflow VM — replaces workflowScript's QuickJS async context
//
// Uses a thread-local session store since WorkflowVm holds !Send Boa types.
// ─────────────────────────────────────────────────────────────────────────────

thread_local! {
    static VMS: RefCell<HashMap<u32, WorkflowVm>> = RefCell::new(HashMap::new());
    static NEXT_ID: RefCell<u32> = const { RefCell::new(0) };
}

fn next_id() -> u32 {
    NEXT_ID.with(|id| {
        let v = *id.borrow();
        *id.borrow_mut() = v.wrapping_add(1);
        v
    })
}

#[napi(object)]
pub struct WorkflowVmEvent {
    /// "done" | "error" | "log" | "pending_job" | "pending"
    pub r#type: String,
    pub output: Option<Json>,
    pub message: Option<String>,
    pub job_id: Option<String>,
    pub extension_id: Option<String>,
    pub workflow_job_id: Option<String>,
    pub inputs: Option<Json>,
}

/// Create a workflow VM and return its session ID.
#[napi]
pub fn workflow_vm_create(code: String, inputs: Json) -> Result<u32> {
    let vm = WorkflowVm::new(&code, &inputs)
        .map_err(|e| Error::new(Status::GenericFailure, e))?;
    let id = next_id();
    VMS.with(|vms| vms.borrow_mut().insert(id, vm));
    Ok(id)
}

/// Advance the VM one step. Returns an event describing what happened.
#[napi]
pub fn workflow_vm_step(id: u32) -> Result<WorkflowVmEvent> {
    VMS.with(|vms| {
        let mut map = vms.borrow_mut();
        let vm = map
            .get_mut(&id)
            .ok_or_else(|| Error::new(Status::GenericFailure, format!("VM {id} not found")))?;

        Ok(match vm.step() {
            VmStep::Done(output) => WorkflowVmEvent {
                r#type: "done".to_string(),
                output: Some(output),
                message: None,
                job_id: None,
                extension_id: None,
                workflow_job_id: None,
                inputs: None,
            },
            VmStep::Error(msg) => WorkflowVmEvent {
                r#type: "error".to_string(),
                output: None,
                message: Some(msg),
                job_id: None,
                extension_id: None,
                workflow_job_id: None,
                inputs: None,
            },
            VmStep::Log(msg) => WorkflowVmEvent {
                r#type: "log".to_string(),
                output: None,
                message: Some(msg),
                job_id: None,
                extension_id: None,
                workflow_job_id: None,
                inputs: None,
            },
            VmStep::PendingJob {
                id: job_id,
                extension_id,
                job_id: workflow_job_id,
                inputs,
            } => WorkflowVmEvent {
                r#type: "pending_job".to_string(),
                output: None,
                message: None,
                job_id: Some(job_id),
                extension_id: Some(extension_id),
                workflow_job_id: Some(workflow_job_id),
                inputs: Some(inputs),
            },
            VmStep::Pending => WorkflowVmEvent {
                r#type: "pending".to_string(),
                output: None,
                message: None,
                job_id: None,
                extension_id: None,
                workflow_job_id: None,
                inputs: None,
            },
        })
    })
}

/// Resolve a pending runJob call with a successful result.
#[napi]
pub fn workflow_vm_resolve_job(id: u32, job_id: String, result: Json) -> Result<()> {
    VMS.with(|vms| {
        let mut map = vms.borrow_mut();
        let vm = map
            .get_mut(&id)
            .ok_or_else(|| Error::new(Status::GenericFailure, format!("VM {id} not found")))?;
        vm.resolve_job(&job_id, result)
            .map_err(|e| Error::new(Status::GenericFailure, e))
    })
}

/// Reject a pending runJob call with an error message.
#[napi]
pub fn workflow_vm_reject_job(id: u32, job_id: String, error: String) -> Result<()> {
    VMS.with(|vms| {
        let mut map = vms.borrow_mut();
        let vm = map
            .get_mut(&id)
            .ok_or_else(|| Error::new(Status::GenericFailure, format!("VM {id} not found")))?;
        vm.reject_job(&job_id, &error)
            .map_err(|e| Error::new(Status::GenericFailure, e))
    })
}

/// Destroy a workflow VM session, freeing its resources.
#[napi]
pub fn workflow_vm_destroy(id: u32) {
    VMS.with(|vms| vms.borrow_mut().remove(&id));
}
