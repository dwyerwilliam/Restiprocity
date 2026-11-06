# Native loopback fixtures

The HTTP and HTTPS servers in this directory are ephemeral test fixtures. The HTTPS fixture generates a short-lived self-signed PFX directly in the operating system temporary directory with PowerShell/.NET, so it does not require installing a certificate or writing to a certificate store. The temporary key material is removed when each test finishes.

Electron launch-only host-resolver rules map the reserved test names to loopback. Only the app's explicit insecure request setting may accept the self-signed certificate.
