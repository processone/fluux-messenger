//! XMPP XML framing: stanza extraction and RFC 7395 translation.
//!
//! Handles bidirectional conversion between traditional XMPP TCP stream framing
//! (`<stream:stream>`, `</stream:stream>`) and RFC 7395 WebSocket framing
//! (`<open/>`, `<close/>`). Also provides stateful stanza boundary extraction
//! from a TCP byte stream.

use std::borrow::Cow;
use quick_xml::errors::SyntaxError;
use quick_xml::events::Event;
use quick_xml::Reader;
use tracing::error;

/// Translate RFC 7395 WebSocket framing to traditional XMPP
/// - `<open/>` → `<stream:stream>`
/// - `<close/>` → `</stream:stream>`
/// - Regular stanzas pass through unchanged (zero-copy via Cow)
pub fn translate_ws_to_tcp<'a>(text: &'a str) -> Cow<'a, str> {
    let trimmed = text.trim();

    // Check if this is an <open/> tag (RFC 7395 WebSocket framing)
    if trimmed.starts_with("<open ") || trimmed.starts_with("<open>") {
        // Parse attributes using quick-xml for robust handling of quoting styles
        let mut reader = Reader::from_str(trimmed);
        reader.config_mut().check_end_names = false;

        let event = reader.read_event();
        let attrs = match &event {
            Ok(Event::Empty(e)) | Ok(Event::Start(e)) => Some(e.attributes()),
            _ => None,
        };

        let mut to = String::new();
        let mut version = String::from("1.0");
        let mut lang = String::new();

        if let Some(attrs) = attrs {
            for attr in attrs.flatten() {
                let key = String::from_utf8_lossy(attr.key.as_ref());
                let value = String::from_utf8_lossy(&attr.value);
                match key.as_ref() {
                    "to" => to = value.to_string(),
                    "version" => version = value.to_string(),
                    "xml:lang" => lang = value.to_string(),
                    _ => {} // Skip xmlns and other attributes
                }
            }
        }

        // Build <stream:stream> tag
        let mut stream_tag = String::from("<?xml version='1.0'?><stream:stream");
        if !to.is_empty() {
            stream_tag.push_str(&format!(" to='{}'", to));
        }
        stream_tag.push_str(&format!(" version='{}'", version));
        if !lang.is_empty() {
            stream_tag.push_str(&format!(" xml:lang='{}'", lang));
        }
        stream_tag.push_str(" xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams'>");

        return Cow::Owned(stream_tag);
    }

    // Check if this is a <close/> tag
    if trimmed.starts_with("<close") {
        return Cow::Borrowed("</stream:stream>");
    }

    // Regular stanza - pass through unchanged (zero-copy)
    Cow::Borrowed(text)
}

