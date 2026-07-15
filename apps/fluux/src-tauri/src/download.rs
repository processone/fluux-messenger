//! Native HTTP download with optional AES-256-GCM media decryption
//! (XEP-0454).
//!
//! The WebView invokes `download_file` and gets the response bytes back as
//! Tauri's RAW IPC body (`tauri::ipc::Response`). This replaces the
//! `@tauri-apps/plugin-http` download path, whose `fetch_read_body` loop
//! returns every response chunk as a plain JS number array through JSON
//! invoke — ~20ms of main-thread blocking per MB, i.e. chunked UI stalls
//! when fetching large attachments/media (same `[MainThreadStall]` class as
//! the upload side fixed in `upload.rs`). The raw IPC body is a single
//! memcpy instead.
//!
//! Metadata rides in invoke headers, mirroring `upload_file`:
//! - `x-get-url`: URL to GET
//! - `x-download-id`: opaque id echoed in progress events
//! - `x-decrypt-key` / `x-decrypt-iv`: base64 AES-256-GCM key (32 bytes) and
//!   IV (12 bytes); when present the response body is decrypted in Rust
//!   before being returned (XEP-0454 aesgcm attachments)
//!
//! Progress is emitted as `fluux://download-progress` events
//! (`{id, received, total}`), at most once per integer percent while the
//! Content-Length is known, plus a final event.
//!
//! A raw IPC response carries no headers, so the returned body is a small
//! envelope: a 4-byte little-endian JSON length, the JSON metadata
//! (`{"contentType": ...}`), then the file bytes. `tauriDownload.ts` parses
//! it back apart.

use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, Key, KeyInit};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::Serialize;
use std::io::Read;
use std::time::Duration;
use tauri::http::HeaderMap;
use tauri::Emitter;

const PROGRESS_EVENT: &str = "fluux://download-progress";
const DOWNLOAD_TIMEOUT_SECS: u64 = 600;
const READ_CHUNK_BYTES: usize = 64 * 1024;

/// Parsed invoke-header metadata for one download.
#[derive(Debug, PartialEq)]
pub struct DownloadArgs {
    pub get_url: String,
    pub download_id: String,
    /// AES-256-GCM (key, IV) when the payload must be decrypted in Rust.
    pub decrypt: Option<([u8; 32], [u8; 12])>,
}

#[derive(Serialize, Clone)]
struct ProgressPayload {
    id: String,
    received: u64,
    total: u64,
}

#[derive(Serialize)]
struct EnvelopeMeta<'a> {
    #[serde(rename = "contentType")]
    content_type: Option<&'a str>,
}

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Result<&'a str, String> {
    headers
        .get(name)
        .ok_or_else(|| format!("download_file: missing required header `{name}`"))?
        .to_str()
        .map_err(|_| format!("download_file: header `{name}` is not valid UTF-8"))
}

fn decode_fixed<const N: usize>(headers: &HeaderMap, name: &str) -> Result<[u8; N], String> {
    let raw = header_str(headers, name)?;
    let bytes = BASE64
        .decode(raw)
        .map_err(|e| format!("download_file: header `{name}` is not valid base64: {e}"))?;
    <[u8; N]>::try_from(bytes.as_slice())
        .map_err(|_| format!("download_file: header `{name}` must decode to {N} bytes, got {}", bytes.len()))
}

/// Extract download metadata from invoke headers. Pure, unit-tested.
pub fn parse_download_args(headers: &HeaderMap) -> Result<DownloadArgs, String> {
    let has_key = headers.contains_key("x-decrypt-key");
    let has_iv = headers.contains_key("x-decrypt-iv");
    let decrypt = match (has_key, has_iv) {
        (true, true) => Some((
            decode_fixed::<32>(headers, "x-decrypt-key")?,
            decode_fixed::<12>(headers, "x-decrypt-iv")?,
        )),
        (false, false) => None,
        _ => {
            return Err(
                "download_file: `x-decrypt-key` and `x-decrypt-iv` must be provided together".to_string(),
            )
        }
    };

    Ok(DownloadArgs {
        get_url: header_str(headers, "x-get-url")?.to_string(),
        download_id: header_str(headers, "x-download-id")?.to_string(),
        decrypt,
    })
}

