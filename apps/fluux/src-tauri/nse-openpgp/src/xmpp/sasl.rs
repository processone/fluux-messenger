//! Signs the extension in: SASL2 with its own FAST token (XEP-0388, XEP-0484), then the
//! password, which also asks the server for a new token. Servers without SASL2 and Bind 2
//! get the RFC 6120 PLAIN sign-in.
use super::*;

const SASL2: &str = "urn:xmpp:sasl:2";
const FAST: &str = "urn:xmpp:fast:0";
const BIND2: &str = "urn:xmpp:bind:0";
const BIND: &str = "urn:ietf:params:xml:ns:xmpp-bind";
pub(crate) const FAST_MECHANISM: &str = "HT-SHA-256-NONE";
const TOKEN_LIMIT: usize = 1024;

/// A token the server issued during sign-in; the caller stores it for the next invocation.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct FastToken {
    pub token: String,
    #[serde(default)]
    pub expiry: String,
}

fn mechanisms(parent: &Node, ns: &str) -> Vec<String> {
    parent
        .children
        .iter()
        .filter(|c| c.name == "mechanism" && c.ns == ns)
        .map(|c| c.text.clone())
        .collect()
}

fn local_part(r: &Request) -> Result<&str> {
    r.account.split('@').next().context("user")
}

/// XEP-0484: `authcid NUL HMAC-SHA-256(token, "Initiator" || cb-data)`, with no channel binding.
fn token_response(user: &str, token: &str) -> String {
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, token.as_bytes());
    let mut response = format!("{user}\0").into_bytes();
    response.extend_from_slice(ring::hmac::sign(&key, b"Initiator").as_ref());
    B64.encode(response)
}

fn authenticate_element(r: &Request, mechanism: &str, response: &str, extra: &str) -> String {
    format!(
        "<authenticate xmlns='{SASL2}' mechanism='{mechanism}'><initial-response>{response}</initial-response>\
         <user-agent id='{}'><software>Fluux</software><device>Notification extension</device></user-agent>\
         {extra}<bind xmlns='{BIND2}'><tag>fluux-notifications</tag></bind></authenticate>",
        esc(&r.user_agent_id)
    )
}

/// Reads the server's verdict; `Ok(None)` is a refusal that leaves the stream open for another try.
fn verdict(x: &mut Xmpp, r: &Request) -> Result<Option<Option<FastToken>>> {
    let reply = stanza(&x.next()?)?;
    ensure!(reply.ns == SASL2, "SASL2 reply");
    match reply.name.as_str() {
        "failure" => Ok(None),
        "success" => {
            let jid = reply
                .child("authorization-identifier", SASL2)
                .context("authorization identifier")?;
            let (bare, resource) = jid.text.split_once('/').context("bound resource")?;
            ensure!(bare == r.account && !resource.is_empty(), "bound account");
            let token = reply.child("token", FAST).map(|t| FastToken {
                token: t.attr("token").to_owned(),
                expiry: t.attr("expiry").to_owned(),
            });
            if let Some(t) = &token {
                ensure!(
                    !t.token.is_empty() && t.token.len() <= TOKEN_LIMIT,
                    "issued token"
                );
            }
            Ok(Some(token))
        }
        _ => bail!("SASL2 step"),
    }
}

fn sasl2(x: &mut Xmpp, r: &Request, auth: &Node, issued: &mut Option<FastToken>) -> Result<()> {
    let user = local_part(r)?;
    let fast = auth
        .child("inline", SASL2)
        .and_then(|i| i.child("fast", FAST))
        .map(|f| mechanisms(f, FAST).iter().any(|m| m == FAST_MECHANISM))
        .unwrap_or(false);
    let request = format!("<request-token xmlns='{FAST}' mechanism='{FAST_MECHANISM}'/>");
    if fast && !r.fast_token.is_empty() && r.fast_token.len() <= TOKEN_LIMIT {
        // Each token sign-in asks for a successor, so a token kept without a password never reaches its expiry.
        x.send(&authenticate_element(
            r,
            FAST_MECHANISM,
            &token_response(user, &r.fast_token),
            &format!("<fast xmlns='{FAST}'/>{request}"),
        ))?;
        if let Some(token) = verdict(x, r)? {
            *issued = token;
            return Ok(());
        }
    }
    ensure!(
        !r.password.is_empty() && mechanisms(auth, SASL2).iter().any(|m| m == "PLAIN"),
        "SASL failed"
    );
    x.send(&authenticate_element(
        r,
        "PLAIN",
        &B64.encode(format!("\0{user}\0{}", r.password)),
        if fast { &request } else { "" },
    ))?;
    *issued = verdict(x, r)?.context("SASL failed")?;
    Ok(())
}

