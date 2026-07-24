#!/usr/bin/env bash
set -u
set +e
if [ -n "${IOS_DEVELOPMENT_TEAM:-}" ]; then
  pnpm exec tauri ios build --ci --config src-tauri/tauri.mobile.conf.json --export-method debugging
  status=$?
else
  pnpm exec tauri ios build --ci --config src-tauri/tauri.mobile.conf.json -- --target aarch64-apple-ios-sim
  status=$?
fi
if [ $status -eq 0 ]; then
  exit 0
fi
echo "tauri ios build failed ($status); falling back to unsigned simulator xcodebuild"
if [ -d src-tauri/gen/apple ]; then
  APP_DIR="src-tauri/gen/apple"
elif [ -d src-tauri/gen/ios ]; then
  APP_DIR="src-tauri/gen/ios"
else
  echo "No generated Apple project found"
  exit $status
fi
shopt -s nullglob
projects=("$APP_DIR"/*.xcodeproj)
workspaces=("$APP_DIR"/*.xcworkspace)
SCHEME="prometheus_iOS"
if [ ${#workspaces[@]} -gt 0 ]; then
  xcodebuild -list -workspace "${workspaces[0]}" || true
  xcodebuild -workspace "${workspaces[0]}" -scheme "$SCHEME" -configuration Release -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath ios-derived CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" build
elif [ ${#projects[@]} -gt 0 ]; then
  xcodebuild -list -project "${projects[0]}" || true
  xcodebuild -project "${projects[0]}" -scheme "$SCHEME" -configuration Release -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' -derivedDataPath ios-derived CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" build
else
  echo "No xcodeproj/xcworkspace under $APP_DIR"
  exit $status
fi
