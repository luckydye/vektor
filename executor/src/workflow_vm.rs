use std::collections::{HashMap, VecDeque};

use boa_engine::{
    Context, JsError, JsNativeError, JsValue, NativeFunction, Source,
    builtins::promise::{PromiseState, ResolvingFunctions},
    js_string,
    object::ObjectInitializer,
    object::builtins::JsPromise,
    property::Attribute,
};
use boa_gc::{Finalize, Gc, GcRefCell, Trace};
use serde_json::Value as Json;

use crate::marshal::{json_to_js, js_to_json};

// ─────────────────────────────────────────────────────────────────────────────
// Pending job data — must implement Trace because it's stored in a Gc<GcRefCell<..>>
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Trace, Finalize)]
struct PendingJobData {
    id: String,
    extension_id: String,
    job_id: String,
    /// JSON-serialized inputs so we don't need serde_json::Value to be Trace.
    inputs_json: String,
    /// Wrapped in Option so we can take() without moving out of a Drop type.
    resolvers: Option<ResolvingFunctions>,
}

// ─────────────────────────────────────────────────────────────────────────────
// WorkflowVm
// ─────────────────────────────────────────────────────────────────────────────

pub enum VmStep {
    Done(Json),
    Error(String),
    Log(String),
    PendingJob {
        id: String,
        extension_id: String,
        job_id: String,
        inputs: Json,
    },
    /// Promise still pending; caller should yield then call step() again.
    Pending,
}

pub struct WorkflowVm {
    context: Context,
    top_promise: Option<JsPromise>,
    // GC-rooted queues shared with NativeFunction closures
    log_queue: Gc<GcRefCell<VecDeque<String>>>,
    pending_jobs: Gc<GcRefCell<VecDeque<PendingJobData>>>,
    _step_counter: Gc<GcRefCell<u32>>,
    // Jobs surfaced to the caller, waiting for resolve/reject
    in_flight: HashMap<String, ResolvingFunctions>,
    settled: bool,
    last_output: Json,
}

impl WorkflowVm {
    pub fn new(code: &str, inputs: &Json) -> Result<Self, String> {
        let log_queue: Gc<GcRefCell<VecDeque<String>>> =
            Gc::new(GcRefCell::new(VecDeque::new()));
        let pending_jobs: Gc<GcRefCell<VecDeque<PendingJobData>>> =
            Gc::new(GcRefCell::new(VecDeque::new()));
        let step_counter: Gc<GcRefCell<u32>> = Gc::new(GcRefCell::new(0));

        let mut context = Context::default();

        // ── log(message) ─────────────────────────────────────────────────
        // Safety: the closure body captures nothing; all GC types are explicit captures.
        let lq_cap = log_queue.clone();
        let log_fn = unsafe {
            NativeFunction::from_closure_with_captures(
                |_, args, lq, context| {
                    let msg = args
                        .first()
                        .map(|v| {
                            v.to_string(context)
                                .map(|s| s.to_std_string_escaped())
                                .unwrap_or_default()
                        })
                        .unwrap_or_default();
                    lq.borrow_mut().push_back(msg);
                    Ok(JsValue::undefined())
                },
                lq_cap,
            )
        };
        context
            .register_global_callable(js_string!("log"), 1, log_fn.clone())
            .map_err(|e| e.to_string())?;

        // ── console.log alias ─────────────────────────────────────────────
        let mut console_init = ObjectInitializer::new(&mut context);
        console_init.function(log_fn, js_string!("log"), 1);
        let console_obj = console_init.build();
        context
            .register_global_property(js_string!("console"), console_obj, Attribute::all())
            .map_err(|e| e.to_string())?;

        // ── input ─────────────────────────────────────────────────────────
        let input_val = json_to_js(inputs, &mut context).map_err(|e| e.to_string())?;
        context
            .register_global_property(js_string!("input"), input_val, Attribute::all())
            .map_err(|e| e.to_string())?;

        // ── runJob(extensionId, jobId, inputs?) ───────────────────────────
        // Safety: closure captures only explicit Gc<GcRefCell<..>> captures.
        let pj_cap = pending_jobs.clone();
        let sc_cap = step_counter.clone();
        let run_job_fn = unsafe {
            NativeFunction::from_closure_with_captures(
                |_, args, (pj, sc), context| {
                    let ext_id = args
                        .first()
                        .map(|v| {
                            v.to_string(context)
                                .map(|s| s.to_std_string_escaped())
                                .unwrap_or_default()
                        })
                        .unwrap_or_default();
                    let job_id = args
                        .get(1)
                        .map(|v| {
                            v.to_string(context)
                                .map(|s| s.to_std_string_escaped())
                                .unwrap_or_default()
                        })
                        .unwrap_or_default();
                    let inputs_js = args.get(2).cloned().unwrap_or(JsValue::undefined());
                    let inputs_json = js_to_json(&inputs_js, context);
                    let inputs_str =
                        serde_json::to_string(&inputs_json).unwrap_or_else(|_| "{}".to_string());

                    let id = {
                        let mut c = sc.borrow_mut();
                        let id = format!("step_{}", *c);
                        *c += 1;
                        id
                    };

                    let (promise, resolvers) = JsPromise::new_pending(context);
                    pj.borrow_mut().push_back(PendingJobData {
                        id,
                        extension_id: ext_id,
                        job_id,
                        inputs_json: inputs_str,
                        resolvers: Some(resolvers),
                    });

                    Ok(promise.into())
                },
                (pj_cap, sc_cap),
            )
        };
        context
            .register_global_callable(js_string!("runJob"), 3, run_job_fn)
            .map_err(|e| e.to_string())?;

        // ── eval wrapped in async IIFE ────────────────────────────────────
        let wrapped = format!("(async () => {{\n{code}\n}})()");
        let eval_result = context.eval(Source::from_bytes(wrapped.as_bytes()));

        let top_promise = match eval_result {
            Err(e) => return Err(e.to_string()),
            Ok(val) => val
                .as_object()
                .and_then(|o| JsPromise::from_object(o.clone()).ok()),
        };

        Ok(Self {
            context,
            top_promise,
            log_queue,
            pending_jobs,
            in_flight: HashMap::new(),
            settled: false,
            last_output: Json::Null,
            _step_counter: step_counter,
        })
    }

