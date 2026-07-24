#!/usr/bin/env bash
set -euo pipefail
mkdir -p ios-dist
find apps/client -type f -name '*.ipa' -print -exec cp {} ios-dist/ \; || true
find apps/client apps/client/ios-derived -type d -name '*.app' 2>/dev/null | while read -r app; do
  name=$(basename "$app" .app)
  ditto -c -k --sequesterRsrc --keepParent "$app" "ios-dist/${name}-ios-app.zip" || true
done
if [ -d apps/client/src-tauri/gen/apple ]; then
  ditto -c -k --sequesterRsrc --keepParent apps/client/src-tauri/gen/apple ios-dist/prometheus-ios-xcodeproj.zip || true
fi
if [ -d apps/client/src-tauri/gen/ios ]; then
  ditto -c -k --sequesterRsrc --keepParent apps/client/src-tauri/gen/ios ios-dist/prometheus-ios-gen-ios.zip || true
fi
ls -laR ios-dist || true
test -n "$(ls -A ios-dist 2>/dev/null)"
