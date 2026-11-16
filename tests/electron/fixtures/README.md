# Native loopback fixtures

The HTTP and HTTPS servers in this directory are ephemeral test fixtures. The HTTPS fixture generates a short-lived self-signed PFX directly in the operating system temporary directory with PowerShell/.NET, so it does not require installing a certificate or writing to a certificate store. The temporary key material is removed when each test finishes.

Electron launch-only host-resolver rules map the reserved test names to loopback. Only the app's explicit insecure request setting may accept the self-signed certificate.

`electronApp.ts` is what every native test launches and closes the app with (`launchApp`, `closeApp`) and the `test` they use. An app that has not exited 20 s after being asked to quit is killed, and the error says whether its main process still answered, whether its window's script did, and (Linux, macOS) the state of each of its processes, followed by the app's output since the quit request.
