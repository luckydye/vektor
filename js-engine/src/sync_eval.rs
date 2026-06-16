use boa_engine::{
    Context, JsValue, NativeFunction, Source,
    js_string,
    object::ObjectInitializer,
    property::Attribute,
    value::JsVariant,
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

pub fn eval_sync(
    code: String,
    globals: SyncGlobals,
    inputs: Option<Json>,
    _timeout_ms: u64,
    _filename: String,
) -> SyncResult {
    // Use Gc<GcRefCell<String>> so closures satisfy the Trace bound.
    let stdout: Gc<GcRefCell<String>> = Gc::new(GcRefCell::new(String::new()));
    let stderr: Gc<GcRefCell<String>> = Gc::new(GcRefCell::new(String::new()));

    let mut context = Context::default();

    // ── console methods ───────────────────────────────────────────────────
    let make_logger = |sink: Gc<GcRefCell<String>>| {
        // Safety: closure captures nothing from outer scope; all GC types are explicit captures.
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

    let log_fn = make_logger(stdout.clone());
    let error_fn = make_logger(stderr.clone());
    let warn_fn = make_logger(stderr.clone());
    let info_fn = make_logger(stdout.clone());
    let debug_fn = make_logger(stdout.clone());

    let mut console = ObjectInitializer::new(&mut context);
    console.function(log_fn, js_string!("log"), 0);
    console.function(error_fn, js_string!("error"), 0);
    console.function(warn_fn, js_string!("warn"), 0);
    console.function(info_fn, js_string!("info"), 0);
    console.function(debug_fn, js_string!("debug"), 0);
    let console_obj = console.build();
    context
        .register_global_property(js_string!("console"), console_obj, Attribute::all())
        .ok();

    // ── process ───────────────────────────────────────────────────────────
    let cwd_str = globals.cwd.clone();
    let cwd_fn = unsafe {
        NativeFunction::from_closure_with_captures(
            |_, _, cwd, _| Ok(JsValue::new(js_string!(cwd.as_str()))),
            cwd_str,
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

    if let Ok(argv_val) = json_to_js(&argv_json, process.context()) {
        process.property(js_string!("argv"), argv_val, Attribute::all());
    }
    process.function(cwd_fn, js_string!("cwd"), 0);
    if let Ok(env_val) = json_to_js(&env_json, process.context()) {
        process.property(js_string!("env"), env_val, Attribute::all());
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
    let source = Source::from_bytes(code.as_bytes());
    let eval_result = context.eval(source);

    let mut exit_code = 0i32;
    if let Err(e) = eval_result {
        let msg = e.to_string();
        stderr.borrow_mut().push_str(&format!("js-exec: {msg}\n"));
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
