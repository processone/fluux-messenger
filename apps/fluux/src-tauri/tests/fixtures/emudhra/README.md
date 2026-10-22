# eMudhra distrust regression (FLM-28)

Public certificates only; no private keys.

- Twelve leaf-first chains: https://emudhra.we-have-a-problem.com/chains.zip
  (published capture: 2026-10-20; retrieved 2026-10-21).
- `roots.pem`: all four public roots from
  https://emudhra.we-have-a-problem.com/roots.json, deliberately retained as
  trusted anchors to exercise key distrust rather than missing-root errors.
- `control.pem`: the real chain served by `demo.fluux.io:443` on 2026-10-21.
- `control-root.pem`: https://letsencrypt.org/certs/isrgrootx1.pem.

The shared test exercises Rustls' server verifier with each independently
resolved lockfile. Verification time is the capture time (1792594452 seconds
since Unix epoch), so certificate expiry cannot hide a distrust regression.
All twelve malicious chains must fail specifically with `CertDistrusted`;
the legitimate Fluux chain must pass hostname and server-use verification.
Network handshakes are a separate manual check, not a network-dependent CI test.

Run the deterministic regression with both lockfiles:

```sh
cargo test --locked --manifest-path apps/fluux/src-tauri/Cargo.toml --test tls_distrust
cargo test --locked --manifest-path apps/fluux/src-tauri/nse-openpgp/Cargo.toml --test tls_distrust
```

Opt-in, unauthenticated network probes (emSign, AAA, legitimate Fluux control):

```sh
cargo test --locked --manifest-path apps/fluux/src-tauri/Cargo.toml --features production-tls emudhra_live -- --ignored --nocapture
cargo test --locked --manifest-path apps/fluux/src-tauri/nse-openpgp/Cargo.toml emudhra_live -- --ignored --nocapture
```

These probe the TLS connector shared by desktop XMPP DirectTLS/STARTTLS,
Tauri HTTP's bundled-root client, native HTTP's platform verifier, and the
notification engine's real TLS configuration. They do not log in to XMPP or
send files. The HTTPS test hosts supply TLS on port 443, not an XMPP service.
A socket/DNS/timeout failure is not a successful rejection. Rebuild iOS and its
notification extension separately; the extension has its own lockfile. Tests
on a Mac do not establish device trust-policy updates on an iPhone.
