#!/bin/bash
# Runs Restiprocity's test suites on Linux inside the container.
#   /src   the host repository, mounted read-only
#   /work  a named volume that keeps the clone, node_modules and caches between runs
# usage: restiprocity-test [suite...]   suites: typecheck updater native native-keyring engine e2e
# Extra Playwright arguments for the native and e2e suites can be passed in PW_ARGS.
set -uo pipefail

all_default=(typecheck updater native native-keyring engine)
suites=("$@")
[ ${#suites[@]} -eq 0 ] && suites=("${all_default[@]}")
for suite in "${suites[@]}"; do
  case "$suite" in typecheck|updater|native|native-keyring|engine|e2e) ;; *)
    echo "Unknown suite '$suite'. Suites: typecheck updater native native-keyring engine e2e" >&2; exit 2 ;;
  esac
done

git config --global --add safe.directory '*'
git config --global advice.detachedHead false
commit="$(git -C /src rev-parse HEAD)" || { echo "/src is not a git repository" >&2; exit 2; }

if [ ! -d /work/repo/.git ]; then
  git clone --quiet --no-checkout /src /work/repo || exit 2
fi
cd /work/repo || exit 2
git fetch --quiet origin "$commit" || git fetch --quiet origin || exit 2
git checkout --quiet --force --detach "$commit" || exit 2
git clean --quiet -fd
echo "== commit $(git log --oneline -1)"
echo "== node $(node -v) on $(. /etc/os-release; echo "$PRETTY_NAME")"

# Reinstall only when the lockfile changed since the last run in this volume.
lock_hash="$(sha256sum package-lock.json | cut -d' ' -f1)-$(node -v)"
if [ ! -x node_modules/electron/dist/electron ] || [ "$(cat /work/.lock-hash 2>/dev/null)" != "$lock_hash" ]; then
  echo "== npm ci"
  rm -f /work/.lock-hash
  npm ci || exit 1
  echo "$lock_hash" > /work/.lock-hash
fi

needs_build=0
for suite in "${suites[@]}"; do case "$suite" in native|native-keyring|e2e) needs_build=1 ;; esac; done
if [ "$needs_build" = 1 ]; then
  echo "== build:renderer"
  npm run build:renderer > /tmp/build.log 2>&1 || { cat /tmp/build.log; exit 1; }
fi

# shellcheck disable=SC2086
run_suite() {
  case "$1" in
    typecheck) npm run typecheck ;;
    updater) npm run test:update ;;
    native)
      env -u XDG_CURRENT_DESKTOP -u DBUS_SESSION_BUS_ADDRESS -u RESTIPROCITY_TEST_PASSWORD_STORE \
        xvfb-run -a npm run test:electron -- ${PW_ARGS:-} ;;
    native-keyring)
      XDG_CURRENT_DESKTOP=GNOME RESTIPROCITY_TEST_PASSWORD_STORE=gnome-libsecret dbus-run-session -- bash -c '
        mkdir -p "$HOME/.cache" "$HOME/.local/share/keyrings"
        eval "$(printf "container-test-keyring" | gnome-keyring-daemon --daemonize --unlock --components=secrets)" || exit 1
        export GNOME_KEYRING_CONTROL
        # Wait until this daemon owns the secrets name; asking sooner makes D-Bus start a second, locked one.
        for _ in $(seq 50); do
          dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus \
            org.freedesktop.DBus.NameHasOwner string:org.freedesktop.secrets 2>/dev/null | grep -q "boolean true" && break
          sleep 0.1
        done
        printf "probe" | secret-tool store --label=probe restiprocity-test probe || { echo "The keyring did not accept a secret." >&2; exit 1; }
        xvfb-run -a npm run test:electron -- ${PW_ARGS:-}
      ' ;;
    engine)
      npm run test:engine:node-abi; status=$?
      # The strict suite leaves better-sqlite3 built for Node; put the Electron build back for later runs.
      npm run rebuild:electron > /tmp/rebuild.log 2>&1 || { cat /tmp/rebuild.log; return 1; }
      return $status ;;
    e2e)
      npx playwright install chromium || return 1
      CI=1 npm run test -- ${PW_ARGS:-} ;;
  esac
}

declare -A results
failed=0
for suite in "${suites[@]}"; do
  echo
  echo "================ $suite ================"
  run_suite "$suite" 2>&1 | tee "/tmp/$suite.log"
  if [ "${PIPESTATUS[0]}" -eq 0 ]; then results[$suite]=passed; else results[$suite]=FAILED; failed=1; fi
done

echo
echo "================ summary ================"
for suite in "${suites[@]}"; do printf '%-16s %s\n' "$suite" "${results[$suite]}"; done
# Repeat the end of each failed suite here, so the cause is still on screen after a long run.
for suite in "${suites[@]}"; do
  if [ "${results[$suite]}" = FAILED ]; then
    echo
    echo "---------------- $suite: last 40 lines ----------------"
    tail -n 40 "/tmp/$suite.log"
  fi
done
exit $failed
