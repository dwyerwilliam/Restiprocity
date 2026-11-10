# TLS test fixture

`restiprocity-test.key.pem` and `restiprocity-test.cert.pem` are a **test-only** self-signed key pair for the loopback HTTPS server in `../nativeServers.ts`. Nothing trusts them, and nothing outside the test suite uses them. The private key is public on purpose: it only has to make the server present a certificate that the strict session rejects and the insecure session accepts.

- Subject `CN=api.restiprocity.test`; subject alternative names `api.restiprocity.test` and `tls.restiprocity.test` (the tests map `*.restiprocity.test` to 127.0.0.1 with `--host-rules`).
- RSA 2048, SHA-256, valid 2026-11-10 to 2046-11-05.
- A fixed pair replaces a certificate generated at run time with PowerShell/.NET, which only worked on Windows.

To regenerate (Git Bash on Windows needs `MSYS_NO_PATHCONV=1` so the subject is not rewritten as a path), then convert the files to LF if your OpenSSL wrote CRLF:

```sh
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 7300 \
  -keyout restiprocity-test.key.pem -out restiprocity-test.cert.pem \
  -subj "/CN=api.restiprocity.test" \
  -addext "subjectAltName=DNS:api.restiprocity.test,DNS:tls.restiprocity.test" \
  -addext "basicConstraints=critical,CA:FALSE" \
  -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
  -addext "extendedKeyUsage=serverAuth"
```

A secret scanner may flag the key. It protects nothing.
