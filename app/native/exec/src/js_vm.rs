//! The JS VM used for both extension jobs and workflow scripts.
//!
//! ## Threading
//!
//! Boa's `Gc` types are `!Send`, so a `Context` can never leave the thread that
//! created it. Each VM therefore owns a dedicated OS thread: the context is
//! built *on* that thread and never crosses back. What crosses are plain values —
//! commands in over an mpsc channel, events out through a napi threadsafe
//! function. Nothing about a VM's execution touches the JS main thread, which is
//! the point: a CPU-bound job must never stall the server event loop.
//!
//! ## Host calls
//!
//! The VM exposes exactly one primitive to guest code:
//!
//! ```js
//! __hostCall(name, ...args) -> Promise<result>
//! ```
//!
//! Everything a job can do — `fetch`, `log`, `uploadArtifact`, `runJob`, even
//! `setTimeout` — is built on it in the JS prelude. Adding a capability is a TS
//! change; this file does not care what the names mean. That keeps the trusted
//! Rust surface tiny and makes the capability set deny-by-default: a name the
//! host does not implement simply rejects.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use boa_engine::{
    builtins::promise::{PromiseState, ResolvingFunctions},
    js_string,
    object::builtins::{JsPromise, JsUint8Array},
    property::Attribute,
    vm::RuntimeLimits,
    Context, JsError, JsNativeError, JsValue, NativeFunction, Source,
};
use boa_gc::{Finalize, Gc, GcRefCell, Trace};
use serde_json::Value as Json;

use crate::marshal::{base64_decode, base64_encode, js_to_json, json_to_js, read_bytes};

/// Default wall-clock ceiling for one VM (15 minutes), matching the previous
/// job timeout.
const DEFAULT_TIMEOUT_MS: u64 = 15 * 60 * 1000;
/// Loop iterations allowed per call frame. Boa counts back-edges per frame, so
/// this is a per-function budget, not a whole-program one. Well above anything
/// real job code reaches (that would already be minutes of interpreter time),
/// low enough that `while (true) {}` aborts in a few seconds instead of running
/// to the wall-clock deadline.
const DEFAULT_LOOP_ITERATION_LIMIT: u64 = 50_000_000;

// ─────────────────────────────────────────────────────────────────────────────
// Cross-thread protocol
// ─────────────────────────────────────────────────────────────────────────────

/// Host → VM. Sent from the JS thread, applied on the VM thread.
pub enum VmCommand {
    Resolve { call_id: String, value: Json },
    Reject { call_id: String, message: String },
    Abort,
}

/// VM → host. Delivered to JS through the threadsafe function.
pub enum VmEventKind {
    Log { message: String },
    Call {
        call_id: String,
        name: String,
        args: Json,
    },
    Done { output: Json },
    Error { message: String },
}

pub struct VmConfig {
    pub timeout_ms: u64,
    pub loop_iteration_limit: u64,
}