fn legacy(x: &mut Xmpp, r: &Request, features: &Node, opening: &str) -> Result<()> {
    let mechanisms = features.child("mechanisms", SASL).context("SASL")?;
    ensure!(
        mechanisms
            .children
            .iter()
            .any(|c| c.name == "mechanism" && c.ns == SASL && c.text == "PLAIN"),
        "PLAIN unavailable"
    );
    ensure!(!r.password.is_empty(), "no password");
    x.send(&format!(
        "<auth xmlns='{SASL}' mechanism='PLAIN'>{}</auth>",
        B64.encode(format!("\0{}\0{}", local_part(r)?, r.password))
    ))?;
    let auth = stanza(&x.next()?)?;
    ensure!(auth.name == "success" && auth.ns == SASL, "SASL failed");
    x.send(opening)?;
    x.features()?;
    // An unannounced, server-assigned resource never sends presence or read markers (RFC 6121 §4).
    x.send(&format!(
        "<iq type='set' id='nse-bind'><bind xmlns='{BIND}'/></iq>"
    ))?;
    let bind = x.iq("nse-bind")?;
    let jid = bind
        .child("bind", BIND)
        .and_then(|b| b.child("jid", BIND))
        .context("bind JID")?;
    ensure!(
        jid.text.split('/').next() == Some(r.account.as_str()),
        "bound account"
    );
    Ok(())
}

