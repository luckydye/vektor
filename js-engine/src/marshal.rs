use boa_engine::{
    Context, JsResult, JsValue,
    js_string,
    object::ObjectInitializer,
    object::builtins::JsArray,
    property::Attribute,
    value::JsVariant,
};
use serde_json::Value as Json;

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
            // Collect values first to avoid conflicting borrows on ObjectInitializer
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

pub fn js_to_json(value: &JsValue, context: &mut Context) -> Json {
    match value.variant() {
        JsVariant::Null | JsVariant::Undefined => Json::Null,
        JsVariant::Boolean(b) => Json::Bool(b),
        JsVariant::Integer32(i) => Json::Number(i.into()),
        JsVariant::Float64(f) => {
            if f.is_nan() || f.is_infinite() {
                Json::Null
            } else {
                serde_json::Number::from_f64(f)
                    .map(Json::Number)
                    .unwrap_or(Json::Null)
            }
        }
        JsVariant::String(s) => Json::String(s.to_std_string_escaped()),
        JsVariant::Object(obj) => {
            if obj.is_array() {
                let len = obj
                    .get(js_string!("length"), context)
                    .ok()
                    .and_then(|v| v.to_u32(context).ok())
                    .unwrap_or(0);
                let mut arr = Vec::with_capacity(len as usize);
                for i in 0..len {
                    let v = obj.get(i, context).unwrap_or(JsValue::undefined());
                    arr.push(js_to_json(&v, context));
                }
                Json::Array(arr)
            } else {
                let mut map = serde_json::Map::new();
                if let Ok(keys) = obj.own_property_keys(context) {
                    for key in &keys {
                        if let boa_engine::property::PropertyKey::Symbol(_) = key {
                            continue;
                        }
                        let key_str = key.to_string();
                        if let Ok(v) = obj.get(key.clone(), context) {
                            map.insert(key_str, js_to_json(&v, context));
                        }
                    }
                }
                Json::Object(map)
            }
        }
        JsVariant::BigInt(_) | JsVariant::Symbol(_) => Json::Null,
    }
}
