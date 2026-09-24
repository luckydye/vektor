//! JSON ⇄ Boa value marshalling for the host-call bridge.
//!
//! Two things make this more than a plain serde bridge:
//!
//! 1. **Binary envelope.** Job code deals in `Uint8Array` (file contents, zip
//!    archives, spreadsheets) but the host bridge carries JSON. A byte array
//!    crosses as `{ "__bytes": "<base64>" }` and is rehydrated to a real
//!    `Uint8Array` on the way in. Encoding happens here in Rust because doing it
//!    in interpreted JS is orders of magnitude slower on multi-megabyte payloads.
//!
//! 2. **Caps.** Job code is untrusted. `js_to_json` walks an arbitrary object
//!    graph, so it enforces depth/node/byte budgets and breaks reference cycles
//!    instead of recursing until the thread's stack dies.

use boa_engine::{
    js_string,
    object::builtins::{JsArray, JsArrayBuffer, JsTypedArray, JsUint8Array},
    object::{JsObject, ObjectInitializer},
    property::Attribute,
    value::JsVariant,
    Context, JsResult, JsValue,
};
use serde_json::Value as Json;

/// Property name marking a base64 binary envelope.
pub const BYTES_KEY: &str = "__bytes";

/// Nesting depth ceiling. Deep enough for any realistic job payload, shallow
/// enough that the recursive walk cannot overflow the VM thread's stack.
const MAX_DEPTH: usize = 128;
/// Total values visited in one conversion.
const MAX_NODES: usize = 2_000_000;
/// Total string bytes accumulated in one conversion (64 MiB).
const MAX_STRING_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug)]
pub enum MarshalError {
    DepthExceeded,
    TooManyNodes,
    TooLarge,
}

