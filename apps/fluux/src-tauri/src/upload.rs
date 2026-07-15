//! Native XEP-0363 HTTP upload with optional AES-256-GCM media encryption
//! (XEP-0454).
//!
//! The WebView invokes `upload_file` with the file bytes as Tauri's RAW IPC
//! body. This replaces the `@tauri-apps/plugin-http` upload path, whose JS
//! shim converts the whole body into a plain number array
//! (`Array.from(new Uint8Array(buffer))`) and JSON-serializes it through
//! `invoke` — ~20ms of main-thread blocking per MB, i.e. a full ~1s UI freeze
//! for a 40MB attachment. The raw IPC body is a single memcpy instead.
//!
//! Metadata rides in invoke headers (raw-body invokes carry no JSON args):
//! - `x-put-url`: XEP-0363 slot PUT URL
//! - `x-content-type`: Content-Type for the PUT
//! - `x-encrypt`: "1" to AES-256-GCM-encrypt the bytes before upload
//! - `x-upload-id`: opaque id echoed in progress events
//! - `x-extra-headers`: JSON object of extra PUT headers from the slot
//!
//! Progress is emitted as `fluux://upload-progress` events (`{id, sent,
//! total}`), at most once per integer percent. Encryption matches
//! `MediaEncryption.encryptFile` on the web path: fresh 32-byte key +
//! 12-byte IV per call, 128-bit auth tag appended to the ciphertext.

use aes_gcm::aead::{Aead, OsRng};
use aes_gcm::{AeadCore, Aes256Gcm, Key, KeyInit};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::Serialize;
use std::io::Read;
use std::time::Duration;
use tauri::http::HeaderMap;
use tauri::ipc::InvokeBody;
use tauri::Emitter;

const PROGRESS_EVENT: &str = "fluux://upload-progress";
const UPLOAD_TIMEOUT_SECS: u64 = 600;

/// Parsed invoke-header metadata for one upload.
#[derive(Debug, PartialEq)]
pub struct UploadArgs {
    pub put_url: String,
    pub content_type: String,
    pub encrypt: bool,
    pub upload_id: String,
    pub extra_headers: Vec<(String, String)>,
}

/// AES-GCM key/IV returned to the WebView when `x-encrypt: 1`.
/// Base64 so it survives JSON; the JS side decodes back to `Uint8Array`.
#[derive(Serialize)]
pub struct UploadResponse {
    pub key: Option<String>,
    pub iv: Option<String>,
}

#[derive(Serialize, Clone)]
struct ProgressPayload {
    id: String,
    sent: u64,
    total: u64,
}

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Result<&'a str, String> {
    headers
        .get(name)
        .ok_or_else(|| format!("upload_file: missing required header `{name}`"))?
        .to_str()
        .map_err(|_| format!("upload_file: header `{name}` is not valid UTF-8"))
}

/// Extract upload metadata from invoke headers. Pure, unit-tested.
pub fn parse_upload_args(headers: &HeaderMap) -> Result<UploadArgs, String> {
    let extra_json = headers
        .get("x-extra-headers")
        .map(|v| v.to_str().map_err(|_| "upload_file: header `x-extra-headers` is not valid UTF-8".to_string()))
        .transpose()?
        .unwrap_or("{}");
    let extra: serde_json::Map<String, serde_json::Value> = serde_json::from_str(extra_json)
        .map_err(|e| format!("upload_file: invalid `x-extra-headers` JSON: {e}"))?;
    let extra_headers = extra
        .into_iter()
        .map(|(k, v)| match v {
            serde_json::Value::String(s) => Ok((k, s)),
            other => Err(format!("upload_file: extra header `{k}` must be a string, got {other}")),
        })
        .collect::<Result<Vec<_>, String>>()?;

    Ok(UploadArgs {
        put_url: header_str(headers, "x-put-url")?.to_string(),
        content_type: header_str(headers, "x-content-type")?.to_string(),
        encrypt: header_str(headers, "x-encrypt")? == "1",
        upload_id: header_str(headers, "x-upload-id")?.to_string(),
        extra_headers,
    })
}

/// Encrypt file bytes with a fresh AES-256-GCM key and IV.
///
/// Mirrors the WebCrypto path (`MediaEncryption.encryptFile`): the returned
/// ciphertext has the 128-bit auth tag appended, and key/IV are one-shot —
/// generated here, never accepted from a caller, so nonce reuse is
/// impossible by construction.
pub fn encrypt_for_upload(plaintext: &[u8]) -> Result<(Vec<u8>, [u8; 32], [u8; 12]), String> {
    let key = Aes256Gcm::generate_key(OsRng);
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let cipher = Aes256Gcm::new(&key);
    let ciphertext = cipher
        .encrypt(&nonce, plaintext)
        .map_err(|_| "upload_file: AES-GCM encryption failed".to_string())?;
    Ok((ciphertext, key.into(), nonce.into()))
}

/// `Read` adapter that counts bytes handed to reqwest and emits one progress
/// event per integer-percent step (plus a final 100%).
struct ProgressReader<R: Read> {
    inner: R,
    sent: u64,
    total: u64,
    last_percent: u64,
    app: tauri::AppHandle,
    upload_id: String,
}

