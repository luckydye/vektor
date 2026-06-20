//! Native image transforms for Vektor — a minimal replacement for the subset of
//! `sharp` the app uses (resize + format conversion + metadata).
//!
//! Compiled to a N-API addon (`.node`) that Bun embeds directly into the
//! single-file executable. See `app/native/image/README.md`.

use image::{DynamicImage, GenericImageView, ImageFormat, Rgb, RgbImage};
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;
use std::io::Cursor;

/// Transform options mirroring `TransformParams` in `src/files/transforms.ts`.
#[napi(object)]
pub struct TransformOptions {
    /// Target width in px. 0 = unconstrained.
    pub w: u32,
    /// Target height in px. 0 = unconstrained.
    pub h: u32,
    /// Output format: "webp" | "jpeg" | "png" | "" (empty = keep original).
    pub format: String,
    /// Encode quality 1–100 (used by webp/jpeg; ignored by png/gif).
    pub quality: u32,
}

#[napi(object)]
pub struct Metadata {
    pub width: u32,
    pub height: u32,
    /// "png" | "jpeg" | "webp" | "gif" | "unknown".
    pub format: String,
}

fn format_name(f: ImageFormat) -> &'static str {
    match f {
        ImageFormat::Png => "png",
        ImageFormat::Jpeg => "jpeg",
        ImageFormat::WebP => "webp",
        ImageFormat::Gif => "gif",
        _ => "unknown",
    }
}

fn err(msg: impl ToString) -> napi::Error {
    napi::Error::from_reason(msg.to_string())
}

/// Decode an image and report its dimensions + detected format.
#[napi]
pub fn metadata(input: Buffer) -> napi::Result<Metadata> {
    let bytes: &[u8] = &input;
    let fmt = image::guess_format(bytes).map_err(err)?;
    let img = image::load_from_memory(bytes).map_err(err)?;
    let (width, height) = img.dimensions();
    Ok(Metadata {
        width,
        height,
        format: format_name(fmt).to_string(),
    })
}

/// Decode → optional resize (fit-inside, never enlarge) → encode.
#[napi]
pub fn transform(input: Buffer, opts: TransformOptions) -> napi::Result<Buffer> {
    let bytes: &[u8] = &input;
    let src_fmt = image::guess_format(bytes).ok();
    let mut img = image::load_from_memory(bytes).map_err(err)?;

    if opts.w > 0 || opts.h > 0 {
        let (ow, oh) = img.dimensions();
        // "inside" fit: scale by the smaller axis ratio; an unset axis (0) is
        // unconstrained. `withoutEnlargement` caps the scale at 1.0.
        let sw = if opts.w > 0 {
            opts.w as f64 / ow as f64
        } else {
            f64::INFINITY
        };
        let sh = if opts.h > 0 {
            opts.h as f64 / oh as f64
        } else {
            f64::INFINITY
        };
        let scale = sw.min(sh).min(1.0);
        if scale < 1.0 {
            let nw = ((ow as f64 * scale).round() as u32).max(1);
            let nh = ((oh as f64 * scale).round() as u32).max(1);
            img = img.resize_exact(nw, nh, image::imageops::FilterType::Lanczos3);
        }
    }

    let quality = opts.quality.clamp(1, 100) as u8;
    let target = if opts.format.is_empty() {
        src_fmt.unwrap_or(ImageFormat::Png)
    } else {
        match opts.format.as_str() {
            "webp" => ImageFormat::WebP,
            "jpeg" => ImageFormat::Jpeg,
            "png" => ImageFormat::Png,
            other => return Err(err(format!("unsupported output format: {other}"))),
        }
    };

    Ok(encode(&img, target, quality)?.into())
}

/// Generate a solid-colour image — used by the test suite to mint fixtures
/// without a separate image dependency.
#[napi]
pub fn encode_solid(
    width: u32,
    height: u32,
    r: u8,
    g: u8,
    b: u8,
    format: String,
    quality: u32,
) -> napi::Result<Buffer> {
    let img = DynamicImage::ImageRgb8(RgbImage::from_pixel(width, height, Rgb([r, g, b])));
    let fmt = match format.as_str() {
        "png" => ImageFormat::Png,
        "jpeg" => ImageFormat::Jpeg,
        "webp" => ImageFormat::WebP,
        "gif" => ImageFormat::Gif,
        other => return Err(err(format!("unsupported format: {other}"))),
    };
    Ok(encode(&img, fmt, quality.clamp(1, 100) as u8)?.into())
}

fn encode(img: &DynamicImage, fmt: ImageFormat, quality: u8) -> napi::Result<Vec<u8>> {
    match fmt {
        // libwebp lossy encode honours the quality parameter; the pure-Rust
        // path in `image` is lossless only.
        ImageFormat::WebP => {
            let rgba = img.to_rgba8();
            let (w, h) = rgba.dimensions();
            let encoder = webp::Encoder::from_rgba(&rgba, w, h);
            Ok(encoder.encode(quality as f32).to_vec())
        }
        ImageFormat::Jpeg => {
            let rgb = img.to_rgb8();
            let mut buf = Cursor::new(Vec::new());
            let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality);
            enc.encode_image(&rgb).map_err(err)?;
            Ok(buf.into_inner())
        }
        other => {
            let mut buf = Cursor::new(Vec::new());
            img.write_to(&mut buf, other).map_err(err)?;
            Ok(buf.into_inner())
        }
    }
}
