#![deny(clippy::all)]

use std::sync::{Mutex, OnceLock};

use fastembed::{
    InitOptionsUserDefined, Pooling, QuantizationMode, TextEmbedding, TokenizerFiles,
    UserDefinedEmbeddingModel,
};
use napi::bindgen_prelude::{AsyncTask, Error, Result, Status, Task};
use napi::Env;
use napi_derive::napi;

const EMBEDDED_MODEL_ID: &str =
    "Qdrant/bge-small-en-v1.5-onnx-Q@c32e6154d1bb7a0e47c5e745fd895e7700f44385";
const EMBEDDED_ONNX: &[u8] = include_bytes!("../models/model_optimized.onnx");
const CONFIG: &[u8] = include_bytes!("../models/config.json");
const SPECIAL_TOKENS_MAP: &[u8] = include_bytes!("../models/special_tokens_map.json");
const TOKENIZER: &[u8] = include_bytes!("../models/tokenizer.json");
const TOKENIZER_CONFIG: &[u8] = include_bytes!("../models/tokenizer_config.json");
const BAAI_MIT_LICENSE: &str = include_str!("../licenses/BAAI-bge-small-en-v1.5-MIT.txt");
const QDRANT_APACHE_LICENSE: &str =
    include_str!("../licenses/Qdrant-bge-small-en-v1.5-onnx-Q-Apache-2.0.txt");

static MODEL: OnceLock<std::result::Result<Mutex<TextEmbedding>, String>> = OnceLock::new();

fn napi_error(message: impl ToString) -> Error {
    Error::new(Status::GenericFailure, message.to_string())
}

fn normalize_embedding(embedding: Vec<f32>) -> Vec<f32> {
    let magnitude = embedding
        .iter()
        .map(|value| value * value)
        .sum::<f32>()
        .sqrt();

    if magnitude == 0.0 {
        return embedding;
    }

    embedding
        .into_iter()
        .map(|value| value / magnitude)
        .collect()
}

fn embedded_model() -> Result<&'static Mutex<TextEmbedding>> {
    MODEL
        .get_or_init(|| {
            let model = UserDefinedEmbeddingModel::new(
                EMBEDDED_ONNX.to_vec(),
                TokenizerFiles {
                    tokenizer_file: TOKENIZER.to_vec(),
                    config_file: CONFIG.to_vec(),
                    special_tokens_map_file: SPECIAL_TOKENS_MAP.to_vec(),
                    tokenizer_config_file: TOKENIZER_CONFIG.to_vec(),
                },
            )
            .with_pooling(Pooling::Cls)
            .with_quantization(QuantizationMode::Static);

            TextEmbedding::try_new_from_user_defined(model, InitOptionsUserDefined::new())
                .map(Mutex::new)
                .map_err(|error| error.to_string())
        })
        .as_ref()
        .map_err(napi_error)
}

pub struct EmbedTask {
    texts: Vec<String>,
}

impl Task for EmbedTask {
    type Output = Vec<Vec<f64>>;
    type JsValue = Vec<Vec<f64>>;

    fn compute(&mut self) -> Result<Self::Output> {
        if self.texts.is_empty() {
            return Ok(Vec::new());
        }

        let mut model = embedded_model()?
            .lock()
            .map_err(|_| napi_error("Embedding model lock was poisoned"))?;
        let embeddings = model.embed(self.texts.clone(), None).map_err(napi_error)?;

        Ok(embeddings
            .into_iter()
            .map(|embedding| {
                normalize_embedding(embedding)
                    .into_iter()
                    .map(f64::from)
                    .collect()
            })
            .collect())
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi]
pub fn embed(texts: Vec<String>) -> AsyncTask<EmbedTask> {
    AsyncTask::new(EmbedTask { texts })
}

#[napi(object)]
pub struct EmbeddedModelLicense {
    pub name: String,
    pub source: String,
    pub text: String,
}

#[napi]
pub fn embedded_model_licenses() -> Vec<EmbeddedModelLicense> {
    vec![
        EmbeddedModelLicense {
            name: "Qdrant/bge-small-en-v1.5-onnx-Q (ONNX conversion)".to_string(),
            source: EMBEDDED_MODEL_ID.to_string(),
            text: QDRANT_APACHE_LICENSE.to_string(),
        },
        EmbeddedModelLicense {
            name: "BAAI/bge-small-en-v1.5 (upstream model)".to_string(),
            source: "https://huggingface.co/BAAI/bge-small-en-v1.5".to_string(),
            text: BAAI_MIT_LICENSE.to_string(),
        },
    ]
}
