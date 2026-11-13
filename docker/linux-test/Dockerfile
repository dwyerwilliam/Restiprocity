# Linux test image for Restiprocity: the libraries Electron needs, a virtual display,
# a keyring, and the pinned Node. The source is not baked in; entrypoint.sh clones it at run time.
FROM ubuntu:24.04

ARG NODE_VERSION
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils git python3 make g++ \
      xvfb xauth dbus dbus-x11 gnome-keyring libsecret-1-0 libsecret-tools fonts-liberation \
      libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 libgtk-3-0t64 libgbm1 libasound2t64 \
      libxss1 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libxfixes3 libpango-1.0-0 libcairo2 \
    && rm -rf /var/lib/apt/lists/*

RUN test -n "$NODE_VERSION" \
    && cd /tmp \
    && curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" \
       | grep " node-v${NODE_VERSION}-linux-x64.tar.xz\$" | sha256sum -c - \
    && tar -xJf "node-v${NODE_VERSION}-linux-x64.tar.xz" -C /usr/local --strip-components=1 \
    && rm "node-v${NODE_VERSION}-linux-x64.tar.xz" \
    && node -v

COPY entrypoint.sh /usr/local/bin/restiprocity-test
RUN sed -i 's/\r$//' /usr/local/bin/restiprocity-test && chmod 755 /usr/local/bin/restiprocity-test \
    && mkdir -p /work && chown ubuntu:ubuntu /work

USER ubuntu
ENV HOME=/home/ubuntu \
    PLAYWRIGHT_BROWSERS_PATH=/work/ms-playwright \
    npm_config_cache=/work/npm-cache \
    npm_config_update_notifier=false
WORKDIR /work
ENTRYPOINT ["restiprocity-test"]