/// Decrypt an XEP-0454 attachment body (ciphertext with the 128-bit GCM tag
/// appended — the shape both `MediaEncryption.encryptFile` and
/// `upload::encrypt_for_upload` produce).
pub fn decrypt_for_download(
    ciphertext: &[u8],
    key: &[u8; 32],
    iv: &[u8; 12],
) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    cipher
        .decrypt(iv.into(), ciphertext)
        .map_err(|_| "download_file: AES-GCM decryption failed (wrong key/IV or corrupt payload)".to_string())
}

/// Wrap the response body in the raw-IPC envelope:
/// `[4-byte LE meta length][meta JSON][body bytes]`.
pub fn build_response_envelope(content_type: Option<&str>, body: &[u8]) -> Vec<u8> {
    let meta = serde_json::to_vec(&EnvelopeMeta { content_type })
        .expect("EnvelopeMeta serialization cannot fail");
    let mut out = Vec::with_capacity(4 + meta.len() + body.len());
    out.extend_from_slice(&(meta.len() as u32).to_le_bytes());
    out.extend_from_slice(&meta);
    out.extend_from_slice(body);
    out
}

/// Blocking GET of the download URL. Runs inside `spawn_blocking` — never on
/// the main thread (see project rule on sync Tauri commands). Emits one
/// progress event per integer-percent step while Content-Length is known,
/// plus a final event.
fn get_blocking(
    app: tauri::AppHandle,
    args: &DownloadArgs,
) -> Result<(Vec<u8>, Option<String>), String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(DOWNLOAD_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("download_file: failed to build HTTP client: {e}"))?;

    let mut response = client
        .get(&args.get_url)
        .send()
        .map_err(|e| format!("download_file: GET request failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("Download failed: {}", response.status().as_u16()));
    }

    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let total = response.content_length().unwrap_or(0);

    let mut bytes: Vec<u8> = Vec::new();
    let mut buf = [0u8; READ_CHUNK_BYTES];
    let mut received: u64 = 0;
    let mut last_percent: u64 = 0;
    loop {
        let n = response
            .read(&mut buf)
            .map_err(|e| format!("download_file: reading response body failed: {e}"))?;
        if n == 0 {
            break;
        }
        bytes.extend_from_slice(&buf[..n]);
        received += n as u64;
        // checked_div: None when Content-Length was unknown (total == 0) —
        // no intermediate events, just the final one below.
        if let Some(percent) = (received * 100).checked_div(total) {
            if percent > last_percent {
                last_percent = percent;
                let _ = app.emit(
                    PROGRESS_EVENT,
                    ProgressPayload { id: args.download_id.clone(), received, total },
                );
            }
        }
    }
    // Final event — also covers the unknown-Content-Length case.
    let _ = app.emit(
        PROGRESS_EVENT,
        ProgressPayload {
            id: args.download_id.clone(),
            received,
            total: if total > 0 { total } else { received },
        },
    );

    Ok((bytes, content_type))
}

