#!/bin/sh
# Starts the macOS Computer Use driver. Uses a prebuilt binary when PROMETHEUS_CU_DRIVER points at
# one (release builds), otherwise compiles driver.swift once with the Command Line Tools and caches
# the result by source hash. Only the driver's JSON-RPC may be written to stdout.
# usage: cu-driver.sh <driver.swift> <cache-dir>
set -e
SRC="$1"
CACHE="$2"

if [ -n "$PROMETHEUS_CU_DRIVER" ] && [ -x "$PROMETHEUS_CU_DRIVER" ]; then
	exec "$PROMETHEUS_CU_DRIVER"
fi

HASH=$(shasum -a 256 "$SRC" | cut -c1-16)
BIN="$CACHE/cu-driver-$HASH"
if [ ! -x "$BIN" ]; then
	if ! command -v swiftc >/dev/null 2>&1; then
		echo "需要 Xcode 命令行工具来编译 macOS 驱动：在终端运行 xcode-select --install，装好后重试。" >&2
		exit 70
	fi
	mkdir -p "$CACHE"
	TMP="$BIN.$$"
	swiftc -O -o "$TMP" "$SRC" 1>&2
	# A stable ad-hoc signature keeps the Accessibility grant from being re-asked on every rebuild of the same source.
	codesign --force --sign - --identifier dev.prometheus.cu-driver "$TMP" 1>&2 || true
	mv "$TMP" "$BIN"
fi
exec "$BIN"
