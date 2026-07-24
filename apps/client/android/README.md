# Android packaging

This folder holds the **sideload debug signing key** used by GitHub Actions.

- `prometheus-debug.p12`: PKCS12 keystore
- password / alias: see `debug-signing.properties`

The CI Android job signs the Tauri-built `*-unsigned.apk` with this key so phones can install it.

This is **not** a Play Store signing key. Replace with a private upload key before store release.

## Why `PackageInfo is null` happens

Unsigned APKs (`app-*-release-unsigned.apk`) have no APK Signature Block.
Many Android package installers then fail package parsing and surface errors like `PackageInfo is null`.