/// Download a file, optionally AES-256-GCM-decrypting it (XEP-0454), and
/// return the bytes as the raw IPC body. Do NOT route large downloads
/// through `@tauri-apps/plugin-http`, whose chunked number-array marshaling
/// blocks the WebView main thread ~20ms per MB.
#[tauri::command]
pub async fn download_file(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<tauri::ipc::Response, String> {
    let args = parse_download_args(request.headers())?;

    tauri::async_runtime::spawn_blocking(move || {
        let (body, content_type) = get_blocking(app, &args)?;
        let payload = match &args.decrypt {
            Some((key, iv)) => decrypt_for_download(&body, key, iv)?,
            None => body,
        };
        Ok(tauri::ipc::Response::new(build_response_envelope(
            content_type.as_deref(),
            &payload,
        )))
    })
    .await
    .map_err(|e| format!("download_file: task join error: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::upload::encrypt_for_upload;
    use tauri::http::HeaderValue;

    fn headers(entries: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (k, v) in entries {
            map.insert(
                tauri::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v).unwrap(),
            );
        }
        map
    }

    #[test]
    fn parse_download_args_reads_plain_fields() {
        let map = headers(&[
            ("x-get-url", "https://dl.example.com/file/1"),
            ("x-download-id", "dl-123"),
        ]);
        let args = parse_download_args(&map).unwrap();
        assert_eq!(
            args,
            DownloadArgs {
                get_url: "https://dl.example.com/file/1".into(),
                download_id: "dl-123".into(),
                decrypt: None,
            }
        );
    }

    #[test]
    fn parse_download_args_decodes_key_and_iv() {
        let key = [7u8; 32];
        let iv = [9u8; 12];
        let map = headers(&[
            ("x-get-url", "https://dl.example.com/file/2"),
            ("x-download-id", "dl-2"),
            ("x-decrypt-key", &BASE64.encode(key)),
            ("x-decrypt-iv", &BASE64.encode(iv)),
        ]);
        let args = parse_download_args(&map).unwrap();
        assert_eq!(args.decrypt, Some((key, iv)));
    }

    #[test]
    fn parse_download_args_rejects_missing_url() {
        let map = headers(&[("x-download-id", "dl-3")]);
        let err = parse_download_args(&map).unwrap_err();
        assert!(err.contains("x-get-url"), "unexpected error: {err}");
    }

    #[test]
    fn parse_download_args_rejects_key_without_iv() {
        let map = headers(&[
            ("x-get-url", "https://dl.example.com/file/4"),
            ("x-download-id", "dl-4"),
            ("x-decrypt-key", &BASE64.encode([1u8; 32])),
        ]);
        let err = parse_download_args(&map).unwrap_err();
        assert!(err.contains("together"), "unexpected error: {err}");
    }

    #[test]
    fn parse_download_args_rejects_wrong_key_length() {
        let map = headers(&[
            ("x-get-url", "https://dl.example.com/file/5"),
            ("x-download-id", "dl-5"),
            ("x-decrypt-key", &BASE64.encode([1u8; 16])),
            ("x-decrypt-iv", &BASE64.encode([2u8; 12])),
        ]);
        let err = parse_download_args(&map).unwrap_err();
        assert!(err.contains("32 bytes"), "unexpected error: {err}");
    }

    #[test]
    fn parse_download_args_rejects_invalid_base64() {
        let map = headers(&[
            ("x-get-url", "https://dl.example.com/file/6"),
            ("x-download-id", "dl-6"),
            ("x-decrypt-key", "!!!not-base64!!!"),
            ("x-decrypt-iv", &BASE64.encode([2u8; 12])),
        ]);
        let err = parse_download_args(&map).unwrap_err();
        assert!(err.contains("base64"), "unexpected error: {err}");
    }

    #[test]
    fn decrypt_for_download_roundtrips_upload_encryption() {
        // The download decryptor must accept exactly what the upload
        // encryptor (and the WebCrypto path it mirrors) produces.
        let plaintext = b"attachment bytes".to_vec();
        let encrypted = encrypt_for_upload(&plaintext).unwrap();
        let decrypted =
            decrypt_for_download(&encrypted.ciphertext, &encrypted.key, &encrypted.iv).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn decrypt_for_download_rejects_tampered_ciphertext() {
        let mut encrypted = encrypt_for_upload(b"payload").unwrap();
        encrypted.ciphertext[0] ^= 0xff;
        let err =
            decrypt_for_download(&encrypted.ciphertext, &encrypted.key, &encrypted.iv).unwrap_err();
        assert!(err.contains("decryption failed"), "unexpected error: {err}");
    }

    #[test]
    fn build_response_envelope_prefixes_meta_json() {
        let envelope = build_response_envelope(Some("image/png"), &[1, 2, 3]);
        let meta_len = u32::from_le_bytes(envelope[0..4].try_into().unwrap()) as usize;
        let meta: serde_json::Value =
            serde_json::from_slice(&envelope[4..4 + meta_len]).unwrap();
        assert_eq!(meta["contentType"], "image/png");
        assert_eq!(&envelope[4 + meta_len..], &[1, 2, 3]);
    }

    #[test]
    fn build_response_envelope_encodes_missing_content_type_as_null() {
        let envelope = build_response_envelope(None, &[]);
        let meta_len = u32::from_le_bytes(envelope[0..4].try_into().unwrap()) as usize;
        let meta: serde_json::Value =
            serde_json::from_slice(&envelope[4..4 + meta_len]).unwrap();
        assert!(meta["contentType"].is_null());
        assert_eq!(envelope.len(), 4 + meta_len);
    }
}
