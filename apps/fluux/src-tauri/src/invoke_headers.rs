//! Decoding of metadata passed to native commands as invoke headers.
//!
//! A header value must be ISO-8859-1, but the metadata can carry arbitrary
//! Unicode (an upload slot URL with a Cyrillic filename). The WebView sends
//! every value as base64 of its UTF-8 bytes (`tauriInvokeHeaders.ts`); these
//! helpers return the original string.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use tauri::http::HeaderMap;

/// Decode header `name` when present. `command` prefixes error messages.
pub fn optional(headers: &HeaderMap, command: &str, name: &str) -> Result<Option<String>, String> {
    let Some(value) = headers.get(name) else {
        return Ok(None);
    };
    let bytes = BASE64
        .decode(value.as_bytes())
        .map_err(|e| format!("{command}: header `{name}` is not valid base64: {e}"))?;
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| format!("{command}: header `{name}` is not valid UTF-8"))
}

/// Decode header `name`, failing when it is absent.
pub fn required(headers: &HeaderMap, command: &str, name: &str) -> Result<String, String> {
    optional(headers, command, name)?
        .ok_or_else(|| format!("{command}: missing required header `{name}`"))
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::BASE64;
    use base64::Engine;
    use tauri::http::{HeaderMap, HeaderName, HeaderValue};

    /// Build invoke headers the way the WebView encodes them.
    pub fn encoded_headers(entries: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (k, v) in entries {
            map.insert(
                HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(&BASE64.encode(v.as_bytes())).unwrap(),
            );
        }
        map
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::encoded_headers;
    use super::*;
    use tauri::http::HeaderValue;

    #[test]
    fn decodes_non_latin1_values() {
        let url = "https://up.example.com/slot/Отчёт за май.pdf";
        let map = encoded_headers(&[("x-put-url", url)]);
        assert_eq!(required(&map, "upload_file", "x-put-url").unwrap(), url);
    }

    #[test]
    fn decodes_the_webview_encoding() {
        // Same vector as `tauriInvokeHeaders.test.ts`.
        let mut map = HeaderMap::new();
        map.insert(
            "x-put-url",
            HeaderValue::from_static(
                "aHR0cHM6Ly91cC5leGFtcGxlLmNvbS9zbG90L9Ce0YLRh9GR0YIg0LfQsCDQvNCw0LkucGRm",
            ),
        );
        map.insert(
            "x-extra-headers",
            HeaderValue::from_static("eyJYLVVwbG9hZC1Ob3RlIjoi0YTQsNC50LsifQ=="),
        );
        assert_eq!(
            required(&map, "upload_file", "x-put-url").unwrap(),
            "https://up.example.com/slot/Отчёт за май.pdf"
        );
        assert_eq!(
            optional(&map, "upload_file", "x-extra-headers").unwrap(),
            Some("{\"X-Upload-Note\":\"файл\"}".to_string())
        );
    }

    #[test]
    fn keeps_existing_percent_escapes() {
        let url = "https://up.example.com/slot/%D1%84%20a+b.txt";
        let map = encoded_headers(&[("x-put-url", url)]);
        assert_eq!(required(&map, "upload_file", "x-put-url").unwrap(), url);
    }

    #[test]
    fn absent_header_is_none_or_missing() {
        let map = HeaderMap::new();
        assert_eq!(
            optional(&map, "upload_file", "x-extra-headers").unwrap(),
            None
        );
        let err = required(&map, "upload_file", "x-put-url").unwrap_err();
        assert!(
            err.contains("missing required header `x-put-url`"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn rejects_unencoded_value() {
        let mut map = HeaderMap::new();
        map.insert(
            "x-put-url",
            HeaderValue::from_static("https://up.example.com/slot/1"),
        );
        let err = required(&map, "upload_file", "x-put-url").unwrap_err();
        assert!(err.contains("base64"), "unexpected error: {err}");
    }

    #[test]
    fn rejects_invalid_utf8() {
        let mut map = HeaderMap::new();
        map.insert(
            "x-put-url",
            HeaderValue::from_str(&BASE64.encode([0xff, 0xfe])).unwrap(),
        );
        let err = required(&map, "upload_file", "x-put-url").unwrap_err();
        assert!(err.contains("UTF-8"), "unexpected error: {err}");
    }
}
