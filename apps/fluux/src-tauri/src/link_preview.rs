//! Open Graph metadata for link previews, fetched natively so the request is
//! not subject to the webview's CORS policy.

use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};

/// Open Graph metadata extracted from a URL
#[derive(Serialize, Deserialize, Default)]
pub struct UrlMetadata {
    pub url: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub image: Option<String>,
    pub site_name: Option<String>,
}

/// Fetch URL and extract Open Graph metadata for link previews.
///
/// The actual work (a blocking HTTP request with a multi-second timeout plus a
/// synchronous HTML parse) runs on the blocking thread pool via
/// [`tauri::async_runtime::spawn_blocking`] so the main thread stays free. A
/// synchronous command would run this on the main thread and freeze the UI for
/// the duration of the fetch — most visibly on Linux/WebKitGTK, where the
/// webview renders on that same thread.
#[tauri::command]
pub async fn fetch_url_metadata(url: String) -> Result<UrlMetadata, String> {
    tauri::async_runtime::spawn_blocking(move || fetch_url_metadata_blocking(url))
        .await
        .unwrap_or_else(|join_err| Err(format!("Link preview task panicked: {join_err}")))
}

/// Blocking implementation of [`fetch_url_metadata`]. Runs off the main thread.
/// Uses `reqwest::blocking` and `scraper` (whose parsed document is `!Send`, so
/// it must live entirely within this synchronous function).
fn fetch_url_metadata_blocking(url: String) -> Result<UrlMetadata, String> {
    // Validate URL
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err("Invalid URL: must start with http:// or https://".to_string());
    }

    // Create HTTP client with reasonable timeout and user agent
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent("Mozilla/5.0 (compatible; FluuxBot/1.0; +https://fluux.io)")
        .build()
        .map_err(|e| {
            tracing::warn!(url = %url, "Link preview: failed to create HTTP client: {}", e);
            format!("Failed to create HTTP client: {}", e)
        })?;

    // Fetch the URL
    let response = client.get(&url).send().map_err(|e| {
        tracing::warn!(url = %url, "Link preview: failed to fetch URL: {}", e);
        format!("Failed to fetch URL: {}", e)
    })?;

    // Check content type - only process HTML
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if !content_type.contains("text/html") {
        tracing::debug!(url = %url, content_type, "Link preview: non-HTML content type, skipping");
        return Err("URL does not return HTML content".to_string());
    }

    let html = response.text().map_err(|e| {
        tracing::warn!(url = %url, "Link preview: failed to read response body: {}", e);
        format!("Failed to read response: {}", e)
    })?;

    let metadata = parse_og_metadata(&url, &html);

    // Only return success if we got at least a title
    if metadata.title.is_some() {
        Ok(metadata)
    } else {
        tracing::debug!(url = %url, "Link preview: no title found in page metadata");
        Err("Could not extract metadata from URL".to_string())
    }
}