impl std::fmt::Display for MarshalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DepthExceeded => write!(f, "value nested deeper than {MAX_DEPTH} levels"),
            Self::TooManyNodes => write!(f, "value exceeds {MAX_NODES} entries"),
            Self::TooLarge => {
                write!(f, "value exceeds the {MAX_STRING_BYTES} byte string budget")
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// base64
// ─────────────────────────────────────────────────────────────────────────────

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            B64[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

pub fn base64_decode(text: &str) -> Option<Vec<u8>> {
    fn val(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a') as u32 + 26),
            b'0'..=b'9' => Some((c - b'0') as u32 + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }

    let src: Vec<u8> = text
        .bytes()
        .filter(|c| !c.is_ascii_whitespace() && *c != b'=')
        .collect();
    let mut out = Vec::with_capacity(src.len() / 4 * 3 + 3);
    for chunk in src.chunks(4) {
        // A trailing 1-byte group carries no whole byte and is malformed base64.
        if chunk.len() < 2 {
            return None;
        }
        let mut n = 0u32;
        for (i, c) in chunk.iter().enumerate() {
            n |= val(*c)? << (18 - 6 * i);
        }
        out.push((n >> 16) as u8);
        if chunk.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(n as u8);
        }
    }
    Some(out)
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON → JS
// ─────────────────────────────────────────────────────────────────────────────

pub fn json_to_js(value: &Json, context: &mut Context) -> JsResult<JsValue> {
    match value {
        Json::Null => Ok(JsValue::null()),
        Json::Bool(b) => Ok(JsValue::new(*b)),
        Json::Number(n) => Ok(JsValue::new(n.as_f64().unwrap_or(0.0))),
        Json::String(s) => Ok(JsValue::new(js_string!(s.as_str()))),
        Json::Array(arr) => {
            let js_arr = JsArray::new(context);
            for item in arr {
                let v = json_to_js(item, context)?;
                js_arr.push(v, context)?;
            }
            Ok(js_arr.into())
        }
        Json::Object(obj) => {
            // A one-key { __bytes } object is a binary envelope, not a plain object.
            if obj.len() == 1 {
                if let Some(Json::String(b64)) = obj.get(BYTES_KEY) {
                    let bytes = base64_decode(b64).unwrap_or_default();
                    let array = JsUint8Array::from_iter(bytes, context)?;
                    return Ok(array.into());
                }
            }

            // Values are collected first: ObjectInitializer borrows the context.
            let pairs: Vec<(String, JsValue)> = obj
                .iter()
                .map(|(k, v)| json_to_js(v, context).map(|jv| (k.clone(), jv)))
                .collect::<Result<_, _>>()?;
            let mut init = ObjectInitializer::new(context);
            for (k, v) in pairs {
                init.property(js_string!(k.as_str()), v, Attribute::all());
            }
            Ok(init.build().into())
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// JS → JSON
// ─────────────────────────────────────────────────────────────────────────────

/// Budget shared across one whole conversion.
struct Budget {
    nodes: usize,
    string_bytes: usize,
}

impl Budget {
    fn node(&mut self) -> Result<(), MarshalError> {
        self.nodes += 1;
        if self.nodes > MAX_NODES {
            return Err(MarshalError::TooManyNodes);
        }
        Ok(())
    }

    fn strings(&mut self, len: usize) -> Result<(), MarshalError> {
        self.string_bytes = self.string_bytes.saturating_add(len);
        if self.string_bytes > MAX_STRING_BYTES {
            return Err(MarshalError::TooLarge);
        }
        Ok(())
    }
}

/// Convert a JS value to JSON, enforcing depth/size caps and breaking cycles.
///
/// Cycles are replaced with `null` rather than erroring: a self-referential
/// object in a log payload should not fail the whole job.
pub fn js_to_json(value: &JsValue, context: &mut Context) -> Result<Json, MarshalError> {
    let mut budget = Budget {
        nodes: 0,
        string_bytes: 0,
    };
    let mut path: Vec<JsObject> = Vec::new();
    convert(value, context, &mut budget, &mut path, 0)
}

fn convert(
    value: &JsValue,
    context: &mut Context,
    budget: &mut Budget,
    path: &mut Vec<JsObject>,
    depth: usize,
) -> Result<Json, MarshalError> {
    budget.node()?;
    if depth > MAX_DEPTH {
        return Err(MarshalError::DepthExceeded);
    }

    match value.variant() {
        JsVariant::Null | JsVariant::Undefined => Ok(Json::Null),
        JsVariant::Boolean(b) => Ok(Json::Bool(b)),
        JsVariant::Integer32(i) => Ok(Json::Number(i.into())),
        JsVariant::Float64(f) => {
            if f.is_nan() || f.is_infinite() {
                Ok(Json::Null)
            } else {
                Ok(serde_json::Number::from_f64(f)
                    .map(Json::Number)
                    .unwrap_or(Json::Null))
            }
        }
        JsVariant::String(s) => {
            let text = s.to_std_string_escaped();
            budget.strings(text.len())?;
            Ok(Json::String(text))
        }
        JsVariant::Object(obj) => {
            let obj = obj.clone();

            // Byte views leave as a base64 envelope instead of an index map.
            if let Some(bytes) = read_bytes(&obj, context) {
                budget.strings(bytes.len())?;
                let mut map = serde_json::Map::new();
                map.insert(BYTES_KEY.to_string(), Json::String(base64_encode(&bytes)));
                return Ok(Json::Object(map));
            }

            if path.iter().any(|seen| JsObject::equals(seen, &obj)) {
                return Ok(Json::Null);
            }
            path.push(obj.clone());
            let result = convert_object(&obj, context, budget, path, depth);
            path.pop();
            result
        }
        JsVariant::BigInt(_) | JsVariant::Symbol(_) => Ok(Json::Null),
    }
}

fn convert_object(
    obj: &JsObject,
    context: &mut Context,
    budget: &mut Budget,
    path: &mut Vec<JsObject>,
    depth: usize,
) -> Result<Json, MarshalError> {
    if obj.is_array() {
        let len = obj
            .get(js_string!("length"), context)
            .ok()
            .and_then(|v| v.to_u32(context).ok())
            .unwrap_or(0);
        let mut arr = Vec::with_capacity(len.min(4096) as usize);
        for i in 0..len {
            let v = obj.get(i, context).unwrap_or(JsValue::undefined());
            arr.push(convert(&v, context, budget, path, depth + 1)?);
        }
        return Ok(Json::Array(arr));
    }

    let mut map = serde_json::Map::new();
    if let Ok(keys) = obj.own_property_keys(context) {
        for key in &keys {
            if let boa_engine::property::PropertyKey::Symbol(_) = key {
                continue;
            }
            let key_str = key.to_string();
            budget.strings(key_str.len())?;
            if let Ok(v) = obj.get(key.clone(), context) {
                map.insert(key_str, convert(&v, context, budget, path, depth + 1)?);
            }
        }
    }
    Ok(Json::Object(map))
}

/// Extract the bytes behind a `Uint8Array`-style view or a raw `ArrayBuffer`.
///
/// Returns `None` for anything that is not a byte container, including detached
/// buffers and multi-byte element types (an `Int32Array` is data, not bytes, and
/// round-trips more usefully as a plain array).
pub fn read_bytes(obj: &JsObject, context: &mut Context) -> Option<Vec<u8>> {
    if let Ok(buffer) = JsArrayBuffer::from_object(obj.clone()) {
        return buffer.data().map(|data| data.to_vec());
    }

    let view = JsTypedArray::from_object(obj.clone()).ok()?;
    // Only 1-byte element kinds are treated as opaque bytes.
    match view.kind() {
        Some(
            boa_engine::builtins::typed_array::TypedArrayKind::Uint8
            | boa_engine::builtins::typed_array::TypedArrayKind::Uint8Clamped
            | boa_engine::builtins::typed_array::TypedArrayKind::Int8,
        ) => {}
        _ => return None,
    }

    let offset = view.byte_offset(context).ok()?;
    let length = view.byte_length(context).ok()?;
    let buffer_value = view.buffer(context).ok()?;
    let buffer = JsArrayBuffer::from_object(buffer_value.as_object()?.clone()).ok()?;
    let data = buffer.data()?;
    data.get(offset..offset + length).map(<[u8]>::to_vec)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn base64_round_trips_all_byte_alignments() {
        for len in 0..32usize {
            let bytes: Vec<u8> = (0..len).map(|i| (i * 7 % 256) as u8).collect();
            let encoded = base64_encode(&bytes);
            assert_eq!(base64_decode(&encoded).as_deref(), Some(bytes.as_slice()));
        }
    }

    #[test]
    fn byte_arrays_round_trip_through_the_envelope() {
        let mut context = Context::default();
        let value = json_to_js(&json!({ BYTES_KEY: base64_encode(&[1u8, 2, 255]) }), &mut context)
            .unwrap();

        // Arrived as a real Uint8Array, not a plain object.
        let length = value
            .as_object()
            .unwrap()
            .get(js_string!("length"), &mut context)
            .unwrap();
        assert_eq!(length.to_u32(&mut context).unwrap(), 3);

        let back = js_to_json(&value, &mut context).unwrap();
        assert_eq!(back[BYTES_KEY], json!(base64_encode(&[1u8, 2, 255])));
    }

    #[test]
    fn cycles_become_null_instead_of_recursing() {
        let mut context = Context::default();
        let value = context
            .eval(boa_engine::Source::from_bytes(
                b"const a = { name: 'a' }; a.self = a; a",
            ))
            .unwrap();

        let json = js_to_json(&value, &mut context).unwrap();
        assert_eq!(json["name"], json!("a"));
        assert_eq!(json["self"], Json::Null);
    }

    #[test]
    fn deep_nesting_is_rejected() {
        let mut context = Context::default();
        let value = context
            .eval(boa_engine::Source::from_bytes(
                b"let v = 0; for (let i = 0; i < 200; i++) v = { v }; v",
            ))
            .unwrap();

        assert!(matches!(
            js_to_json(&value, &mut context),
            Err(MarshalError::DepthExceeded)
        ));
    }

    #[test]
    fn multi_byte_views_stay_plain_arrays() {
        let mut context = Context::default();
        let value = context
            .eval(boa_engine::Source::from_bytes(b"new Int32Array([1, 2])"))
            .unwrap();

        let json = js_to_json(&value, &mut context).unwrap();
        assert_eq!(json.get(BYTES_KEY), None);
    }
}
