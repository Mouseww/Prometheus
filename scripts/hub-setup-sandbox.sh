#!/usr/bin/env sh
# Checks that the Linux sandbox driver ("sandbox") of the Prometheus Hub can work on this machine.
# It changes nothing: it only reports what is missing.
#
#   sh scripts/hub-setup-sandbox.sh

status=0

if ! command -v bwrap >/dev/null 2>&1; then
	echo "未找到 bwrap (bubblewrap)。请先安装:"
	echo "  Debian/Ubuntu: sudo apt install bubblewrap"
	echo "  Fedora/RHEL:   sudo dnf install bubblewrap"
	echo "  Arch:          sudo pacman -S bubblewrap"
	exit 1
fi
echo "bwrap: $(bwrap --version)"

if bwrap --ro-bind / / --unshare-pid --unshare-ipc true 2>/dev/null; then
	echo "非特权用户命名空间: 可用"
else
	echo "bwrap 无法创建命名空间。常见原因:"
	echo "  - 内核禁用了非特权用户命名空间: sudo sysctl kernel.unprivileged_userns_clone=1"
	echo "  - Ubuntu 24.04 的 AppArmor 限制: sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0"
	status=1
fi

if command -v systemd-run >/dev/null 2>&1 && systemd-run --user --scope --quiet true 2>/dev/null; then
	echo "systemd-run --user --scope: 可用（强制 CPU/内存限制）"
else
	echo "systemd-run --user --scope 不可用: 租户资源限制只记录，不强制。"
fi

exit "$status"