impl Default for VmConfig {
    fn default() -> Self {
        Self {
            timeout_ms: DEFAULT_TIMEOUT_MS,
            loop_iteration_limit: DEFAULT_LOOP_ITERATION_LIMIT,
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Session registry
// ─────────────────────────────────────────────────────────────────────────────

/// Only the command sender is shared, so the registry stays `Send` even though
/// the VM state behind it is not.
struct Session {
    cmd_tx: Sender<VmCommand>,
}

fn sessions() -> &'static Mutex<HashMap<u32, Session>> {
    static SESSIONS: OnceLock<Mutex<HashMap<u32, Session>>> = OnceLock::new();
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_id() -> u32 {
    static NEXT: AtomicU32 = AtomicU32::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

/// Register a VM and hand back its id plus the receiving end for its thread.
pub fn register_session() -> (u32, Receiver<VmCommand>) {
    let (cmd_tx, cmd_rx) = mpsc::channel();
    let id = next_id();
    sessions()
        .lock()
        .expect("session registry poisoned")
        .insert(id, Session { cmd_tx });
    (id, cmd_rx)
}

pub fn unregister_session(id: u32) {
    sessions()
        .lock()
        .expect("session registry poisoned")
        .remove(&id);
}

/// Send a command to a VM. A missing session is not an error: commands race
/// against normal completion (a job resolving just after the script threw), and
/// the VM thread is authoritative about its own lifetime.
pub fn send_command(id: u32, command: VmCommand) {
    let registry = sessions().lock().expect("session registry poisoned");
    if let Some(session) = registry.get(&id) {
        let _ = session.cmd_tx.send(command);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pending host call
// ─────────────────────────────────────────────────────────────────────────────

/// A `__hostCall` that guest code is awaiting. Lives in a `Gc` cell because the
/// native closure that creates it is GC-traced.
#[derive(Trace, Finalize)]
struct PendingCall {
    call_id: String,
    name: String,
    /// Serialized so `serde_json::Value` need not implement `Trace`.
    args_json: String,
    /// `Option` so it can be `take()`n without moving out of a `Drop` type.
    resolvers: Option<ResolvingFunctions>,
}

// ─────────────────────────────────────────────────────────────────────────────
// VM
// ─────────────────────────────────────────────────────────────────────────────

struct Vm {
    context: Context,
    top_promise: Option<JsPromise>,
    logs: Gc<GcRefCell<VecDeque<String>>>,
    pending: Gc<GcRefCell<VecDeque<PendingCall>>>,
    /// Calls handed to the host, awaiting a resolve/reject command.
    in_flight: HashMap<String, ResolvingFunctions>,
}

impl Vm {
    fn new(prelude: &str, code: &str, inputs: &Json, config: &VmConfig) -> Result<Self, String> {
        let logs: Gc<GcRefCell<VecDeque<String>>> = Gc::new(GcRefCell::new(VecDeque::new()));
        let pending: Gc<GcRefCell<VecDeque<PendingCall>>> =
            Gc::new(GcRefCell::new(VecDeque::new()));
        let counter: Gc<GcRefCell<u64>> = Gc::new(GcRefCell::new(0));

        let mut context = Context::default();

        // Platform primitives Boa lacks (URL, crypto, structuredClone) come from
        // the engine, not from the JS prelude — they are runtime, not capability.
        crate::platform::register(&mut context)?;

        let mut limits = RuntimeLimits::default();
        limits.set_loop_iteration_limit(config.loop_iteration_limit);
        context.set_runtime_limits(limits);

        // ── __hostCall(name, ...args) → Promise ──────────────────────────────
        // Safety: the closure body captures nothing from this scope; every GC
        // value it touches is passed as an explicit traced capture.
        let pending_cap = pending.clone();
        let counter_cap = counter.clone();
        let host_call = unsafe {
            NativeFunction::from_closure_with_captures(
                |_, args, (pending, counter), context| {
                    let Some(name) = args.first() else {
                        return Err(JsNativeError::typ()
                            .with_message("__hostCall(name, ...args) requires a capability name")
                            .into());
                    };
                    let name = name.to_string(context)?.to_std_string_escaped();

                    let mut call_args = Vec::with_capacity(args.len().saturating_sub(1));
                    for arg in args.iter().skip(1) {
                        call_args.push(
                            js_to_json(arg, context)
                                .map_err(|e| JsNativeError::typ().with_message(e.to_string()))?,
                        );
                    }
                    let args_json = serde_json::to_string(&Json::Array(call_args))
                        .unwrap_or_else(|_| "[]".to_string());

                    let call_id = {
                        let mut c = counter.borrow_mut();
                        *c += 1;
                        format!("c{}", *c)
                    };

                    let (promise, resolvers) = JsPromise::new_pending(context);
                    pending.borrow_mut().push_back(PendingCall {
                        call_id,
                        name,
                        args_json,
                        resolvers: Some(resolvers),
                    });
                    Ok(promise.into())
                },
                (pending_cap, counter_cap),
            )
        };
        context
            .register_global_callable(js_string!("__hostCall"), 1, host_call)
            .map_err(|e| e.to_string())?;

        // ── __log(message) ───────────────────────────────────────────────────
        // Logging is a fire-and-forget event rather than a host call: guest code
        // should never await a log line, and a log must survive a VM that dies
        // before its next await point.
        // Safety: as above — no implicit captures.
        let logs_cap = logs.clone();
        let log_fn = unsafe {
            NativeFunction::from_closure_with_captures(
                |_, args, logs, context| {
                    let parts: Vec<String> = args
                        .iter()
                        .map(|v| {
                            v.to_string(context)
                                .map(|s| s.to_std_string_escaped())
                                .unwrap_or_default()
                        })
                        .collect();
                    logs.borrow_mut().push_back(parts.join(" "));
                    Ok(JsValue::undefined())
                },
                logs_cap,
            )
        };
        context
            .register_global_callable(js_string!("__log"), 1, log_fn)
            .map_err(|e| e.to_string())?;

        // ── __utf8Decode / __utf8Encode ──────────────────────────────────────
        // Boa implements the language, not the web platform, so TextDecoder and
        // TextEncoder do not exist. They are pure computation, so they are plain
        // synchronous natives rather than host calls — and they have to be
        // native: the same conversion written in guest JS costs seconds per
        // megabyte, and jobs decode every entry of a downloaded archive.
        context
            .register_global_callable(
                js_string!("__utf8Decode"),
                1,
                NativeFunction::from_fn_ptr(|_, args, context| {
                    let Some(object) = args.first().and_then(JsValue::as_object) else {
                        return Ok(JsValue::new(js_string!("")));
                    };
                    let bytes = read_bytes(&object, context).unwrap_or_default();
                    // Lossy: a job decoding a truncated or mislabelled file
                    // should see replacement characters, not fail.
                    let text = String::from_utf8_lossy(&bytes);
                    Ok(JsValue::new(js_string!(text.as_ref())))
                }),
            )
            .map_err(|e| e.to_string())?;

        context
            .register_global_callable(
                js_string!("__utf8Encode"),
                1,
                NativeFunction::from_fn_ptr(|_, args, context| {
                    let text = match args.first() {
                        Some(value) => value.to_string(context)?.to_std_string_lossy(),
                        None => String::new(),
                    };
                    let array = JsUint8Array::from_iter(text.into_bytes(), context)?;
                    Ok(array.into())
                }),
            )
            .map_err(|e| e.to_string())?;

        // ── __b64Encode / __b64Decode ────────────────────────────────────────
        // Backing for btoa/atob. Like the text codecs these are native because a
        // job may base64 a whole file, and unlike the JS version they enforce the
        // actual semantics: these operate on binary strings (one byte per code
        // unit), not on text.
        context
            .register_global_callable(
                js_string!("__b64Encode"),
                1,
                NativeFunction::from_fn_ptr(|_, args, context| {
                    let text = match args.first() {
                        Some(value) => value.to_string(context)?,
                        None => return Ok(JsValue::new(js_string!(""))),
                    };
                    let mut bytes = Vec::with_capacity(text.len());
                    for unit in text.iter() {
                        // btoa is defined over Latin-1; anything wider is a
                        // caller error, and silently truncating it would corrupt
                        // data instead of reporting the mistake.
                        if unit > 0xFF {
                            return Err(JsNativeError::typ()
                                .with_message(
                                    "btoa: the string contains characters outside the Latin-1 range",
                                )
                                .into());
                        }
                        bytes.push(unit as u8);
                    }
                    Ok(JsValue::new(js_string!(base64_encode(&bytes).as_str())))
                }),
            )
            .map_err(|e| e.to_string())?;

        context
            .register_global_callable(
                js_string!("__b64Decode"),
                1,
                NativeFunction::from_fn_ptr(|_, args, context| {
                    let text = match args.first() {
                        Some(value) => value.to_string(context)?.to_std_string_lossy(),
                        None => return Ok(JsValue::new(js_string!(""))),
                    };
                    let Some(bytes) = base64_decode(&text) else {
                        return Err(JsNativeError::typ()
                            .with_message("atob: the string is not correctly base64 encoded")
                            .into());
                    };
                    // Each byte becomes one code unit, which is what atob returns.
                    let units: Vec<u16> = bytes.into_iter().map(u16::from).collect();
                    Ok(JsValue::new(boa_engine::JsString::from(units.as_slice())))
                }),
            )
            .map_err(|e| e.to_string())?;

        // ── input ────────────────────────────────────────────────────────────
        let input = json_to_js(inputs, &mut context).map_err(|e| e.to_string())?;
        context
            .register_global_property(js_string!("input"), input, Attribute::all())
            .map_err(|e| e.to_string())?;

        // The prelude runs at global scope so it can install globals; a failure
        // here is a bug in our own code, so it is reported distinctly.
        context
            .eval(Source::from_bytes(prelude.as_bytes()))
            .map_err(|e| format!("prelude failed: {e}"))?;

        // Guest code is wrapped so `await` and a top-level `return` both work.
        let wrapped = format!("(async () => {{\n{code}\n}})()");
        let top_promise = match context.eval(Source::from_bytes(wrapped.as_bytes())) {
            Err(e) => return Err(e.to_string()),
            Ok(value) => value
                .as_object()
                .and_then(|o| JsPromise::from_object(o.clone()).ok()),
        };

        Ok(Self {
            context,
            top_promise,
            logs,
            pending,
            in_flight: HashMap::new(),
        })
    }

    fn take_log(&mut self) -> Option<String> {
        self.logs.borrow_mut().pop_front()
    }

    /// Move one queued host call into flight and describe it for the host.
    fn take_call(&mut self) -> Option<(String, String, Json)> {
        let mut call = self.pending.borrow_mut().pop_front()?;
        let args = serde_json::from_str(&call.args_json).unwrap_or(Json::Array(Vec::new()));
        if let Some(resolvers) = call.resolvers.take() {
            self.in_flight.insert(call.call_id.clone(), resolvers);
        }
        Some((call.call_id.clone(), call.name.clone(), args))
    }

    fn resolve(&mut self, call_id: &str, value: Json) {
        let Some(resolvers) = self.in_flight.remove(call_id) else {
            return;
        };
        match json_to_js(&value, &mut self.context) {
            Ok(js) => {
                let _ = resolvers
                    .resolve
                    .call(&JsValue::undefined(), &[js], &mut self.context);
            }
            Err(error) => self.reject(call_id, &error.to_string()),
        }
    }

    fn reject(&mut self, call_id: &str, message: &str) {
        // The call may already have been taken by a resolve on the same id.
        let resolvers = match self.in_flight.remove(call_id) {
            Some(resolvers) => resolvers,
            None => return,
        };
        let error = JsError::from(JsNativeError::error().with_message(message.to_owned()))
            .to_opaque(&mut self.context);
        let _ = resolvers
            .reject
            .call(&JsValue::undefined(), &[error], &mut self.context);
    }

    /// Reject every in-flight call, used when the host tears the VM down so the
    /// script unwinds through its own `catch`/`finally` blocks.
    fn reject_all(&mut self, message: &str) {
        for call_id in self.in_flight.keys().cloned().collect::<Vec<_>>() {
            self.reject(&call_id, message);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// VM thread
// ─────────────────────────────────────────────────────────────────────────────

/// Run a VM to completion on the calling thread, emitting events through `emit`.
///
/// Exactly one terminal event (`Done` or `Error`) is emitted. `emit` returning
/// `false` means the host is gone, which ends the run.
pub fn run_vm(
    prelude: String,
    code: String,
    inputs: Json,
    config: VmConfig,
    cmd_rx: Receiver<VmCommand>,
    emit: impl Fn(VmEventKind) -> bool,
) {
    let deadline = Instant::now() + Duration::from_millis(config.timeout_ms);

    let mut vm = match Vm::new(&prelude, &code, &inputs, &config) {
        Ok(vm) => vm,
        Err(message) => {
            emit(VmEventKind::Error { message });
            return;
        }
    };

    loop {
        // Commands are applied before stepping so an abort takes effect promptly.
        match drain_commands(&mut vm, &cmd_rx) {
            Drain::Ok => {}
            Drain::Aborted => {
                unwind_and_fail(&mut vm, &emit, "cancelled".to_string());
                return;
            }
            Drain::HostGone => return,
        }

        let _ = vm.context.run_jobs();

        // Logs first: they describe work that led to whatever comes next.
        let mut progressed = false;
        while let Some(message) = vm.take_log() {
            if !emit(VmEventKind::Log { message }) {
                return;
            }
            progressed = true;
        }

        while let Some((call_id, name, args)) = vm.take_call() {
            if !emit(VmEventKind::Call {
                call_id,
                name,
                args,
            }) {
                return;
            }
            progressed = true;
        }

        let Some(promise) = vm.top_promise.clone() else {
            // Non-promise completion: code with no await and no return value.
            emit(VmEventKind::Done { output: Json::Null });
            return;
        };

        match promise.state() {
            PromiseState::Fulfilled(value) => {
                let event = match js_to_json(&value, &mut vm.context) {
                    Ok(output) => VmEventKind::Done { output },
                    Err(error) => VmEventKind::Error {
                        message: format!("could not read script result: {error}"),
                    },
                };
                emit(event);
                return;
            }
            PromiseState::Rejected(reason) => {
                let message = describe_rejection(&reason, &mut vm.context);
                emit(VmEventKind::Error { message });
                return;
            }
            PromiseState::Pending => {}
        }

        if Instant::now() >= deadline {
            let message = format!("timed out after {}ms", config.timeout_ms);
            unwind_and_fail(&mut vm, &emit, message);
            return;
        }

        // Nothing in flight and nothing new queued means the script is awaiting
        // something that can never settle — no timers exist outside host calls,
        // so no future event can arrive. Report it rather than hang to deadline.
        if vm.in_flight.is_empty() && !progressed {
            emit(VmEventKind::Error {
                message: "script awaited a value that never resolves".to_string(),
            });
            return;
        }

        // Block until the host answers a call. This is what makes the loop
        // event-driven instead of a poll: an idle VM consumes nothing.
        let remaining = deadline.saturating_duration_since(Instant::now());
        match cmd_rx.recv_timeout(remaining) {
            Ok(command) => {
                if apply(&mut vm, command) {
                    unwind_and_fail(&mut vm, &emit, "cancelled".to_string());
                    return;
                }
            }
            Err(RecvTimeoutError::Timeout) => {
                let message = format!("timed out after {}ms", config.timeout_ms);
                unwind_and_fail(&mut vm, &emit, message);
                return;
            }
            // Sender dropped: the host will never answer.
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

/// End a run by failing every in-flight call, then letting the script unwind.
///
/// Rejecting is not enough on its own: the rejection only reaches the guest's
/// `catch`/`finally` blocks when microtasks run, so this pumps the job queue once
/// more and forwards any logs those blocks produce before the terminal error.
fn unwind_and_fail(vm: &mut Vm, emit: &impl Fn(VmEventKind) -> bool, message: String) {
    vm.reject_all(&message);
    let _ = vm.context.run_jobs();
    while let Some(message) = vm.take_log() {
        if !emit(VmEventKind::Log { message }) {
            return;
        }
    }
    emit(VmEventKind::Error { message });
}

enum Drain {
    Ok,
    Aborted,
    HostGone,
}

fn drain_commands(vm: &mut Vm, cmd_rx: &Receiver<VmCommand>) -> Drain {
    loop {
        match cmd_rx.try_recv() {
            Ok(command) => {
                if apply(vm, command) {
                    return Drain::Aborted;
                }
            }
            Err(mpsc::TryRecvError::Empty) => return Drain::Ok,
            Err(mpsc::TryRecvError::Disconnected) => return Drain::HostGone,
        }
    }
}

/// Apply one command. Returns true if it was an abort.
fn apply(vm: &mut Vm, command: VmCommand) -> bool {
    match command {
        VmCommand::Resolve { call_id, value } => {
            vm.resolve(&call_id, value);
            false
        }
        VmCommand::Reject { call_id, message } => {
            vm.reject(&call_id, &message);
            false
        }
        VmCommand::Abort => true,
    }
}

/// Turn a rejection value into a message, preferring a real stack-bearing error.
fn describe_rejection(reason: &JsValue, context: &mut Context) -> String {
    if let Some(object) = reason.as_object() {
        if let Ok(stack) = object.get(js_string!("stack"), context) {
            if !stack.is_undefined() {
                if let Ok(text) = stack.to_string(context) {
                    return text.to_std_string_escaped();
                }
            }
        }
    }
    reason
        .to_string(context)
        .map(|s| s.to_std_string_escaped())
        .unwrap_or_else(|_| "script rejected".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Drive a VM with a canned host that answers calls from `answers`,
    /// collecting the event stream as `(kind, detail)` pairs.
    fn drive(
        code: &str,
        inputs: Json,
        answers: HashMap<String, Json>,
    ) -> (Vec<(String, String)>, Option<Json>) {
        let (id, cmd_rx) = register_session();
        let events = Mutex::new(Vec::new());
        let output = Mutex::new(None);

        run_vm(
            String::new(),
            code.to_string(),
            inputs,
            VmConfig {
                timeout_ms: 5_000,
                // Small enough to keep the runaway-loop test fast.
                loop_iteration_limit: 100_000,
            },
            cmd_rx,
            |event| {
                match event {
                    VmEventKind::Log { message } => {
                        events.lock().unwrap().push(("log".to_string(), message));
                    }
                    VmEventKind::Call {
                        call_id,
                        name,
                        args: _,
                    } => {
                        events.lock().unwrap().push(("call".to_string(), name.clone()));
                        match answers.get(&name) {
                            Some(value) => send_command(
                                id,
                                VmCommand::Resolve {
                                    call_id,
                                    value: value.clone(),
                                },
                            ),
                            None => send_command(
                                id,
                                VmCommand::Reject {
                                    call_id,
                                    message: format!("no capability '{name}'"),
                                },
                            ),
                        }
                    }
                    VmEventKind::Done { output: out } => {
                        events.lock().unwrap().push(("done".to_string(), String::new()));
                        *output.lock().unwrap() = Some(out);
                    }
                    VmEventKind::Error { message } => {
                        events.lock().unwrap().push(("error".to_string(), message));
                    }
                }
                true
            },
        );

        unregister_session(id);
        (events.into_inner().unwrap(), output.into_inner().unwrap())
    }

    #[test]
    fn logs_calls_a_capability_and_returns_output() {
        let answers = HashMap::from([("runJob".to_string(), json!({ "value": 41 }))]);
        let (events, output) = drive(
            "__log(input.name); const r = await __hostCall('runJob', 'ext', 'job'); return { answer: r.value + 1 };",
            json!({ "name": "start" }),
            answers,
        );

        assert_eq!(events[0], ("log".to_string(), "start".to_string()));
        assert_eq!(events[1], ("call".to_string(), "runJob".to_string()));
        assert_eq!(events[2].0, "done");
        assert_eq!(output.unwrap()["answer"].as_f64(), Some(42.0));
    }

    #[test]
    fn unknown_capability_rejects_into_the_script() {
        let (events, _) = drive(
            "try { await __hostCall('nope'); } catch (e) { __log('caught: ' + e.message); } return {};",
            json!({}),
            HashMap::new(),
        );

        assert!(events
            .iter()
            .any(|(kind, detail)| kind == "log" && detail.contains("no capability 'nope'")));
        assert_eq!(events.last().unwrap().0, "done");
    }

    #[test]
    fn concurrent_calls_are_all_surfaced_before_blocking() {
        let answers = HashMap::from([("fetch".to_string(), json!({ "status": 200 }))]);
        let (events, output) = drive(
            "const rs = await Promise.all([__hostCall('fetch','a'), __hostCall('fetch','b'), __hostCall('fetch','c')]); return { count: rs.length };",
            json!({}),
            answers,
        );

        assert_eq!(
            events.iter().filter(|(kind, _)| kind == "call").count(),
            3,
            "all three calls should be in flight together"
        );
        assert_eq!(output.unwrap()["count"].as_f64(), Some(3.0));
    }

    #[test]
    fn a_never_settling_await_fails_instead_of_hanging() {
        let (events, _) = drive("await new Promise(() => {}); return {};", json!({}), HashMap::new());

        let (kind, message) = events.last().unwrap();
        assert_eq!(kind, "error");
        assert!(message.contains("never resolves"), "got: {message}");
    }

    #[test]
    fn a_runaway_loop_is_terminated() {
        let (events, _) = drive(
            "let i = 0; while (true) { i++; } return {};",
            json!({}),
            HashMap::new(),
        );

        assert_eq!(events.last().unwrap().0, "error");
    }

    #[test]
    fn cancellation_lets_the_script_run_its_finally_block() {
        let (id, cmd_rx) = register_session();
        let events = Mutex::new(Vec::new());

        run_vm(
            String::new(),
            "try { await __hostCall('forever'); } finally { __log('cleanup ran'); } return {};"
                .to_string(),
            json!({}),
            VmConfig {
                timeout_ms: 5_000,
                loop_iteration_limit: 100_000,
            },
            cmd_rx,
            |event| {
                match event {
                    VmEventKind::Log { message } => {
                        events.lock().unwrap().push(("log".to_string(), message));
                    }
                    VmEventKind::Call { .. } => send_command(id, VmCommand::Abort),
                    VmEventKind::Done { .. } => {
                        events.lock().unwrap().push(("done".to_string(), String::new()));
                    }
                    VmEventKind::Error { message } => {
                        events.lock().unwrap().push(("error".to_string(), message));
                    }
                }
                true
            },
        );
        unregister_session(id);

        let events = events.into_inner().unwrap();
        assert_eq!(
            events,
            vec![
                ("log".to_string(), "cleanup ran".to_string()),
                ("error".to_string(), "cancelled".to_string()),
            ],
            "the finally block must run, and its log must arrive before the terminal error"
        );
    }

    #[test]
    fn thrown_errors_surface_with_a_message() {
        let (events, _) = drive("throw new Error('broken'); ", json!({}), HashMap::new());

        let (kind, message) = events.last().unwrap();
        assert_eq!(kind, "error");
        assert!(message.contains("broken"), "got: {message}");
    }

    #[test]
    fn text_codecs_round_trip_every_utf8_width() {
        // 1-, 2-, 3- and 4-byte sequences, the last one a surrogate pair in JS.
        for text in ["hello", "Grüße ß", "日本語", "family 👨"] {
            let bytes = crate::marshal::base64_encode(text.as_bytes());
            let answers = HashMap::from([(
                "get".to_string(),
                json!({ crate::marshal::BYTES_KEY: bytes }),
            )]);
            let (_, output) = drive(
                "const b = await __hostCall('get');
                 const decoded = __utf8Decode(b);
                 return { decoded, reEncoded: __utf8Encode(decoded) };",
                json!({}),
                answers,
            );

            let output = output.expect("script produced no output");
            assert_eq!(output["decoded"], json!(text));
            // Re-encoding must reproduce the original bytes exactly.
            assert_eq!(
                output["reEncoded"][crate::marshal::BYTES_KEY],
                json!(crate::marshal::base64_encode(text.as_bytes())),
                "re-encode mismatch for {text}"
            );
        }
    }

    #[test]
    fn decoding_invalid_utf8_substitutes_instead_of_failing() {
        // A truncated or mislabelled download should still decode to something.
        let bytes = crate::marshal::base64_encode(&[b'a', 0xff, 0xfe, b'b']);
        let answers = HashMap::from([(
            "get".to_string(),
            json!({ crate::marshal::BYTES_KEY: bytes }),
        )]);
        let (_, output) = drive(
            "return { text: __utf8Decode(await __hostCall('get')) };",
            json!({}),
            answers,
        );

        let text = output.expect("no output")["text"].as_str().unwrap().to_string();
        assert!(text.starts_with('a') && text.ends_with('b'), "got: {text}");
        assert!(text.contains('\u{fffd}'), "expected replacement chars, got: {text}");
    }

    #[test]
    fn decoding_a_non_byte_value_yields_an_empty_string() {
        let (_, output) = drive(
            "return { a: __utf8Decode(null), b: __utf8Decode(42) };",
            json!({}),
            HashMap::new(),
        );

        let output = output.expect("no output");
        assert_eq!(output["a"], json!(""));
        assert_eq!(output["b"], json!(""));
    }

    #[test]
    fn base64_helpers_round_trip_binary_strings() {
        let (_, output) = drive(
            "const encoded = __b64Encode('hello');
             return { encoded, decoded: __b64Decode(encoded) };",
            json!({}),
            HashMap::new(),
        );

        let output = output.expect("no output");
        assert_eq!(output["encoded"], json!("aGVsbG8="));
        assert_eq!(output["decoded"], json!("hello"));
    }

    #[test]
    fn base64_preserves_high_bytes_as_single_code_units() {
        // A byte above 0x7F must survive as one code unit, not become two bytes
        // of UTF-8: atob returns a binary string, not text.
        let (_, output) = drive(
            "const decoded = __b64Decode('/w==');
             return { length: decoded.length, code: decoded.charCodeAt(0) };",
            json!({}),
            HashMap::new(),
        );

        let output = output.expect("no output");
        assert_eq!(output["length"].as_f64(), Some(1.0));
        assert_eq!(output["code"].as_f64(), Some(255.0));
    }

    #[test]
    fn encoding_a_non_latin1_string_is_rejected() {
        let (_, output) = drive(
            "try { __b64Encode('snow \\u2603'); return { threw: false }; }
             catch (e) { return { threw: true, message: e.message }; }",
            json!({}),
            HashMap::new(),
        );

        let output = output.expect("no output");
        assert_eq!(output["threw"], json!(true));
        assert!(
            output["message"].as_str().unwrap().contains("Latin-1"),
            "got: {}",
            output["message"]
        );
    }

    #[test]
    fn decoding_malformed_base64_is_rejected() {
        let (_, output) = drive(
            "try { __b64Decode('not base64!'); return { threw: false }; }
             catch (e) { return { threw: true }; }",
            json!({}),
            HashMap::new(),
        );

        assert_eq!(output.expect("no output")["threw"], json!(true));
    }

    #[test]
    fn binary_survives_a_round_trip_through_a_host_call() {
        let bytes = crate::marshal::base64_encode(&[0u8, 1, 2, 250]);
        let answers = HashMap::from([(
            "readFile".to_string(),
            json!({ crate::marshal::BYTES_KEY: bytes }),
        )]);
        let (_, output) = drive(
            "const b = await __hostCall('readFile', 'x'); return { len: b.length, last: b[3] };",
            json!({}),
            answers,
        );

        let output = output.unwrap();
        assert_eq!(output["len"].as_f64(), Some(4.0));
        assert_eq!(output["last"].as_f64(), Some(250.0));
    }
}