/// Translate traditional XMPP stream framing to RFC 7395 WebSocket framing
/// - `<stream:stream ...>` → `<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" .../>`
/// - `</stream:stream>` → `<close xmlns="urn:ietf:params:xml:ns:xmpp-framing"/>`
/// - `<stream:features>` → `<features xmlns="http://etherx.jabber.org/streams">` (strip prefix, add xmlns)
/// - `<stream:error>` → `<error xmlns="http://etherx.jabber.org/streams">` (strip prefix, add xmlns)
/// - Regular stanzas pass through unchanged (zero-copy via Cow)
///
/// The stream: prefix rewriting is necessary because in RFC 7395 WebSocket framing,
/// each stanza is a standalone XML document without the <stream:stream> parent that
/// declares xmlns:stream. Without rewriting, the xmpp.js client cannot resolve the
/// stream: prefix and silently drops these elements.
pub fn translate_tcp_to_ws<'a>(text: &'a str) -> Cow<'a, str> {
    let trimmed = text.trim();

    // Check for </stream:stream> closing tag
    if trimmed == "</stream:stream>" {
        return Cow::Borrowed(r#"<close xmlns="urn:ietf:params:xml:ns:xmpp-framing"/>"#);
    }

    // Check for <stream:stream ...> or <?xml ...?><stream:stream ...> opening
    // Strip optional XML declaration first
    let stream_text = if trimmed.starts_with("<?xml") {
        // Find end of XML declaration and skip it
        match trimmed.find("?>") {
            Some(pos) => trimmed[pos + 2..].trim(),
            None => trimmed,
        }
    } else {
        trimmed
    };

    if stream_text.starts_with("<stream:stream ") {
        // Extract attributes from <stream:stream> using quick-xml for robust parsing
        let mut reader = Reader::from_str(stream_text);
        reader.config_mut().check_end_names = false;

        if let Ok(Event::Start(e)) = reader.read_event() {
            let mut to = String::new();
            let mut from = String::new();
            let mut version = String::new();
            let mut lang = String::new();
            let mut id = String::new();

            for attr in e.attributes().flatten() {
                let key = String::from_utf8_lossy(attr.key.as_ref());
                let value = String::from_utf8_lossy(&attr.value);
                match key.as_ref() {
                    "to" => to = value.to_string(),
                    "from" => from = value.to_string(),
                    "version" => version = value.to_string(),
                    "xml:lang" => lang = value.to_string(),
                    "id" => id = value.to_string(),
                    _ => {} // Skip xmlns and xmlns:stream
                }
            }

            let mut open_tag = String::from(r#"<open xmlns="urn:ietf:params:xml:ns:xmpp-framing""#);
            if !to.is_empty() {
                open_tag.push_str(&format!(r#" to="{}""#, to));
            }
            if !from.is_empty() {
                open_tag.push_str(&format!(r#" from="{}""#, from));
            }
            if !id.is_empty() {
                open_tag.push_str(&format!(r#" id="{}""#, id));
            }
            if !version.is_empty() {
                open_tag.push_str(&format!(r#" version="{}""#, version));
            }
            if !lang.is_empty() {
                open_tag.push_str(&format!(r#" xml:lang="{}""#, lang));
            }
            open_tag.push_str("/>");

            return Cow::Owned(open_tag);
        }
    }

    // Rewrite stream:-prefixed elements (e.g. <stream:features>, <stream:error>).
    // In TCP XMPP, these rely on xmlns:stream declared on the parent <stream:stream>.
    // In RFC 7395 WebSocket framing, each message is a standalone XML fragment, so the
    // stream: prefix is unresolvable. We strip the prefix and add an explicit xmlns.
    if trimmed.starts_with("<stream:") && !trimmed.starts_with("<stream:stream") {
        // Strip "stream:" prefix in a single pass. Check "</stream:" before "<stream:"
        // since the shorter pattern is a prefix of the longer one.
        let mut result = String::with_capacity(trimmed.len());
        let mut remaining = trimmed;
        while !remaining.is_empty() {
            if remaining.starts_with("</stream:") {
                result.push_str("</");
                remaining = &remaining[9..]; // skip "</stream:"
            } else if remaining.starts_with("<stream:") {
                result.push('<');
                remaining = &remaining[8..]; // skip "<stream:"
            } else {
                result.push(remaining.as_bytes()[0] as char);
                remaining = &remaining[1..];
            }
        }
        // Inject xmlns on the root element (after the first tag name, before '>', ' ', or '/')
        if let Some(pos) = result.find([' ', '>', '/']) {
            let ch = result.as_bytes()[pos] as char;
            // Check if the root tag already has xmlns= (only check up to first '>')
            let root_tag_end = result.find('>').unwrap_or(result.len());
            let root_tag = &result[..root_tag_end];
            if !root_tag.contains("xmlns=") {
                let xmlns_attr = r#" xmlns="http://etherx.jabber.org/streams""#;
                let mut rewritten = String::with_capacity(result.len() + xmlns_attr.len());
                rewritten.push_str(&result[..pos]);
                rewritten.push_str(xmlns_attr);
                rewritten.push(ch);
                rewritten.push_str(&result[pos + 1..]);
                return Cow::Owned(rewritten);
            }
        }
        return Cow::Owned(result);
    }

    // Regular stanza — pass through unchanged (zero-copy)
    Cow::Borrowed(text)
}

/// State machine for stanza boundary detection (inspired by Fluux Agent's StanzaParser).
#[derive(Debug, Clone, Copy, PartialEq)]
enum ParserState {
    /// Waiting for a stanza to start (between stanzas, or before stream open).
    Idle,
    /// Inside a top-level stanza, collecting events.
    InStanza,
}

/// Convert a byte slice to a String, trying zero-copy UTF-8 first.
fn bytes_to_string(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => String::from_utf8_lossy(bytes).into_owned(),
    }
}

/// Extract a single complete XMPP stanza from the given buffer slice.
///
/// Returns `Some((stanza_string, bytes_consumed))` if a complete stanza was found,
/// or `None` if the buffer doesn't contain a complete stanza yet.
/// The caller is responsible for advancing past the consumed bytes.
pub fn extract_stanza(buffer: &[u8]) -> Option<(String, usize)> {
    // Special case: check for stream closing tag first
    // This appears alone without a matching opening tag in the buffer
    let trimmed = buffer.iter().position(|&b| b != b' ' && b != b'\t' && b != b'\n' && b != b'\r');
    if let Some(start) = trimmed {
        if buffer[start..].starts_with(b"</stream:stream>") {
            let tag_end = start + b"</stream:stream>".len();
            return Some(("</stream:stream>".to_string(), tag_end));
        }
    }

    let mut reader = Reader::from_reader(buffer);
    reader.config_mut().trim_text(false);
    reader.config_mut().check_end_names = false; // Faster parsing

    let mut depth: u32 = 0;
    let mut state = ParserState::Idle;
    let mut stanza_start: usize = 0;

    loop {
        let pos = reader.buffer_position() as usize;

        match reader.read_event() {
            Ok(Event::Decl(_)) | Ok(Event::PI(_)) | Ok(Event::Comment(_)) | Ok(Event::DocType(_)) => {
                // Stream-level metadata — ignore
                continue;
            }
            Ok(Event::Start(e)) => {
                let local_name = e.name().local_name();

                // Handle stream:stream wrapper
                if state == ParserState::Idle && (local_name.as_ref() == b"stream" || e.name().as_ref() == b"stream:stream") {
                    // Return the stream opening immediately
                    let tag_end = reader.buffer_position() as usize;
                    return Some((bytes_to_string(&buffer[0..tag_end]), tag_end));
                }

                depth += 1;

                // Start of a new top-level stanza (depth goes from 0 to 1)
                if state == ParserState::Idle && depth == 1 {
                    state = ParserState::InStanza;
                    stanza_start = pos;
                }
            }
            Ok(Event::Empty(e)) => {
                let local_name = e.name().local_name();

                // Self-closing stream:stream (rare, but possible)
                if state == ParserState::Idle && (local_name.as_ref() == b"stream" || e.name().as_ref() == b"stream:stream") {
                    let tag_end = reader.buffer_position() as usize;
                    return Some((bytes_to_string(&buffer[0..tag_end]), tag_end));
                }

                // Self-closing top-level stanza (e.g., <presence/>, <r xmlns='urn:xmpp:sm:3'/>)
                if state == ParserState::Idle && depth == 0 {
                    let tag_end = reader.buffer_position() as usize;
                    return Some((bytes_to_string(&buffer[pos..tag_end]), tag_end));
                }

                // Otherwise it's a self-closing child element, continue
            }
            Ok(Event::Text(_)) | Ok(Event::CData(_)) => {
                // Text content — don't change depth
            }
            Ok(Event::End(e)) => {
                let local_name = e.name().local_name();

                // Handle </stream:stream> closing
                if (local_name.as_ref() == b"stream" || e.name().as_ref() == b"stream:stream") && depth == 0 {
                    let tag_end = reader.buffer_position() as usize;
                    return Some(("</stream:stream>".to_string(), tag_end));
                }

                depth = depth.saturating_sub(1);

                // Stanza complete when depth returns to 0 while InStanza
                if state == ParserState::InStanza && depth == 0 {
                    let tag_end = reader.buffer_position() as usize;
                    return Some((bytes_to_string(&buffer[stanza_start..tag_end]), tag_end));
                }
            }
            Ok(Event::Eof) => {
                // Incomplete stanza - need more data from TCP
                return None;
            }
            Err(quick_xml::Error::Syntax(SyntaxError::UnclosedTag)) => {
                // Expected during TCP streaming: the buffer contains a
                // partial stanza that will be completed by the next read.
                return None;
            }
            Err(e) => {
                error!(error = ?e, "XML parsing error");
                return None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- extract_stanza tests ---

    #[test]
    fn test_extract_stream_opening() {
        let buf = b"<?xml version='1.0'?><stream:stream xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' version='1.0'>";
        let (stanza, consumed) = extract_stanza(buf).unwrap();
        assert!(stanza.contains("<stream:stream"));
        assert_eq!(consumed, buf.len());
    }

    #[test]
    fn test_extract_stream_features() {
        let buf = b"<stream:features><mechanisms xmlns='urn:ietf:params:xml:ns:xmpp-sasl'><mechanism>PLAIN</mechanism><mechanism>SCRAM-SHA-1</mechanism></mechanisms><starttls xmlns='urn:ietf:params:xml:ns:xmpp-tls'/></stream:features>";
        let (stanza, consumed) = extract_stanza(buf).unwrap();
        // Should extract the ENTIRE <stream:features> element
        assert!(stanza.contains("<stream:features"));
        assert!(stanza.contains("</stream:features>"));
        assert!(stanza.contains("<mechanisms"));
        assert!(stanza.contains("</mechanisms>"));
        assert!(stanza.contains("<starttls"));
        assert_eq!(consumed, buf.len());
    }

    #[test]
    fn test_extract_simple_stanza() {
        let buf = b"<presence/>";
        let (stanza, consumed) = extract_stanza(buf).unwrap();
        assert_eq!(stanza, "<presence/>");
        assert_eq!(consumed, buf.len());
    }

    #[test]
    fn test_extract_nested_stanza() {
        let buf = b"<iq type='result'><query xmlns='jabber:iq:roster'><item jid='user@example.com'/></query></iq>";
        let (stanza, consumed) = extract_stanza(buf).unwrap();
        assert!(stanza.contains("<iq"));
        assert!(stanza.contains("</iq>"));
        assert!(stanza.contains("<query"));
        assert!(stanza.contains("</query>"));
        assert_eq!(consumed, buf.len());
    }

    #[test]
    fn test_extract_multiple_stanzas() {
        let buf = b"<presence from='user@example.com'/><message to='other@example.com'><body>Hello</body></message>";
        let mut offset = 0;

        // First extraction
        let (stanza1, consumed1) = extract_stanza(&buf[offset..]).unwrap();
        offset += consumed1;
        assert!(stanza1.contains("<presence"));
        assert!(!stanza1.contains("<message"));

        // Second extraction from remaining slice
        let (stanza2, consumed2) = extract_stanza(&buf[offset..]).unwrap();
        offset += consumed2;
        assert!(stanza2.contains("<message"));
        assert!(stanza2.contains("Hello"));
        assert_eq!(offset, buf.len());
    }

    #[test]
    fn test_extract_incomplete_stanza() {
        // Incomplete XML - missing closing tag
        let buf = b"<iq type='get'><query xmlns='jabber:iq:roster'>";
        // Should return None because stanza is incomplete
        assert!(extract_stanza(buf).is_none());
    }

    #[test]
    fn test_extract_stream_closing() {
        let buf = b"</stream:stream>";
        let (stanza, consumed) = extract_stanza(buf).unwrap();
        assert_eq!(stanza, "</stream:stream>");
        assert_eq!(consumed, buf.len());
    }

    // --- translate_ws_to_tcp tests ---

    #[test]
    fn test_translate_open_to_stream() {
        let open_tag = r#"<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" to="example.com" version="1.0" xml:lang="en"/>"#;
        let translated = translate_ws_to_tcp(open_tag);

        assert!(translated.contains("<?xml version='1.0'?>"));
        assert!(translated.contains("<stream:stream"));
        assert!(translated.contains("to='example.com'"));
        assert!(translated.contains("version='1.0'"));
        assert!(translated.contains("xml:lang='en'"));
        assert!(translated.contains("xmlns='jabber:client'"));
        assert!(translated.contains("xmlns:stream='http://etherx.jabber.org/streams'"));
    }

    #[test]
    fn test_translate_close_to_stream_end() {
        let close_tag = r#"<close xmlns="urn:ietf:params:xml:ns:xmpp-framing"/>"#;
        let translated = translate_ws_to_tcp(close_tag);
        assert_eq!(&*translated, "</stream:stream>");
    }

    #[test]
    fn test_translate_regular_stanza_passthrough() {
        let stanza = r#"<presence type="unavailable"/>"#;
        let translated = translate_ws_to_tcp(stanza);
        assert_eq!(&*translated, stanza);
    }

    // --- translate_tcp_to_ws tests ---

    #[test]
    fn test_tcp_to_ws_stream_opening() {
        let stream_tag = r#"<?xml version='1.0'?><stream:stream xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' from='example.com' id='abc123' version='1.0' xml:lang='en'>"#;
        let translated = translate_tcp_to_ws(stream_tag);

        assert!(translated.contains(r#"xmlns="urn:ietf:params:xml:ns:xmpp-framing""#));
        assert!(translated.contains(r#"from="example.com""#));
        assert!(translated.contains(r#"id="abc123""#));
        assert!(translated.contains(r#"version="1.0""#));
        assert!(translated.contains(r#"xml:lang="en""#));
        assert!(translated.ends_with("/>"));
        // Should NOT contain xmlns:stream or jabber:client — those are XMPP TCP-specific
        assert!(!translated.contains("jabber:client"));
        assert!(!translated.contains("xmlns:stream"));
    }

    #[test]
    fn test_tcp_to_ws_stream_opening_without_xml_decl() {
        let stream_tag = r#"<stream:stream xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' to='example.com' version='1.0'>"#;
        let translated = translate_tcp_to_ws(stream_tag);

        assert!(translated.contains(r#"xmlns="urn:ietf:params:xml:ns:xmpp-framing""#));
        assert!(translated.contains(r#"to="example.com""#));
        assert!(translated.contains(r#"version="1.0""#));
        assert!(translated.ends_with("/>"));
    }

    #[test]
    fn test_tcp_to_ws_stream_closing() {
        let translated = translate_tcp_to_ws("</stream:stream>");
        assert_eq!(&*translated, r#"<close xmlns="urn:ietf:params:xml:ns:xmpp-framing"/>"#);
    }

    #[test]
    fn test_tcp_to_ws_regular_stanza_passthrough() {
        let stanza = r#"<message to="user@example.com"><body>Hello</body></message>"#;
        let translated = translate_tcp_to_ws(stanza);
        assert_eq!(&*translated, stanza);
    }

    #[test]
    fn test_tcp_to_ws_self_closing_stanza_passthrough() {
        let stanza = r#"<presence type="unavailable"/>"#;
        let translated = translate_tcp_to_ws(stanza);
        assert_eq!(&*translated, stanza);
    }

    // --- Roundtrip tests (WS→TCP→WS) ---

    #[test]
    fn test_roundtrip_open_tag() {
        // Client sends RFC 7395 <open/>, proxy translates to <stream:stream>, server responds
        // with <stream:stream>, proxy translates back to <open/>
        let client_open = r#"<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" to="example.com" version="1.0" xml:lang="en"/>"#;
        let tcp_form = translate_ws_to_tcp(client_open);
        assert!(tcp_form.contains("<stream:stream"));

        // Simulate server response (different attributes: has from, id; no to)
        let server_response = r#"<?xml version='1.0'?><stream:stream xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' from='example.com' id='sess123' version='1.0' xml:lang='en'>"#;
        let ws_form = translate_tcp_to_ws(server_response);
        assert!(ws_form.starts_with("<open "));
        assert!(ws_form.contains(r#"from="example.com""#));
        assert!(ws_form.contains(r#"id="sess123""#));
        assert!(ws_form.ends_with("/>"));
    }

    #[test]
    fn test_roundtrip_close_tag() {
        let client_close = r#"<close xmlns="urn:ietf:params:xml:ns:xmpp-framing"/>"#;
        let tcp_form = translate_ws_to_tcp(client_close);
        assert_eq!(&*tcp_form, "</stream:stream>");

        let ws_form = translate_tcp_to_ws(&tcp_form);
        assert_eq!(&*ws_form, r#"<close xmlns="urn:ietf:params:xml:ns:xmpp-framing"/>"#);
    }

    // --- Additional extract_stanza tests for real-world XMPP patterns ---

    #[test]
    fn test_extract_sm_stanzas() {
        // XEP-0198 Stream Management <r/> and <a/> are self-closing top-level stanzas
        let buf = b"<r xmlns='urn:xmpp:sm:3'/><a xmlns='urn:xmpp:sm:3' h='5'/>";
        let mut offset = 0;

        let (stanza1, consumed1) = extract_stanza(&buf[offset..]).unwrap();
        offset += consumed1;
        assert!(stanza1.contains("<r xmlns"));
        assert!(stanza1.contains("urn:xmpp:sm:3"));

        let (stanza2, consumed2) = extract_stanza(&buf[offset..]).unwrap();
        offset += consumed2;
        assert!(stanza2.contains("<a xmlns"));
        assert!(stanza2.contains("h="));
        assert_eq!(offset, buf.len());
    }

    #[test]
    fn test_extract_message_with_body_text() {
        let buf = b"<message from='alice@example.com' to='bob@example.com' type='chat'><body>Hello, world!</body></message>";
        let (stanza, consumed) = extract_stanza(buf).unwrap();
        assert!(stanza.contains("Hello, world!"));
        assert!(stanza.contains("<body>"));
        assert!(stanza.contains("</body>"));
        assert!(stanza.contains("</message>"));
        assert_eq!(consumed, buf.len());
    }

    #[test]
    fn test_extract_stanzas_with_xml_declaration_prefix() {
        // Real server response: XML declaration followed by stream:stream followed by features
        let buf = b"<?xml version='1.0'?><stream:stream xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' from='example.com' version='1.0'>";
        let (stanza, consumed) = extract_stanza(buf).unwrap();
        // The XML declaration should be included in the returned stream tag
        assert!(stanza.contains("<?xml"));
        assert!(stanza.contains("<stream:stream"));
        assert_eq!(consumed, buf.len());
    }

    #[test]
    fn test_extract_stanza_with_multiple_children_and_text() {
        // A typical message stanza with multiple children
        let buf = b"<message type='chat' from='user@example.com/res'><body>Test</body><active xmlns='http://jabber.org/protocol/chatstates'/></message>";
        let (stanza, consumed) = extract_stanza(buf).unwrap();
        assert!(stanza.contains("<body>Test</body>"));
        assert!(stanza.contains("<active xmlns="));
        assert!(stanza.contains("</message>"));
        assert_eq!(consumed, buf.len());
    }

    #[test]
    fn test_extract_empty_buffer() {
        assert!(extract_stanza(b"").is_none());
    }

    #[test]
    fn test_extract_whitespace_only_buffer() {
        assert!(extract_stanza(b"   \n  ").is_none());
    }

    #[test]
    fn test_extract_stream_close_with_leading_whitespace() {
        let buf = b"  </stream:stream>";
        let (stanza, consumed) = extract_stanza(buf).unwrap();
        assert_eq!(stanza, "</stream:stream>");
        assert_eq!(consumed, buf.len());
    }

    #[test]
    fn test_extract_iq_result_with_bind() {
        // Typical bind result after authentication
        let buf = b"<iq type='result' id='bind_1'><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'><jid>user@example.com/resource</jid></bind></iq>";
        let (stanza, consumed) = extract_stanza(buf).unwrap();
        assert!(stanza.contains("user@example.com/resource"));
        assert!(stanza.contains("</bind>"));
        assert!(stanza.contains("</iq>"));
        assert_eq!(consumed, buf.len());
    }

    #[test]
    fn test_extract_three_consecutive_stanzas() {
        // Three stanzas in one buffer: self-closing, regular, self-closing
        let buf = b"<r xmlns='urn:xmpp:sm:3'/><message to='a@b'><body>Hi</body></message><a xmlns='urn:xmpp:sm:3' h='1'/>";
        let mut offset = 0;

        let (s1, c1) = extract_stanza(&buf[offset..]).unwrap();
        offset += c1;
        assert!(s1.contains("<r xmlns"));

        let (s2, c2) = extract_stanza(&buf[offset..]).unwrap();
        offset += c2;
        assert!(s2.contains("<message"));
        assert!(s2.contains("Hi"));

        let (s3, c3) = extract_stanza(&buf[offset..]).unwrap();
        offset += c3;
        assert!(s3.contains("<a xmlns"));
        assert!(s3.contains("h="));
        assert_eq!(offset, buf.len());
    }

    // --- stream: prefix rewriting tests ---

    #[test]
    fn test_tcp_to_ws_stream_features_prefix_rewrite() {
        // This is the critical test: <stream:features> from TCP must be rewritten
        // to <features xmlns="..."> for WebSocket, because the stream: prefix
        // relies on xmlns:stream from the parent <stream:stream> which doesn't
        // exist in RFC 7395 standalone framing.
        let features = r#"<stream:features><mechanisms xmlns='urn:ietf:params:xml:ns:xmpp-sasl'><mechanism>PLAIN</mechanism><mechanism>SCRAM-SHA-1</mechanism></mechanisms><starttls xmlns='urn:ietf:params:xml:ns:xmpp-tls'/></stream:features>"#;
        let translated = translate_tcp_to_ws(features);

        // Should strip stream: prefix and add explicit xmlns
        assert!(translated.starts_with("<features "));
        assert!(translated.contains(r#"xmlns="http://etherx.jabber.org/streams""#));
        assert!(translated.ends_with("</features>"));
        // Children should be unchanged
        assert!(translated.contains("<mechanisms xmlns="));
        assert!(translated.contains("<starttls xmlns="));
        // No stream: prefix should remain
        assert!(!translated.contains("stream:features"));
    }

    #[test]
    fn test_tcp_to_ws_stream_error_prefix_rewrite() {
        let error = r#"<stream:error><not-well-formed xmlns='urn:ietf:params:xml:ns:xmpp-streams'/></stream:error>"#;
        let translated = translate_tcp_to_ws(error);

        assert!(translated.starts_with("<error "));
        assert!(translated.contains(r#"xmlns="http://etherx.jabber.org/streams""#));
        assert!(translated.ends_with("</error>"));
        assert!(translated.contains("<not-well-formed xmlns="));
        assert!(!translated.contains("stream:error"));
    }

    #[test]
    fn test_tcp_to_ws_does_not_rewrite_stream_stream() {
        // <stream:stream> should be handled by the open tag logic, NOT the prefix rewriter
        let stream = r#"<stream:stream xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' from='example.com' version='1.0'>"#;
        let translated = translate_tcp_to_ws(stream);
        // Should be converted to <open/>, not just prefix-stripped
        assert!(translated.starts_with("<open "));
        assert!(translated.contains("urn:ietf:params:xml:ns:xmpp-framing"));
    }

    #[test]
    fn test_tcp_to_ws_non_stream_prefix_passthrough() {
        // Regular stanzas without stream: prefix should pass through unchanged
        let iq = r#"<iq type='result' id='1'><query xmlns='jabber:iq:roster'/></iq>"#;
        let translated = translate_tcp_to_ws(iq);
        assert_eq!(&*translated, iq);
    }

    // --- STARTTLS protocol parsing tests ---
    // These test the stanza extraction and parsing patterns used by perform_starttls()

    #[test]
    fn test_starttls_extract_server_stream_and_features() {
        // Simulates the server response after proxy sends <stream:stream>:
        // First the server sends back its own <stream:stream>, then <stream:features>
        let buf = b"<?xml version='1.0'?><stream:stream xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' from='example.com' id='abc' version='1.0'><stream:features><starttls xmlns='urn:ietf:params:xml:ns:xmpp-tls'><required/></starttls><mechanisms xmlns='urn:ietf:params:xml:ns:xmpp-sasl'><mechanism>SCRAM-SHA-1</mechanism></mechanisms></stream:features>";
        let mut offset = 0;

        // First extraction: stream header
        let (stanza1, c1) = extract_stanza(&buf[offset..]).unwrap();
        offset += c1;
        assert!(stanza1.contains("<stream:stream"));
        assert!(stanza1.contains("from='example.com'"));

        // Second extraction: stream features
        let (stanza2, c2) = extract_stanza(&buf[offset..]).unwrap();
        offset += c2;
        assert!(stanza2.contains("<stream:features"));
        assert!(stanza2.contains("</stream:features>"));
        // Verify <starttls> is present (this is what perform_starttls checks)
        assert!(stanza2.contains("<starttls"));
        assert!(stanza2.contains("urn:ietf:params:xml:ns:xmpp-tls"));
        assert_eq!(offset, buf.len());
    }

    #[test]
    fn test_starttls_extract_features_without_starttls() {
        // Server that does NOT offer STARTTLS (e.g., already on direct TLS)
        let buf = b"<stream:features><mechanisms xmlns='urn:ietf:params:xml:ns:xmpp-sasl'><mechanism>SCRAM-SHA-1</mechanism></mechanisms><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'/></stream:features>";

        let (stanza, consumed) = extract_stanza(buf).unwrap();
        // Verify <starttls> is NOT present
        assert!(!stanza.contains("<starttls"));
        assert_eq!(consumed, buf.len());
        // The perform_starttls function would return an error in this case
    }

    #[test]
    fn test_starttls_extract_proceed() {
        // Server sends <proceed/> after receiving <starttls/>
        let buf = b"<proceed xmlns='urn:ietf:params:xml:ns:xmpp-tls'/>";

        let (stanza, consumed) = extract_stanza(buf).unwrap();
        assert!(stanza.contains("<proceed"));
        assert!(stanza.contains("urn:ietf:params:xml:ns:xmpp-tls"));
        assert_eq!(consumed, buf.len());
    }

    #[test]
    fn test_starttls_extract_failure() {
        // Server sends <failure/> if STARTTLS is rejected
        let buf = b"<failure xmlns='urn:ietf:params:xml:ns:xmpp-tls'/>";

        let (stanza, consumed) = extract_stanza(buf).unwrap();
        assert!(stanza.contains("<failure"));
        assert!(stanza.contains("urn:ietf:params:xml:ns:xmpp-tls"));
        assert_eq!(consumed, buf.len());
    }

    #[test]
    fn test_starttls_features_with_required_flag() {
        // STARTTLS with <required/> child means server mandates TLS
        let buf = b"<stream:features><starttls xmlns='urn:ietf:params:xml:ns:xmpp-tls'><required/></starttls></stream:features>";

        let (stanza, consumed) = extract_stanza(buf).unwrap();
        assert!(stanza.contains("<starttls"));
        assert!(stanza.contains("<required/>"));
        assert_eq!(consumed, buf.len());
    }

    #[test]
    fn test_starttls_features_optional() {
        // STARTTLS without <required/> means TLS is optional
        let buf = b"<stream:features><starttls xmlns='urn:ietf:params:xml:ns:xmpp-tls'/><mechanisms xmlns='urn:ietf:params:xml:ns:xmpp-sasl'><mechanism>PLAIN</mechanism></mechanisms></stream:features>";

        let (stanza, consumed) = extract_stanza(buf).unwrap();
        assert!(stanza.contains("<starttls"));
        assert_eq!(consumed, buf.len());
        // We still negotiate STARTTLS even when optional (security best practice)
    }

    #[test]
    fn test_starttls_fragmented_stream_and_features() {
        // Test incremental parsing: stream header arrives first, features arrive later
        // This simulates TCP fragmentation

        // Fragment 1: just the stream header
        let buf1 = b"<?xml version='1.0'?><stream:stream xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams' from='example.com' version='1.0'>";
        let (stanza1, consumed1) = extract_stanza(buf1).unwrap();
        assert!(stanza1.contains("<stream:stream"));
        assert_eq!(consumed1, buf1.len());

        // Fragment 2: incomplete features
        let buf2 = b"<stream:features><starttls xmlns='urn:ietf:params:xml:ns:xmpp-tls'/>";
        // Should be None — features not complete yet
        assert!(extract_stanza(buf2).is_none());

        // Fragment 2 + 3: complete features
        let mut buf2_full = buf2.to_vec();
        buf2_full.extend_from_slice(b"</stream:features>");
        let (stanza3, _) = extract_stanza(&buf2_full).unwrap();
        assert!(stanza3.contains("<stream:features"));
        assert!(stanza3.contains("<starttls"));
        assert!(stanza3.contains("</stream:features>"));
    }

    #[test]
    fn test_starttls_stream_open_format() {
        // Verify the stream open format that perform_starttls sends matches what
        // extract_stanza can parse from the server response
        let buf = b"<?xml version='1.0'?><stream:stream to='example.com' version='1.0' xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams'>";
        let (stanza, consumed) = extract_stanza(buf).unwrap();
        assert!(stanza.contains("<stream:stream"));
        assert!(stanza.contains("to='example.com'"));
        assert_eq!(consumed, buf.len());
    }

    // --- Cow<str> passthrough tests ---

    #[test]
    fn test_ws_to_tcp_passthrough_is_borrowed() {
        // Regular stanzas should return Cow::Borrowed (zero-copy)
        let stanza = r#"<message to="user@example.com"><body>Hello</body></message>"#;
        let result = translate_ws_to_tcp(stanza);
        assert!(matches!(result, Cow::Borrowed(_)));
        assert_eq!(&*result, stanza);
    }

    #[test]
    fn test_tcp_to_ws_passthrough_is_borrowed() {
        // Regular stanzas should return Cow::Borrowed (zero-copy)
        let stanza = r#"<iq type='result' id='1'><query xmlns='jabber:iq:roster'/></iq>"#;
        let result = translate_tcp_to_ws(stanza);
        assert!(matches!(result, Cow::Borrowed(_)));
        assert_eq!(&*result, stanza);
    }

    #[test]
    fn test_tcp_to_ws_close_is_borrowed() {
        // </stream:stream> → static string, should be Cow::Borrowed
        let result = translate_tcp_to_ws("</stream:stream>");
        assert!(matches!(result, Cow::Borrowed(_)));
    }

    #[test]
    fn test_ws_to_tcp_close_is_borrowed() {
        // <close/> → static string, should be Cow::Borrowed
        let result = translate_ws_to_tcp(r#"<close xmlns="urn:ietf:params:xml:ns:xmpp-framing"/>"#);
        assert!(matches!(result, Cow::Borrowed(_)));
    }

    // --- translate_ws_to_tcp edge case tests ---

    #[test]
    fn test_ws_to_tcp_open_with_single_quotes() {
        // quick-xml handles both quote styles
        let open_tag = r#"<open xmlns='urn:ietf:params:xml:ns:xmpp-framing' to='example.com' version='1.0'/>"#;
        let translated = translate_ws_to_tcp(open_tag);
        assert!(translated.contains("<stream:stream"));
        assert!(translated.contains("to='example.com'"));
        assert!(translated.contains("version='1.0'"));
    }

    #[test]
    fn test_ws_to_tcp_open_without_to() {
        // <open> without a 'to' attribute
        let open_tag = r#"<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" version="1.0"/>"#;
        let translated = translate_ws_to_tcp(open_tag);
        assert!(translated.contains("<stream:stream"));
        assert!(translated.contains("version='1.0'"));
        assert!(!translated.contains("to="));
    }

    #[test]
    fn test_ws_to_tcp_open_with_extra_attributes() {
        // Unknown attributes should be ignored
        let open_tag = r#"<open xmlns="urn:ietf:params:xml:ns:xmpp-framing" to="example.com" version="1.0" custom="foo"/>"#;
        let translated = translate_ws_to_tcp(open_tag);
        assert!(translated.contains("<stream:stream"));
        assert!(translated.contains("to='example.com'"));
        assert!(!translated.contains("custom"));
    }

    // --- nested stream: prefix rewriting test ---

    #[test]
    fn test_tcp_to_ws_stream_error_with_nested_stream_text() {
        // <stream:error> containing <stream:text> — both stream: prefixes should be stripped
        let error = r#"<stream:error><conflict xmlns='urn:ietf:params:xml:ns:xmpp-streams'/><text xmlns='urn:ietf:params:xml:ns:xmpp-streams'>Replaced by new connection</text></stream:error>"#;
        let translated = translate_tcp_to_ws(error);

        assert!(translated.starts_with("<error "));
        assert!(translated.contains(r#"xmlns="http://etherx.jabber.org/streams""#));
        assert!(translated.ends_with("</error>"));
        assert!(!translated.contains("stream:error"));
        assert!(translated.contains("<conflict xmlns="));
        assert!(translated.contains("Replaced by new connection"));
    }

    // --- extract_stanza with CDATA and XML entities ---

    #[test]
    fn test_extract_stanza_with_xml_entities() {
        let buf = b"<message from='a@b' to='c@d'><body>Hello &amp; welcome &lt;friend&gt;</body></message>";
        let (stanza, consumed) = extract_stanza(buf).unwrap();
        assert!(stanza.contains("&amp;"));
        assert!(stanza.contains("&lt;friend&gt;"));
        assert!(stanza.contains("</message>"));
        assert_eq!(consumed, buf.len());
    }

    #[test]
    fn test_extract_stanza_with_cdata() {
        let buf = b"<message from='a@b'><body><![CDATA[Some <raw> content & stuff]]></body></message>";
        let (stanza, consumed) = extract_stanza(buf).unwrap();
        assert!(stanza.contains("CDATA"));
        assert!(stanza.contains("</message>"));
        assert_eq!(consumed, buf.len());
    }
}
