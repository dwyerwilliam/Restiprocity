# Native loopback fixtures

The certificate and private key in this directory are public test assets, not secrets.
They are used only by ephemeral loopback HTTPS servers. Never install this certificate
in a trust store. Only the app's explicit insecure request setting may accept it.

Certificate creation: OpenSSL req -x509 -newkey rsa:2048 -nodes -days 36500,
CN api.restiprocity.test, SAN api.restiprocity.test and *.restiprocity.test.
Electron launch-only host-resolver rules map these reserved test names to loopback.