impl<R: Read> Read for ProgressReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.sent += n as u64;
        let percent = if self.total == 0 { 100 } else { self.sent * 100 / self.total };
        if percent > self.last_percent {
            self.last_percent = percent;
            let _ = self.app.emit(
                PROGRESS_EVENT,
                ProgressPayload {
                    id: self.upload_id.clone(),
                    sent: self.sent,
                    total: self.total,
                },
            );
        }
        Ok(n)
    }
}

/// Blocking PUT of `bytes` to the slot URL. Runs inside `spawn_blocking` —
/// never on the main thread (see project rule on sync Tauri commands).
fn put_blocking(app: tauri::AppHandle, args: &UploadArgs, bytes: Vec<u8>) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(UPLOAD_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("upload_file: failed to build HTTP client: {e}"))?;

    let total = bytes.len() as u64;
    let reader = ProgressReader {
        inner: std::io::Cursor::new(bytes),
        sent: 0,
        total,
        last_percent: 0,
        app,
        upload_id: args.upload_id.clone(),
    };

    let mut request = client
        .put(&args.put_url)
        .header("Content-Type", &args.content_type)
        .body(reqwest::blocking::Body::sized(reader, total));
    for (name, value) in &args.extra_headers {
        request = request.header(name, value);
    }

    let response = request
        .send()
        .map_err(|e| format!("upload_file: PUT request failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("Upload failed: {}", response.status().as_u16()));
    }
    Ok(())
}

/// Upload a file to an XEP-0363 slot, optionally AES-256-GCM-encrypting it
/// first. File bytes arrive as the raw IPC body — do NOT route uploads
/// through `@tauri-apps/plugin-http`, whose number-array marshaling blocks
/// the WebView main thread for ~1s on large files.
#[tauri::command]
pub async fn upload_file(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<UploadResponse, String> {
    let args = parse_upload_args(request.headers())?;
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes.clone(),
        InvokeBody::Json(_) => {
            return Err("upload_file: expected raw body, got JSON — invoke with an ArrayBuffer/Uint8Array payload".to_string())
        }
    };

    tauri::async_runtime::spawn_blocking(move || {
        let (payload, response) = if args.encrypt {
            let (ciphertext, key, iv) = encrypt_for_upload(&bytes)?;
            (
                ciphertext,
                UploadResponse {
                    key: Some(BASE64.encode(key)),
                    iv: Some(BASE64.encode(iv)),
                },
            )
        } else {
            (bytes, UploadResponse { key: None, iv: None })
        };
        put_blocking(app, &args, payload)?;
        Ok(response)
    })
    .await
    .map_err(|e| format!("upload_file: task join error: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes_gcm::aead::Payload;
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
    fn parse_upload_args_reads_all_fields() {
        let map = headers(&[
            ("x-put-url", "https://up.example.com/slot/1"),
            ("x-content-type", "image/jpeg"),
            ("x-encrypt", "1"),
            ("x-upload-id", "abc-123"),
            ("x-extra-headers", r#"{"Authorization":"Bearer t"}"#),
        ]);
        let args = parse_upload_args(&map).unwrap();
        assert_eq!(
            args,
            UploadArgs {
                put_url: "https://up.example.com/slot/1".into(),
                content_type: "image/jpeg".into(),
                encrypt: true,
                upload_id: "abc-123".into(),
                extra_headers: vec![("Authorization".into(), "Bearer t".into())],
            }
        );
    }

    #[test]
    fn parse_upload_args_defaults_extra_headers_and_plain_mode() {
        let map = headers(&[
            ("x-put-url", "https://up.example.com/slot/2"),
            ("x-content-type", "application/pdf"),
            ("x-encrypt", "0"),
            ("x-upload-id", "id-2"),
        ]);
        let args = parse_upload_args(&map).unwrap();
        assert!(!args.encrypt);
        assert!(args.extra_headers.is_empty());
    }

    #[test]
    fn parse_upload_args_rejects_missing_url() {
        let map = headers(&[("x-content-type", "image/png")]);
        let err = parse_upload_args(&map).unwrap_err();
        assert!(err.contains("x-put-url"), "unexpected error: {err}");
    }

    #[test]
    fn encrypt_for_upload_appends_tag_and_roundtrips() {
        let plaintext = b"attachment bytes".to_vec();
        let (ciphertext, key, iv) = encrypt_for_upload(&plaintext).unwrap();

        // WebCrypto-compatible shape: ciphertext || 16-byte GCM tag.
        assert_eq!(ciphertext.len(), plaintext.len() + 16);

        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
        let decrypted = cipher
            .decrypt(
                (&iv).into(),
                Payload { msg: &ciphertext, aad: &[] },
            )
            .unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn encrypt_for_upload_generates_fresh_key_and_iv() {
        let (_, key_a, iv_a) = encrypt_for_upload(b"x").unwrap();
        let (_, key_b, iv_b) = encrypt_for_upload(b"x").unwrap();
        assert_ne!(key_a, key_b);
        assert_ne!(iv_a, iv_b);
    }
}