    pub fn step(&mut self) -> VmStep {
        if self.settled {
            return VmStep::Done(self.last_output.clone());
        }

        // Drain one log message first (may have arrived from a previous run_jobs call)
        if let Some(msg) = self.log_queue.borrow_mut().pop_front() {
            return VmStep::Log(msg);
        }

        // Run Boa microtasks; this may push to log_queue or pending_jobs
        let _ = self.context.run_jobs();

        // Drain one log that appeared after running jobs
        if let Some(msg) = self.log_queue.borrow_mut().pop_front() {
            return VmStep::Log(msg);
        }

        // Surface one pending runJob call
        if let Some(mut job) = self.pending_jobs.borrow_mut().pop_front() {
            let id = job.id.clone();
            let ext = job.extension_id.clone();
            let jid = job.job_id.clone();
            let inputs = serde_json::from_str(&job.inputs_json)
                .unwrap_or(Json::Object(Default::default()));
            if let Some(resolvers) = job.resolvers.take() {
                self.in_flight.insert(id.clone(), resolvers);
            }
            return VmStep::PendingJob {
                id,
                extension_id: ext,
                job_id: jid,
                inputs,
            };
        }

        // Check top-level promise state
        let Some(ref promise) = self.top_promise else {
            self.settled = true;
            return VmStep::Done(Json::Null);
        };

        match promise.state() {
            PromiseState::Fulfilled(val) => {
                let output = js_to_json(&val, &mut self.context);
                self.last_output = output.clone();
                self.settled = true;
                VmStep::Done(output)
            }
            PromiseState::Rejected(reason) => {
                let msg = reason
                    .to_string(&mut self.context)
                    .map(|s| s.to_std_string_escaped())
                    .unwrap_or_else(|_| "Script rejected".to_string());
                self.settled = true;
                VmStep::Error(msg)
            }
            PromiseState::Pending => VmStep::Pending,
        }
    }

    pub fn resolve_job(&mut self, id: &str, result: Json) -> Result<(), String> {
        let resolvers = self
            .in_flight
            .remove(id)
            .ok_or_else(|| format!("no in-flight job '{id}'"))?;
        let val = json_to_js(&result, &mut self.context).map_err(|e| e.to_string())?;
        resolvers
            .resolve
            .call(&JsValue::undefined(), &[val], &mut self.context)
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn reject_job(&mut self, id: &str, error: &str) -> Result<(), String> {
        let resolvers = self
            .in_flight
            .remove(id)
            .ok_or_else(|| format!("no in-flight job '{id}'"))?;
        let err_val = JsError::from(JsNativeError::error().with_message(error.to_owned()))
            .to_opaque(&mut self.context);
        resolvers
            .reject
            .call(&JsValue::undefined(), &[err_val], &mut self.context)
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}
