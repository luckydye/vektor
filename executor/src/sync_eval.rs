use std::sync::mpsc;
use std::time::Duration;

use boa_engine::{
    Context, JsValue, NativeFunction, Source,
    js_string,
    object::ObjectInitializer,
    property::Attribute,
    value::JsVariant,
    vm::RuntimeLimits,
};
use boa_gc::{Gc, GcRefCell};
use serde_json::Value as Json;

use crate::marshal::json_to_js;

#[derive(Debug, Default)]
pub struct SyncGlobals {
    pub argv: Vec<String>,
    pub cwd: String,
    pub env: Vec<(String, String)>,
    pub platform: String,
    pub version: String,
}

#[derive(Debug)]
pub struct SyncResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

/// Run `code` in a fresh Boa context on a dedicated OS thread, returning
/// when the eval completes or `timeout_ms` elapses (whichever comes first).
///
/// Because `Gc<T>` is `!Send`, all Boa objects are created inside the
/// spawned thread. The thread may outlive the timeout (we can't cancel it),
/// but the caller receives the timeout error immediately.
pub fn eval_sync(
    code: String,
    globals: SyncGlobals,
    inputs: Option<Json>,
    timeout_ms: u64,
    _filename: String,
) -> SyncResult {
    let (tx, rx) = mpsc::channel::<SyncResult>();

    std::thread::spawn(move || {
        let result = run_boa(code, globals, inputs, timeout_ms);
        let _ = tx.send(result);
    });

    rx.recv_timeout(Duration::from_millis(timeout_ms))
        .unwrap_or_else(|_| SyncResult {
            stdout: String::new(),
            stderr: "js-exec: execution timed out\n".to_string(),
            exit_code: 1,
        })
}

/// Inner eval — all Boa/GC objects are created and dropped in this function,
/// which runs on its own OS thread.
fn run_boa(code: String, globals: SyncGlobals, inputs: Option<Json>, timeout_ms: u64) -> SyncResult {
    // Gc<GcRefCell<String>> satisfies the Trace bound required by NativeFunction captures.
    let stdout: Gc<GcRefCell<String>> = Gc::new(GcRefCell::new(String::new()));
    let stderr: Gc<GcRefCell<String>> = Gc::new(GcRefCell::new(String::new()));

    let mut context = Context::default();

    // ── runtime limits ────────────────────────────────────────────────────
    // loop_iteration_limit terminates `while(true){}` and similar loops with
    // a clean JS error rather than spinning the thread indefinitely.
    // Budget: 100 000 iterations per ms of timeout — generous enough for
    // legitimate code, tight enough to abort within the timeout window.
    // The OS-thread recv_timeout above is a hard backstop for non-loop
    // infinite work (heavy recursion, long-running arithmetic, etc.).
    let mut limits = RuntimeLimits::default();
    limits.set_loop_iteration_limit(timeout_ms.saturating_mul(100_000));
    context.set_runtime_limits(limits);

    // ── console methods ───────────────────────────────────────────────────
    let make_logger = |sink: Gc<GcRefCell<String>>| {
        // Safety: closure body captures nothing from outer scope;
        // all GC types are passed as explicit Trace captures.
        unsafe {
            NativeFunction::from_closure_with_captures(
                |_, args, sink, context| {
                    let parts: Vec<String> = args
                        .iter()
                        .map(|v| match v.variant() {
                            JsVariant::String(s) => s.to_std_string_escaped(),
                            _ => v
                                .to_string(context)
                                .map(|s| s.to_std_string_escaped())
                                .unwrap_or_default(),
                        })
                        .collect();
                    sink.borrow_mut().push_str(&parts.join(" "));
                    sink.borrow_mut().push('\n');
                    Ok(JsValue::undefined())
                },
                sink,
            )
        }
    };

    let mut console = ObjectInitializer::new(&mut context);
    console.function(make_logger(stdout.clone()), js_string!("log"), 0);
    console.function(make_logger(stderr.clone()), js_string!("error"), 0);
    console.function(make_logger(stderr.clone()), js_string!("warn"), 0);
    console.function(make_logger(stdout.clone()), js_string!("info"), 0);
    console.function(make_logger(stdout.clone()), js_string!("debug"), 0);
    let console_obj = console.build();
    context
        .register_global_property(js_string!("console"), console_obj, Attribute::all())
        .ok();

    // ── process ───────────────────────────────────────────────────────────
    // Safety: cwd_str is a plain String — no GC types in the closure body.
    let cwd_fn = unsafe {
        NativeFunction::from_closure_with_captures(
            |_, _, cwd, _| Ok(JsValue::new(js_string!(cwd.as_str()))),
            globals.cwd,
        )
    };

    let argv_json: Json =
        Json::Array(globals.argv.iter().map(|s| Json::String(s.clone())).collect());
    let env_json: Json = Json::Object(
        globals
            .env
            .iter()
            .map(|(k, v)| (k.clone(), Json::String(v.clone())))
            .collect(),
    );

    let mut process = ObjectInitializer::new(&mut context);
    if let Ok(v) = json_to_js(&argv_json, process.context()) {
        process.property(js_string!("argv"), v, Attribute::all());
    }
    process.function(cwd_fn, js_string!("cwd"), 0);
    if let Ok(v) = json_to_js(&env_json, process.context()) {
        process.property(js_string!("env"), v, Attribute::all());
    }
    process.property(
        js_string!("platform"),
        JsValue::new(js_string!(globals.platform.as_str())),
        Attribute::all(),
    );
    process.property(
        js_string!("version"),
        JsValue::new(js_string!(globals.version.as_str())),
        Attribute::all(),
    );
    let process_obj = process.build();
    context
        .register_global_property(js_string!("process"), process_obj, Attribute::all())
        .ok();

    // ── optional input global ─────────────────────────────────────────────
    if let Some(inp) = inputs {
        if let Ok(v) = json_to_js(&inp, &mut context) {
            context
                .register_global_property(js_string!("input"), v, Attribute::all())
                .ok();
        }
    }

    // ── eval ──────────────────────────────────────────────────────────────
    let mut exit_code = 0i32;
    if let Err(e) = context.eval(Source::from_bytes(code.as_bytes())) {
        stderr
            .borrow_mut()
            .push_str(&format!("js-exec: {e}\n"));
        exit_code = 1;
    }

    let out = stdout.borrow().clone();
    let err = stderr.borrow().clone();
    SyncResult {
        stdout: out,
        stderr: err,
        exit_code,
    }
}
