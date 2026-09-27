//! Platform primitives Boa does not provide.
//!
//! Boa implements ECMA-262 and nothing else, so `URL`, `crypto` and
//! `structuredClone` are simply absent. They belong here rather than in the JS
//! prelude, because they are not capabilities — they mediate no host authority
//! and grant the guest nothing it could not compute itself. They are the
//! language runtime, and a runtime is the engine's job.
//!
//! The distinction is not cosmetic. Written in guest JS these were three latent
//! bugs: a regex URL parser that mishandles anything unusual, a `randomUUID`
//! built on `Math.random`, and a `structuredClone` that silently turned `Date`
//! into a string. Written here, `URL` is WHATWG-compliant via the `url` crate,
//! random bytes come from the OS, and the clone walks the real object graph.

use boa_engine::{
    class::{Class, ClassBuilder},
    js_string,
    native_function::NativeFunction,
    object::builtins::{JsArray, JsArrayBuffer, JsFunction, JsTypedArray, JsUint8Array},
    object::{JsObject, ObjectInitializer},
    property::Attribute,
    value::JsVariant,
    Context, Finalize, JsData, JsError, JsNativeError, JsResult, JsValue, Trace,
};
use url::Url as ParsedUrl;

/// Install every platform primitive into a fresh context.
pub fn register(context: &mut Context) -> Result<(), String> {
    context
        .register_global_class::<Url>()
        .map_err(|e| e.to_string())?;
    context
        .register_global_class::<UrlSearchParams>()
        .map_err(|e| e.to_string())?;
    register_crypto(context)?;
    register_structured_clone(context)?;
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// URL
// ─────────────────────────────────────────────────────────────────────────────

/// A `URL`, backed by a spec-compliant parser.
#[derive(Debug, Trace, Finalize, JsData)]
pub struct Url {
    /// The parsed URL. `url::Url` holds no GC references, so it is opaque to the
    /// collector.
    #[unsafe_ignore_trace]
    inner: ParsedUrl,
}

/// Parse `input`, resolving against `base` when the input is relative.
fn parse_url(input: &str, base: Option<&str>) -> JsResult<ParsedUrl> {
    let trimmed = input.trim();
    let parsed = match base {
        Some(base) => ParsedUrl::parse(base)
            .and_then(|base| base.join(trimmed))
            .map_err(|_| ())
            .or_else(|()| ParsedUrl::parse(trimmed).map_err(|_| ())),
        None => ParsedUrl::parse(trimmed).map_err(|_| ()),
    };
    parsed.map_err(|()| {
        JsError::from(JsNativeError::typ().with_message(format!("Invalid URL: {input}")))
    })
}

/// Read the `url::Url` out of a `this` value, for a getter or method.
fn this_url(this: &JsValue) -> JsResult<ParsedUrl> {
    this.as_object()
        .and_then(|object| object.downcast_ref::<Url>().map(|url| url.inner.clone()))
        .ok_or_else(|| {
            JsNativeError::typ()
                .with_message("not a URL")
                .into()
        })
}

/// Replace the `url::Url` behind a `this` value, for a setter.
fn set_this_url(this: &JsValue, replacement: ParsedUrl) -> JsResult<()> {
    let object = this
        .as_object()
        .ok_or_else(|| JsNativeError::typ().with_message("not a URL"))?;
    let mut url = object
        .downcast_mut::<Url>()
        .ok_or_else(|| JsNativeError::typ().with_message("not a URL"))?;
    url.inner = replacement;
    Ok(())
}

/// Emit a getter reading one component out of the parsed URL.
///
/// A macro rather than a factory taking a function pointer: `NativeFunction`
/// captures must be GC-traceable, and a bare `fn` pointer is not.
macro_rules! url_getter {
    ($context:expr, $read:expr) => {{
        NativeFunction::from_fn_ptr(|this, _, _| {
            // The annotation is what gives the closure's parameter a type.
            let read: fn(&ParsedUrl) -> String = $read;
            let url = this_url(this)?;
            Ok(JsValue::new(js_string!(read(&url).as_str())))
        })
        .to_js_function($context.realm())
    }};
}

/// Emit a setter applying one component to the parsed URL.
///
/// Per the URL spec an invalid assignment is ignored rather than throwing, which
/// is why `apply` reports failure instead of propagating an error.
macro_rules! url_setter {
    ($context:expr, $apply:expr) => {{
        NativeFunction::from_fn_ptr(|this, args, context| {
            let apply: fn(&mut ParsedUrl, &str) -> Result<(), ()> = $apply;
            let value = match args.first() {
                Some(value) => value.to_string(context)?.to_std_string_lossy(),
                None => String::new(),
            };
            let mut url = this_url(this)?;
            if apply(&mut url, value.trim()).is_ok() {
                set_this_url(this, url)?;
            }
            Ok(JsValue::undefined())
        })
        .to_js_function($context.realm())
    }};
}

impl Class for Url {
    const NAME: &'static str = "URL";
    const LENGTH: usize = 1;

    fn data_constructor(
        _new_target: &JsValue,
        args: &[JsValue],
        context: &mut Context,
    ) -> JsResult<Self> {
        let input = match args.first() {
            Some(value) => value.to_string(context)?.to_std_string_lossy(),
            None => {
                return Err(JsNativeError::typ()
                    .with_message("URL requires at least one argument")
                    .into())
            }
        };
        let base = match args.get(1) {
            Some(value) if !value.is_undefined() && !value.is_null() => {
                Some(value.to_string(context)?.to_std_string_lossy())
            }
            _ => None,
        };

        Ok(Self {
            inner: parse_url(&input, base.as_deref())?,
        })
    }

    fn init(class: &mut ClassBuilder<'_>) -> JsResult<()> {
        // Components, with the setters the spec defines. `url::Url` normalizes
        // and validates each assignment, which is the whole point of not doing
        // this by hand.
        #[allow(clippy::type_complexity)]
        let components: [(&str, JsFunction, Option<JsFunction>); 11] = [
            (
                "href",
                url_getter!(class.context(), |u| u.to_string()),
                Some(url_setter!(class.context(), |url, value| {
                    // Assigning href reparses from scratch.
                    *url = ParsedUrl::parse(value).map_err(|_| ())?;
                    Ok(())
                })),
            ),
            (
                "origin",
                url_getter!(class.context(), |u| u.origin().ascii_serialization()),
                // origin is derived; the spec makes it read-only.
                None,
            ),
            (
                "protocol",
                url_getter!(class.context(), |u| format!("{}:", u.scheme())),
                Some(url_setter!(class.context(), |url, value| {
                    url.set_scheme(value.trim_end_matches(':'))
                })),
            ),
            (
                "host",
                url_getter!(class.context(), |u| match (u.host_str(), u.port()) {
                    (Some(host), Some(port)) => format!("{host}:{port}"),
                    (Some(host), None) => host.to_string(),
                    (None, _) => String::new(),
                }),
                Some(url_setter!(class.context(), |url, value| {
                    // host carries an optional port, unlike hostname.
                    match value.rsplit_once(':') {
                        Some((name, port)) if port.parse::<u16>().is_ok() => {
                            url.set_host(Some(name)).map_err(|_| ())?;
                            url.set_port(port.parse::<u16>().ok())
                        }
                        _ => url.set_host(Some(value)).map_err(|_| ()),
                    }
                })),
            ),
            (
                "hostname",
                url_getter!(class.context(), |u| u.host_str().unwrap_or("").to_string()),
                Some(url_setter!(class.context(), |url, value| url
                    .set_host(Some(value))
                    .map_err(|_| ()))),
            ),
            (
                "port",
                url_getter!(class.context(), |u| u
                    .port()
                    .map(|p| p.to_string())
                    .unwrap_or_default()),
                Some(url_setter!(class.context(), |url, value| {
                    if value.is_empty() {
                        return url.set_port(None);
                    }
                    url.set_port(Some(value.parse::<u16>().map_err(|_| ())?))
                })),
            ),
            (
                "pathname",
                url_getter!(class.context(), |u| u.path().to_string()),
                Some(url_setter!(class.context(), |url, value| {
                    url.set_path(value);
                    Ok(())
                })),
            ),
            (
                "search",
                url_getter!(class.context(), |u| u
                    .query()
                    .map(|q| format!("?{q}"))
                    .unwrap_or_default()),
                Some(url_setter!(class.context(), |url, value| {
                    let query = value.trim_start_matches('?');
                    url.set_query(if query.is_empty() { None } else { Some(query) });
                    Ok(())
                })),
            ),
            (
                "hash",
                url_getter!(class.context(), |u| u
                    .fragment()
                    .map(|f| format!("#{f}"))
                    .unwrap_or_default()),
                Some(url_setter!(class.context(), |url, value| {
                    let fragment = value.trim_start_matches('#');
                    url.set_fragment(if fragment.is_empty() {
                        None
                    } else {
                        Some(fragment)
                    });
                    Ok(())
                })),
            ),
            (
                "username",
                url_getter!(class.context(), |u| u.username().to_string()),
                Some(url_setter!(class.context(), |url, value| url
                    .set_username(value))),
            ),
            (
                "password",
                url_getter!(class.context(), |u| u.password().unwrap_or("").to_string()),
                Some(url_setter!(class.context(), |url, value| url.set_password(
                    if value.is_empty() { None } else { Some(value) }
                ))),
            ),
        ];

        for (name, getter, setter) in components {
            class.accessor(
                js_string!(name),
                Some(getter),
                setter,
                Attribute::CONFIGURABLE | Attribute::ENUMERABLE,
            );
        }

        // searchParams is bound to this URL, so mutating it updates the href.
        let search_params_getter = NativeFunction::from_fn_ptr(|this, _, context| {
            let owner = this
                .as_object()
                .ok_or_else(|| JsNativeError::typ().with_message("not a URL"))?;
            UrlSearchParams::bound_to(owner.clone(), context)
        })
        .to_js_function(class.context().realm());
        class.accessor(
            js_string!("searchParams"),
            Some(search_params_getter),
            None,
            Attribute::CONFIGURABLE | Attribute::ENUMERABLE,
        );

        class.method(
            js_string!("toString"),
            0,
            NativeFunction::from_fn_ptr(|this, _, _| {
                Ok(JsValue::new(js_string!(this_url(this)?.to_string().as_str())))
            }),
        );
        class.method(
            js_string!("toJSON"),
            0,
            NativeFunction::from_fn_ptr(|this, _, _| {
                Ok(JsValue::new(js_string!(this_url(this)?.to_string().as_str())))
            }),
        );

        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// URLSearchParams
// ─────────────────────────────────────────────────────────────────────────────

/// `URLSearchParams`, either standalone or bound to a `URL`.
///
/// When bound, every mutation is written straight back through the owning URL, so
/// `url.searchParams.set(...)` is visible in `url.href` — which is how callers
/// expect it to behave.
#[derive(Debug, Trace, Finalize, JsData)]
pub struct UrlSearchParams {
    /// Standalone pairs. Unused while `owner` is set.
    #[unsafe_ignore_trace]
    pairs: Vec<(String, String)>,
    owner: Option<JsObject>,
}

impl UrlSearchParams {
    /// Create an instance whose state lives in `owner`'s URL.
    fn bound_to(owner: JsObject, context: &mut Context) -> JsResult<JsValue> {
        let instance = Self {
            pairs: Vec::new(),
            owner: Some(owner),
        };
        Ok(Self::from_data(instance, context)?.into())
    }

    /// Read the current pairs, from the owning URL when bound.
    fn read(&self) -> Vec<(String, String)> {
        match &self.owner {
            Some(owner) => owner
                .downcast_ref::<Url>()
                .map(|url| {
                    url.inner
                        .query_pairs()
                        .map(|(k, v)| (k.into_owned(), v.into_owned()))
                        .collect()
                })
                .unwrap_or_default(),
            None => self.pairs.clone(),
        }
    }

    /// Write pairs back, into the owning URL when bound.
    fn write(&mut self, pairs: Vec<(String, String)>) {
        match &self.owner {
            Some(owner) => {
                if let Some(mut url) = owner.downcast_mut::<Url>() {
                    if pairs.is_empty() {
                        url.inner.set_query(None);
                        return;
                    }
                    let mut serializer = url.inner.query_pairs_mut();
                    serializer.clear();
                    for (key, value) in &pairs {
                        serializer.append_pair(key, value);
                    }
                    serializer.finish();
                }
            }
            None => self.pairs = pairs,
        }
    }
}

/// Run `mutate` against the pairs behind `this`, then store the result.
fn update_params(
    this: &JsValue,
    mutate: impl FnOnce(&mut Vec<(String, String)>),
) -> JsResult<JsValue> {
    let object = this
        .as_object()
        .ok_or_else(|| JsNativeError::typ().with_message("not a URLSearchParams"))?;
    let mut params = object
        .downcast_mut::<UrlSearchParams>()
        .ok_or_else(|| JsNativeError::typ().with_message("not a URLSearchParams"))?;
    let mut pairs = params.read();
    mutate(&mut pairs);
    params.write(pairs);
    Ok(JsValue::undefined())
}

/// Read the pairs behind `this`.
fn read_params(this: &JsValue) -> JsResult<Vec<(String, String)>> {
    this.as_object()
        .and_then(|object| {
            object
                .downcast_ref::<UrlSearchParams>()
                .map(|params| params.read())
        })
        .ok_or_else(|| {
            JsNativeError::typ()
                .with_message("not a URLSearchParams")
                .into()
        })
}

fn arg_string(args: &[JsValue], index: usize, context: &mut Context) -> JsResult<String> {
    match args.get(index) {
        Some(value) => Ok(value.to_string(context)?.to_std_string_lossy()),
        None => Ok(String::new()),
    }
}

impl Class for UrlSearchParams {
    const NAME: &'static str = "URLSearchParams";
    const LENGTH: usize = 1;

    fn data_constructor(
        _new_target: &JsValue,
        args: &[JsValue],
        context: &mut Context,
    ) -> JsResult<Self> {
        let mut pairs: Vec<(String, String)> = Vec::new();

        match args.first().map(JsValue::variant) {
            Some(JsVariant::String(text)) => {
                let text = text.to_std_string_lossy();
                for (key, value) in
                    url::form_urlencoded::parse(text.trim_start_matches('?').as_bytes())
                {
                    pairs.push((key.into_owned(), value.into_owned()));
                }
            }
            Some(JsVariant::Object(object)) => {
                // An existing URLSearchParams, an array of pairs, or a record.
                if let Some(existing) = object.downcast_ref::<UrlSearchParams>() {
                    pairs = existing.read();
                } else if object.is_array() {
                    let array = JsArray::from_object(object.clone())?;
                    let length = array.length(context)?;
                    for index in 0..length {
                        let entry = array.get(index, context)?;
                        if let Some(entry) = entry.as_object() {
                            let entry = JsArray::from_object(entry.clone())?;
                            let key = entry.get(0u64, context)?.to_string(context)?;
                            let value = entry.get(1u64, context)?.to_string(context)?;
                            pairs.push((key.to_std_string_lossy(), value.to_std_string_lossy()));
                        }
                    }
                } else {
                    for key in object.own_property_keys(context)? {
                        if matches!(key, boa_engine::property::PropertyKey::Symbol(_)) {
                            continue;
                        }
                        let value = object.get(key.clone(), context)?.to_string(context)?;
                        pairs.push((key.to_string(), value.to_std_string_lossy()));
                    }
                }
            }
            _ => {}
        }

        Ok(Self { pairs, owner: None })
    }

    fn init(class: &mut ClassBuilder<'_>) -> JsResult<()> {
        class.method(
            js_string!("append"),
            2,
            NativeFunction::from_fn_ptr(|this, args, context| {
                let key = arg_string(args, 0, context)?;
                let value = arg_string(args, 1, context)?;
                update_params(this, |pairs| pairs.push((key, value)))
            }),
        );

        class.method(
            js_string!("set"),
            2,
            NativeFunction::from_fn_ptr(|this, args, context| {
                let key = arg_string(args, 0, context)?;
                let value = arg_string(args, 1, context)?;
                update_params(this, |pairs| {
                    match pairs.iter().position(|(k, _)| *k == key) {
                        Some(index) => {
                            pairs[index].1 = value;
                            // Later duplicates of the same key are dropped.
                            let mut seen = false;
                            pairs.retain(|(k, _)| {
                                if *k != key {
                                    return true;
                                }
                                let keep = !seen;
                                seen = true;
                                keep
                            });
                        }
                        None => pairs.push((key, value)),
                    }
                })
            }),
        );

        class.method(
            js_string!("delete"),
            1,
            NativeFunction::from_fn_ptr(|this, args, context| {
                let key = arg_string(args, 0, context)?;
                update_params(this, |pairs| pairs.retain(|(k, _)| *k != key))
            }),
        );

        class.method(
            js_string!("get"),
            1,
            NativeFunction::from_fn_ptr(|this, args, context| {
                let key = arg_string(args, 0, context)?;
                Ok(read_params(this)?
                    .into_iter()
                    .find(|(k, _)| *k == key)
                    .map(|(_, v)| JsValue::new(js_string!(v.as_str())))
                    .unwrap_or(JsValue::null()))
            }),
        );

        class.method(
            js_string!("getAll"),
            1,
            NativeFunction::from_fn_ptr(|this, args, context| {
                let key = arg_string(args, 0, context)?;
                let values: Vec<JsValue> = read_params(this)?
                    .into_iter()
                    .filter(|(k, _)| *k == key)
                    .map(|(_, v)| JsValue::new(js_string!(v.as_str())))
                    .collect();
                Ok(JsArray::from_iter(values, context).into())
            }),
        );

        class.method(
            js_string!("has"),
            1,
            NativeFunction::from_fn_ptr(|this, args, context| {
                let key = arg_string(args, 0, context)?;
                Ok(JsValue::new(
                    read_params(this)?.iter().any(|(k, _)| *k == key),
                ))
            }),
        );

        class.method(
            js_string!("forEach"),
            1,
            NativeFunction::from_fn_ptr(|this, args, context| {
                let callback = args
                    .first()
                    .and_then(JsValue::as_callable)
                    .ok_or_else(|| {
                        JsNativeError::typ().with_message("forEach requires a callback")
                    })?;
                for (key, value) in read_params(this)? {
                    callback.call(
                        &JsValue::undefined(),
                        &[
                            JsValue::new(js_string!(value.as_str())),
                            JsValue::new(js_string!(key.as_str())),
                            this.clone(),
                        ],
                        context,
                    )?;
                }
                Ok(JsValue::undefined())
            }),
        );

        // keys/values/entries return arrays, which are iterable — enough for
        // for..of and spreading, which is all guest code does with them.
        class.method(
            js_string!("keys"),
            0,
            NativeFunction::from_fn_ptr(|this, _, context| {
                let keys: Vec<JsValue> = read_params(this)?
                    .into_iter()
                    .map(|(k, _)| JsValue::new(js_string!(k.as_str())))
                    .collect();
                Ok(JsArray::from_iter(keys, context).into())
            }),
        );
        class.method(
            js_string!("values"),
            0,
            NativeFunction::from_fn_ptr(|this, _, context| {
                let values: Vec<JsValue> = read_params(this)?
                    .into_iter()
                    .map(|(_, v)| JsValue::new(js_string!(v.as_str())))
                    .collect();
                Ok(JsArray::from_iter(values, context).into())
            }),
        );
        class.method(
            js_string!("entries"),
            0,
            NativeFunction::from_fn_ptr(|this, _, context| {
                let entries: Vec<JsValue> = read_params(this)?
                    .into_iter()
                    .map(|(k, v)| {
                        JsArray::from_iter(
                            [
                                JsValue::new(js_string!(k.as_str())),
                                JsValue::new(js_string!(v.as_str())),
                            ],
                            context,
                        )
                        .into()
                    })
                    .collect();
                Ok(JsArray::from_iter(entries, context).into())
            }),
        );

        class.method(
            js_string!("toString"),
            0,
            NativeFunction::from_fn_ptr(|this, _, _| {
                let mut serializer = url::form_urlencoded::Serializer::new(String::new());
                for (key, value) in read_params(this)? {
                    serializer.append_pair(&key, &value);
                }
                Ok(JsValue::new(js_string!(serializer.finish().as_str())))
            }),
        );

        let size_getter = NativeFunction::from_fn_ptr(|this, _, _| {
            Ok(JsValue::new(read_params(this)?.len() as u32))
        })
        .to_js_function(class.context().realm());
        class.accessor(
            js_string!("size"),
            Some(size_getter),
            None,
            Attribute::CONFIGURABLE,
        );

        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// crypto
// ─────────────────────────────────────────────────────────────────────────────

fn random_bytes(buffer: &mut [u8]) -> JsResult<()> {
    getrandom::fill(buffer).map_err(|error| {
        JsNativeError::error()
            .with_message(format!("could not read random bytes: {error}"))
            .into()
    })
}

fn register_crypto(context: &mut Context) -> Result<(), String> {
    let mut crypto = ObjectInitializer::new(context);

    crypto.function(
        NativeFunction::from_fn_ptr(|_, _, _| {
            // RFC 4122 version 4, from OS entropy — not from Math.random, which
            // is what a guest-side implementation would be stuck with.
            let mut bytes = [0u8; 16];
            random_bytes(&mut bytes)?;
            bytes[6] = (bytes[6] & 0x0f) | 0x40;
            bytes[8] = (bytes[8] & 0x3f) | 0x80;

            let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            let uuid = format!(
                "{}-{}-{}-{}-{}",
                &hex[0..8],
                &hex[8..12],
                &hex[12..16],
                &hex[16..20],
                &hex[20..32]
            );
            Ok(JsValue::new(js_string!(uuid.as_str())))
        }),
        js_string!("randomUUID"),
        0,
    );

    crypto.function(
        NativeFunction::from_fn_ptr(|_, args, context| {
            let Some(object) = args.first().and_then(JsValue::as_object) else {
                return Err(JsNativeError::typ()
                    .with_message("getRandomValues requires a typed array")
                    .into());
            };
            let view = JsTypedArray::from_object(object.clone()).map_err(|_| {
                JsNativeError::typ().with_message("getRandomValues requires a typed array")
            })?;

            let offset = view.byte_offset(context)?;
            let length = view.byte_length(context)?;
            let buffer_value = view.buffer(context)?;
            let buffer = buffer_value
                .as_object()
                .and_then(|object| JsArrayBuffer::from_object(object.clone()).ok())
                .ok_or_else(|| {
                    JsNativeError::typ().with_message("getRandomValues: detached buffer")
                })?;

            let mut scratch = vec![0u8; length];
            random_bytes(&mut scratch)?;
            {
                let mut data = buffer.data_mut().ok_or_else(|| {
                    JsNativeError::typ().with_message("getRandomValues: detached buffer")
                })?;
                data[offset..offset + length].copy_from_slice(&scratch);
            }

            Ok(args[0].clone())
        }),
        js_string!("getRandomValues"),
        1,
    );

    let object = crypto.build();
    context
        .register_global_property(js_string!("crypto"), object, Attribute::all())
        .map_err(|e| e.to_string())
}

/// `Array.from(value)`, for reading a Map or Set without the iterator protocol.
fn array_from(value: &JsValue, context: &mut Context) -> JsResult<JsObject> {
    let array_constructor = global_constructor("Array", context)?;
    let from = array_constructor
        .get(js_string!("from"), context)?
        .as_callable()
        .ok_or_else(|| JsNativeError::typ().with_message("Array.from"))?;
    from.call(&array_constructor.clone().into(), std::slice::from_ref(value), context)?
        .as_object()
        .ok_or_else(|| {
            JsNativeError::typ()
                .with_message("Array.from returned a non-object")
                .into()
        })
}

/// Look up a global constructor by name.
fn global_constructor(name: &str, context: &mut Context) -> JsResult<JsObject> {
    context
        .global_object()
        .get(js_string!(name), context)?
        .as_object()
        .ok_or_else(|| {
            JsNativeError::typ()
                .with_message(format!("{name} is not available"))
                .into()
        })
}

// ─────────────────────────────────────────────────────────────────────────────
// structuredClone
// ─────────────────────────────────────────────────────────────────────────────

/// Deep-clone a value, preserving cycles and the types a JSON round-trip loses.
fn structured_clone(
    value: &JsValue,
    context: &mut Context,
    seen: &mut Vec<(JsObject, JsValue)>,
    depth: usize,
) -> JsResult<JsValue> {
    if depth > 512 {
        return Err(JsNativeError::range()
            .with_message("structuredClone: value nested too deeply")
            .into());
    }

    let Some(object) = value.as_object() else {
        // Primitives clone by value.
        return Ok(value.clone());
    };

    // A cycle resolves to the clone already made for that object.
    if let Some((_, clone)) = seen
        .iter()
        .find(|(original, _)| JsObject::equals(original, &object))
    {
        return Ok(clone.clone());
    }

    if object.is_callable() {
        return Err(JsNativeError::typ()
            .with_message("structuredClone: functions cannot be cloned")
            .into());
    }

    // Byte views clone as byte views rather than as index maps.
    if let Some(bytes) = crate::marshal::read_bytes(&object, context) {
        let array = JsUint8Array::from_iter(bytes, context)?;
        return Ok(array.into());
    }

    // Map and Set: read their contents with Array.from, then rebuild through the
    // real constructors, so the clone is a genuine Map/Set rather than a plain
    // object (which is what a JSON round-trip produced).
    let is_map = object.is::<boa_engine::builtins::map::ordered_map::OrderedMap<JsValue>>();
    let is_set = object.is::<boa_engine::builtins::set::ordered_set::OrderedSet>();
    if is_map || is_set {
        let entries = array_from(value, context)?;
        let constructor = global_constructor(if is_map { "Map" } else { "Set" }, context)?;
        let clone = constructor.construct(&[], None, context)?;
        seen.push((object.clone(), clone.clone().into()));

        let entries = JsArray::from_object(entries)?;
        let length = entries.length(context)?;
        let adder = clone
            .get(js_string!(if is_map { "set" } else { "add" }), context)?
            .as_callable()
            .ok_or_else(|| JsNativeError::typ().with_message("Map/Set adder"))?;

        for index in 0..length {
            let entry = entries.get(index, context)?;
            if is_map {
                let pair = entry
                    .as_object()
                    .ok_or_else(|| JsNativeError::typ().with_message("map entry"))?
                    .clone();
                let pair = JsArray::from_object(pair)?;
                let key = pair.get(0u64, context)?;
                let item = pair.get(1u64, context)?;
                let key = structured_clone(&key, context, seen, depth + 1)?;
                let item = structured_clone(&item, context, seen, depth + 1)?;
                adder.call(&clone.clone().into(), &[key, item], context)?;
            } else {
                let item = structured_clone(&entry, context, seen, depth + 1)?;
                adder.call(&clone.clone().into(), &[item], context)?;
            }
        }
        return Ok(clone.into());
    }

    if object.is::<boa_engine::builtins::date::Date>() {
        let millis = object.get(js_string!("getTime"), context)?;
        let millis = millis
            .as_callable()
            .ok_or_else(|| JsNativeError::typ().with_message("Date.getTime"))?
            .call(value, &[], context)?;
        let constructor = context
            .global_object()
            .get(js_string!("Date"), context)?
            .as_object()
            .ok_or_else(|| JsNativeError::typ().with_message("Date constructor"))?
            .clone();
        let clone = constructor.construct(&[millis], None, context)?;
        seen.push((object.clone(), clone.clone().into()));
        return Ok(clone.into());
    }

    if object.is_array() {
        let source = JsArray::from_object(object.clone())?;
        let clone = JsArray::new(context);
        seen.push((object.clone(), clone.clone().into()));
        let length = source.length(context)?;
        for index in 0..length {
            let item = source.get(index, context)?;
            let item_clone = structured_clone(&item, context, seen, depth + 1)?;
            clone.set(index, item_clone, false, context)?;
        }
        return Ok(clone.into());
    }

    // Plain object.
    let clone = JsObject::with_object_proto(context.intrinsics());
    seen.push((object.clone(), clone.clone().into()));
    for key in object.own_property_keys(context)? {
        if matches!(key, boa_engine::property::PropertyKey::Symbol(_)) {
            continue;
        }
        let item = object.get(key.clone(), context)?;
        let item_clone = structured_clone(&item, context, seen, depth + 1)?;
        clone.set(key, item_clone, false, context)?;
    }
    Ok(clone.into())
}

fn register_structured_clone(context: &mut Context) -> Result<(), String> {
    context
        .register_global_callable(
            js_string!("structuredClone"),
            1,
            NativeFunction::from_fn_ptr(|_, args, context| {
                let value = args.first().cloned().unwrap_or(JsValue::undefined());
                let mut seen = Vec::new();
                structured_clone(&value, context, &mut seen, 0)
            }),
        )
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use boa_engine::{Context, Source};

    /// Evaluate `code` in a context with the platform primitives installed.
    fn eval(code: &str) -> String {
        let mut context = Context::default();
        super::register(&mut context).expect("platform registration failed");
        let value = context
            .eval(Source::from_bytes(code.as_bytes()))
            .unwrap_or_else(|error| panic!("eval failed: {error}"));
        value
            .to_string(&mut context)
            .map(|s| s.to_std_string_escaped())
            .unwrap_or_else(|_| String::from("<unprintable>"))
    }

    fn eval_bool(code: &str) -> bool {
        let mut context = Context::default();
        super::register(&mut context).expect("platform registration failed");
        let value = context
            .eval(Source::from_bytes(code.as_bytes()))
            .unwrap_or_else(|error| panic!("eval failed: {error}"));
        value.to_boolean()
    }

    #[test]
    fn url_normalizes_the_way_the_spec_requires() {
        // Default port stripped, dot segments resolved, host lowercased — all the
        // things a hand-rolled parser gets wrong.
        assert_eq!(
            eval("new URL('https://EXAMPLE.com:443/a/../b/./c?q=1#h').href"),
            "https://example.com/b/c?q=1#h"
        );
        assert_eq!(
            eval("new URL('http://example.com:80/x').host"),
            "example.com"
        );
        assert_eq!(
            eval("new URL('https://u:p@example.com:8443/x').origin"),
            "https://example.com:8443"
        );
    }

    #[test]
    fn url_resolves_relative_references_against_a_base() {
        assert_eq!(
            eval("new URL('../up', 'https://example.com/a/b/c').href"),
            "https://example.com/a/up"
        );
        assert_eq!(
            eval("new URL('//cdn.example.com/x', 'https://example.com/a').href"),
            "https://cdn.example.com/x"
        );
        assert_eq!(
            eval("new URL('?only', 'https://example.com/a/b').href"),
            "https://example.com/a/b?only"
        );
    }

    #[test]
    fn an_invalid_url_throws() {
        assert!(eval_bool(
            "(() => { try { new URL('not a url'); return false; } catch { return true; } })()"
        ));
    }

    #[test]
    fn search_params_mutations_write_through_to_the_url() {
        assert_eq!(
            eval(
                "const u = new URL('https://example.com/p?a=1&b=2');
                 u.searchParams.set('a', '9');
                 u.searchParams.delete('b');
                 u.searchParams.append('c', '3');
                 u.href"
            ),
            "https://example.com/p?a=9&c=3"
        );
    }

    #[test]
    fn search_params_reads_repeated_keys() {
        assert_eq!(
            eval("new URL('https://e.com/?a=1&a=2').searchParams.getAll('a').join(',')"),
            "1,2"
        );
        assert_eq!(
            eval("new URLSearchParams({ a: '1', b: '2' }).toString()"),
            "a=1&b=2"
        );
    }

    #[test]
    fn url_setters_apply_and_reject_invalid_values() {
        assert_eq!(
            eval(
                "const u = new URL('https://example.com/a?x=1#h');
                 u.pathname = '/b'; u.search = '?y=2'; u.hash = ''; u.port = '8080';
                 u.href"
            ),
            "https://example.com:8080/b?y=2"
        );
        // An invalid assignment is ignored, not thrown, per the spec.
        assert_eq!(
            eval(
                "const u = new URL('https://example.com/');
                 u.protocol = '!!'; u.href"
            ),
            "https://example.com/"
        );
    }

    #[test]
    fn random_uuid_is_version_4_and_unpredictable() {
        // Drawn from OS entropy, so 200 draws must not collide. A Math.random
        // implementation could pass this, which is why the shape is checked too.
        assert!(eval_bool(
            "(() => {
               const seen = new Set();
               for (let i = 0; i < 200; i++) seen.add(crypto.randomUUID());
               const shape = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
               return seen.size === 200 && [...seen].every((id) => shape.test(id));
             })()"
        ));
    }

    #[test]
    fn get_random_values_fills_the_view_in_place() {
        assert!(eval_bool(
            "(() => {
               const view = new Uint8Array(64);
               const returned = crypto.getRandomValues(view);
               const filled = Array.from(view).some((b) => b !== 0);
               return returned === view && filled;
             })()"
        ));
    }

    #[test]
    fn structured_clone_preserves_types_a_json_round_trip_loses() {
        assert!(eval_bool(
            "(() => {
               const original = {
                 when: new Date(86400000),
                 map: new Map([['k', { v: 1 }]]),
                 set: new Set([1, 2]),
                 bytes: new Uint8Array([1, 2, 3]),
                 nested: { deep: [1, { two: true }] },
               };
               original.self = original;
               const copy = structuredClone(original);
               copy.nested.deep[1].two = false;
               return copy.self === copy
                 && copy.when instanceof Date && copy.when.getTime() === 86400000
                 && copy.map instanceof Map && copy.map.get('k').v === 1
                 && copy.map.get('k') !== original.map.get('k')
                 && copy.set instanceof Set && copy.set.has(2)
                 && copy.bytes instanceof Uint8Array && copy.bytes[2] === 3
                 && original.nested.deep[1].two === true;
             })()"
        ));
    }

    #[test]
    fn structured_clone_refuses_functions() {
        assert!(eval_bool(
            "(() => { try { structuredClone({ fn: () => 1 }); return false; } catch { return true; } })()"
        ));
    }
}