/// Extract Open Graph (and fallback) metadata from an HTML document.
///
/// Pure function over `(request_url, html)` — no I/O — so it is unit-testable.
/// `og:*` tags win, with `<title>` and `<meta name="description">` as fallbacks;
/// `og:url` overrides the canonical url when present. Never fails: an empty
/// document yields a `UrlMetadata` with only `url` set (the caller enforces the
/// "must have a title" business rule).
fn parse_og_metadata(url: &str, html: &str) -> UrlMetadata {
    let document = Html::parse_document(html);

    // Selectors for Open Graph meta tags
    let og_title = Selector::parse(r#"meta[property="og:title"]"#).ok();
    let og_desc = Selector::parse(r#"meta[property="og:description"]"#).ok();
    let og_image = Selector::parse(r#"meta[property="og:image"]"#).ok();
    let og_site = Selector::parse(r#"meta[property="og:site_name"]"#).ok();
    let og_url = Selector::parse(r#"meta[property="og:url"]"#).ok();

    // Fallback selectors
    let title_tag = Selector::parse("title").ok();
    let meta_desc = Selector::parse(r#"meta[name="description"]"#).ok();

    let mut metadata = UrlMetadata {
        url: url.to_string(),
        ..Default::default()
    };

    // Extract og:title or fallback to <title>
    if let Some(sel) = og_title {
        metadata.title = document
            .select(&sel)
            .next()
            .and_then(|el| el.value().attr("content"))
            .map(|s| s.to_string());
    }
    if metadata.title.is_none() {
        if let Some(sel) = title_tag {
            metadata.title = document
                .select(&sel)
                .next()
                .map(|el| el.text().collect::<String>().trim().to_string())
                .filter(|s| !s.is_empty());
        }
    }

    // Extract og:description or fallback to meta description
    if let Some(sel) = og_desc {
        metadata.description = document
            .select(&sel)
            .next()
            .and_then(|el| el.value().attr("content"))
            .map(|s| s.to_string());
    }
    if metadata.description.is_none() {
        if let Some(sel) = meta_desc {
            metadata.description = document
                .select(&sel)
                .next()
                .and_then(|el| el.value().attr("content"))
                .map(|s| s.to_string());
        }
    }

    // Extract og:image
    if let Some(sel) = og_image {
        metadata.image = document
            .select(&sel)
            .next()
            .and_then(|el| el.value().attr("content"))
            .map(|s| s.to_string());
    }

    // Extract og:site_name
    if let Some(sel) = og_site {
        metadata.site_name = document
            .select(&sel)
            .next()
            .and_then(|el| el.value().attr("content"))
            .map(|s| s.to_string());
    }

    // Use og:url if available
    if let Some(sel) = og_url {
        if let Some(canonical_url) = document
            .select(&sel)
            .next()
            .and_then(|el| el.value().attr("content"))
        {
            metadata.url = canonical_url.to_string();
        }
    }

    metadata
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_og_metadata_full_open_graph() {
        let html = r#"
            <html><head>
              <meta property="og:title" content="The Rock">
              <meta property="og:description" content="A 1996 action film">
              <meta property="og:image" content="https://example.com/rock.jpg">
              <meta property="og:site_name" content="IMDb">
              <meta property="og:url" content="https://example.com/canonical">
            </head></html>
        "#;
        let m = parse_og_metadata("https://example.com/requested", html);
        assert_eq!(m.title.as_deref(), Some("The Rock"));
        assert_eq!(m.description.as_deref(), Some("A 1996 action film"));
        assert_eq!(m.image.as_deref(), Some("https://example.com/rock.jpg"));
        assert_eq!(m.site_name.as_deref(), Some("IMDb"));
        // og:url overrides the requested url as the canonical link.
        assert_eq!(m.url, "https://example.com/canonical");
    }

    #[test]
    fn test_parse_og_metadata_falls_back_to_title_and_meta_description() {
        let html = r#"
            <html><head>
              <title>  Plain Title  </title>
              <meta name="description" content="Plain description">
            </head></html>
        "#;
        let m = parse_og_metadata("https://example.com/a", html);
        // <title> is trimmed; used when og:title is absent.
        assert_eq!(m.title.as_deref(), Some("Plain Title"));
        assert_eq!(m.description.as_deref(), Some("Plain description"));
        assert_eq!(m.image, None);
        assert_eq!(m.site_name, None);
        // No og:url → keep the requested url.
        assert_eq!(m.url, "https://example.com/a");
    }

    #[test]
    fn test_parse_og_metadata_prefers_og_title_over_title_tag() {
        let html = r#"
            <html><head>
              <title>Fallback Title</title>
              <meta property="og:title" content="OG Title">
            </head></html>
        "#;
        let m = parse_og_metadata("https://example.com/a", html);
        assert_eq!(m.title.as_deref(), Some("OG Title"));
    }

    #[test]
    fn test_parse_og_metadata_empty_document_yields_only_url() {
        let m = parse_og_metadata("https://example.com/a", "<html></html>");
        assert_eq!(m.url, "https://example.com/a");
        assert_eq!(m.title, None);
        assert_eq!(m.description, None);
        assert_eq!(m.image, None);
        assert_eq!(m.site_name, None);
    }

    #[test]
    fn test_parse_og_metadata_ignores_empty_title_tag() {
        // A whitespace-only <title> must not become a spurious title.
        let m = parse_og_metadata("https://example.com/a", "<html><head><title>   </title></head></html>");
        assert_eq!(m.title, None);
    }
}
