#![deny(clippy::all)]

mod js_vm;
mod marshal;
mod platform;
mod sync_eval;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

use js_vm::{register_session, run_vm, send_command, unregister_session, VmCommand, VmConfig, VmEventKind};
use serde_json::Value as Json;
use sync_eval::{eval_sync, SyncGlobals};

// ─────────────────────────────────────────────────────────────────────────────
// Sync eval — the `js-exec` CLI context
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
// JS VM — jobs and workflow scripts
// ─────────────────────────────────────────────────────────────────────────────

#[napi(object)]
pub struct VmOptions {
    /// Wall-clock ceiling for the whole run. Default 15 minutes.
    pub timeout_ms: Option<u32>,
    /// Loop iterations allowed per call frame; bounds runaway loops.
    pub loop_iteration_limit: Option<u32>,
    /// Stack for the VM thread, in MiB. Default 16.
    pub stack_size_mb: Option<u32>,
}

#[napi(object)]
pub struct VmEvent {
    /// "log" | "call" | "done" | "error"
    pub r#type: String,
    /// Present on "call" — pass back to `vmResolve`/`vmReject`.
    pub call_id: Option<String>,
    /// Present on "call" — the capability name.
    pub name: Option<String>,
    /// Present on "call" — the arguments, as an array.
    pub args: Option<Json>,
    /// Present on "log" and "error".
    pub message: Option<String>,
    /// Present on "done".
    pub output: Option<Json>,
}

impl From<VmEventKind> for VmEvent {
    fn from(event: VmEventKind) -> Self {
        let mut base = VmEvent {
            r#type: String::new(),
            call_id: None,
            name: None,
            args: None,
            message: None,
            output: None,
        };
        match event {
            VmEventKind::Log { message } => {
                base.r#type = "log".to_string();
                base.message = Some(message);
            }
            VmEventKind::Call {
                call_id,
                name,
                args,
            } => {
                base.r#type = "call".to_string();
                base.call_id = Some(call_id);
                base.name = Some(name);
                base.args = Some(args);
            }
            VmEventKind::Done { output } => {
                base.r#type = "done".to_string();
                base.output = Some(output);
            }
            VmEventKind::Error { message } => {
                base.r#type = "error".to_string();
                base.message = Some(message);
            }
        }
        base
    }
}

/// Start a VM on its own OS thread and return its session id.
///
/// `onEvent` is invoked on the JS thread for every event, in order, and exactly
/// one terminal `done`/`error` event is delivered. The VM itself never runs on
/// the JS thread.
#[napi]
pub fn vm_create(
    prelude: String,
    code: String,
    inputs: Json,
    options: Option<VmOptions>,
    on_event: ThreadsafeFunction<VmEvent, (), VmEvent, Status, false>,
) -> Result<u32> {
    let options = options.unwrap_or(VmOptions {
        timeout_ms: None,
        loop_iteration_limit: None,
        stack_size_mb: None,
    });
    let defaults = VmConfig::default();
    let config = VmConfig {
        timeout_ms: options.timeout_ms.map(u64::from).unwrap_or(defaults.timeout_ms),
        loop_iteration_limit: options
            .loop_iteration_limit
            .map(u64::from)
            .unwrap_or(defaults.loop_iteration_limit),
    };
    let stack_size = options.stack_size_mb.unwrap_or(16).max(1) as usize * 1024 * 1024;

    let (id, cmd_rx) = register_session();

    let spawned = std::thread::Builder::new()
        .name(format!("vektor-vm-{id}"))
        .stack_size(stack_size)
        .spawn(move || {
            run_vm(prelude, code, inputs, config, cmd_rx, |event| {
                // A non-Ok status means JS released the callback: stop the run.
                on_event.call(event.into(), ThreadsafeFunctionCallMode::NonBlocking)
                    == Status::Ok
            });
            // The thread owns the session for its whole lifetime, so it is also
            // what retires it — including on timeout, where the host never calls
            // vmDestroy.
            unregister_session(id);
        });

    if let Err(error) = spawned {
        unregister_session(id);
        return Err(Error::new(
            Status::GenericFailure,
            format!("could not start VM thread: {error}"),
        ));
    }

    Ok(id)
}

/// Resolve a pending host call.
#[napi]
pub fn vm_resolve(id: u32, call_id: String, value: Json) {
    send_command(id, VmCommand::Resolve { call_id, value });
}

/// Reject a pending host call; the guest sees a thrown `Error`.
#[napi]
pub fn vm_reject(id: u32, call_id: String, message: String) {
    send_command(id, VmCommand::Reject { call_id, message });
}

/// Ask a VM to stop. In-flight calls reject with "cancelled" so the script can
/// unwind through its own `finally` blocks, then the run ends with an error event.
#[napi]
pub fn vm_destroy(id: u32) {
    send_command(id, VmCommand::Abort);
}