/// Signs in and binds a resource on a TLS stream whose `features` were just received.
/// A token the server issues is left in `issued` even when a later step fails.
pub(super) fn sign_in(
    x: &mut Xmpp,
    r: &Request,
    features: &Node,
    opening: &str,
    issued: &mut Option<FastToken>,
) -> Result<()> {
    let auth = features.child("authentication", SASL2);
    let bind2 = auth
        .and_then(|a| a.child("inline", SASL2))
        .is_some_and(|i| i.child("bind", BIND2).is_some());
    match auth {
        // XEP-0388 requires a UUID for the user agent; anything shorter is not one.
        Some(auth) if bind2 && r.user_agent_id.len() >= 32 => sasl2(x, r, auth, issued),
        _ => legacy(x, r, features, opening),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    const UA: &str = "8a1f5c1e-2f7b-4d8e-9b0a-3c4d5e6f7a8b";

    fn request(token: &str, password: &str) -> Request {
        let mut json = serde_json::json!({"account":"bob@nse.invalid", "domain":"nse.invalid", "password":password, "endpoints":[], "sender":"alice@nse.invalid", "secret_b64":"", "peers":{}, "opt_in":true, "user_agent_id":UA, "fast_token":token});
        #[cfg(feature = "synthetic-lab")]
        {
            json["root_b64"] = serde_json::Value::String(String::new());
        }
        #[cfg(not(feature = "synthetic-lab"))]
        let _ = &mut json;
        serde_json::from_value(json).unwrap()
    }

    fn features(sasl2: bool) -> Node {
        let inline = format!(
            "<inline><bind xmlns='{BIND2}'/><fast xmlns='{FAST}'><mechanism>{FAST_MECHANISM}</mechanism></fast></inline>"
        );
        let auth = if sasl2 {
            format!("<authentication xmlns='{SASL2}'><mechanism>PLAIN</mechanism>{inline}</authentication>")
        } else {
            String::new()
        };
        xml::parse(
            format!(
                "<features xmlns='{STREAM}'><mechanisms xmlns='{SASL}'><mechanism>PLAIN</mechanism></mechanisms>{auth}</features>"
            )
            .as_bytes(),
        )
        .unwrap()
    }

    fn success(token: Option<&str>) -> String {
        let token = token
            .map(|t| format!("<token xmlns='{FAST}' token='{t}' expiry='2026-11-20T00:00:00Z'/>"))
            .unwrap_or_default();
        format!("<success xmlns='{SASL2}'><authorization-identifier>bob@nse.invalid/fluux-notifications.1</authorization-identifier>{token}<bound xmlns='{BIND2}'/></success>")
    }

    fn failure() -> String {
        format!("<failure xmlns='{SASL2}'><not-authorized xmlns='{SASL}'/></failure>")
    }

    /// Answers each request ending with `until` in turn and returns what the client sent.
    fn exchange(
        replies: Vec<(&'static str, String)>,
        r: Request,
        features: Node,
    ) -> (Result<()>, Option<FastToken>, Vec<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut sent = Vec::new();
            for (until, reply) in replies {
                let mut request = Vec::new();
                while !request.ends_with(until.as_bytes()) {
                    let mut byte = [0u8];
                    if stream.read_exact(&mut byte).is_err() {
                        return sent;
                    }
                    request.push(byte[0]);
                }
                sent.push(String::from_utf8(request).unwrap());
                stream.write_all(reply.as_bytes()).unwrap();
            }
            sent
        });
        let mut x = Xmpp {
            transport: Transport::Plain(TcpStream::connect(addr).unwrap()),
            end: Instant::now() + Duration::from_secs(2),
            pending: Vec::new(),
            received: 0,
            wire: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        };
        let mut issued = None;
        let result = sign_in(&mut x, &r, &features, "<stream:stream>", &mut issued);
        drop(x);
        (result, issued, server.join().unwrap())
    }

    #[test]
    fn a_stored_token_signs_in_without_the_password() {
        let (result, issued, sent) = exchange(
            vec![("</authenticate>", success(None))],
            request("stored-token", "synthetic"),
            features(true),
        );
        result.unwrap();
        assert_eq!(issued, None);
        assert_eq!(sent.len(), 1);
        assert!(sent[0].contains(&format!("mechanism='{FAST_MECHANISM}'")));
        assert!(sent[0].contains(&token_response("bob", "stored-token")));
        assert!(sent[0].contains(&format!("<user-agent id='{UA}'>")));
        assert!(sent[0].contains(&format!(
            "<request-token xmlns='{FAST}' mechanism='{FAST_MECHANISM}'/>"
        )));
        assert!(!sent[0].contains(&B64.encode("\0bob\0synthetic")));
    }

    #[test]
    fn a_rotated_token_is_kept() {
        let (result, issued, _) = exchange(
            vec![("</authenticate>", success(Some("rotated")))],
            request("stored-token", ""),
            features(true),
        );
        result.unwrap();
        assert_eq!(issued.unwrap().token, "rotated");
    }

    #[test]
    fn a_refused_token_falls_back_to_the_password_and_requests_a_new_one() {
        let (result, issued, sent) = exchange(
            vec![
                ("</authenticate>", failure()),
                ("</authenticate>", success(Some("fresh"))),
            ],
            request("stale-token", "synthetic"),
            features(true),
        );
        result.unwrap();
        assert_eq!(issued.unwrap().token, "fresh");
        assert!(sent[1].contains("mechanism='PLAIN'"));
        assert!(sent[1].contains(&B64.encode("\0bob\0synthetic")));
        assert!(sent[1].contains(&format!(
            "<request-token xmlns='{FAST}' mechanism='{FAST_MECHANISM}'/>"
        )));
    }

    #[test]
    fn without_a_token_the_password_requests_one() {
        let (result, issued, sent) = exchange(
            vec![("</authenticate>", success(Some("first")))],
            request("", "synthetic"),
            features(true),
        );
        result.unwrap();
        assert_eq!(issued.unwrap().token, "first");
        assert_eq!(sent.len(), 1);
        assert!(sent[0].contains("mechanism='PLAIN'"));
    }

    #[test]
    fn a_refused_token_without_a_password_fails() {
        let (result, issued, sent) = exchange(
            vec![("</authenticate>", failure())],
            request("stale-token", ""),
            features(true),
        );
        assert!(result.is_err());
        assert_eq!(issued, None);
        assert_eq!(sent.len(), 1);
    }

    #[test]
    fn a_session_bound_to_another_account_is_refused() {
        let other = success(Some("issued")).replace("bob@nse.invalid", "mallory@nse.invalid");
        let (result, _, _) = exchange(
            vec![("</authenticate>", other)],
            request("stored-token", ""),
            features(true),
        );
        assert!(result.is_err());
    }

    #[test]
    fn servers_without_sasl2_get_the_plain_sign_in() {
        let bound = format!("<iq type='result' id='nse-bind'><bind xmlns='{BIND}'><jid>bob@nse.invalid/r</jid></bind></iq>");
        let (result, issued, sent) = exchange(
            vec![
                ("</auth>", format!("<success xmlns='{SASL}'/>")),
                (
                    "<stream:stream>",
                    format!("<stream:stream xmlns:stream='{STREAM}'><stream:features/>"),
                ),
                ("</iq>", bound),
            ],
            request("stored-token", "synthetic"),
            features(false),
        );
        result.unwrap();
        assert_eq!(issued, None);
        assert!(sent[0].starts_with(&format!("<auth xmlns='{SASL}' mechanism='PLAIN'>")));
    }
}
