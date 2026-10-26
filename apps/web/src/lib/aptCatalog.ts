/** Tools the app can install: apt inside PRoot on Android, winget on Windows, Homebrew on macOS, apt on Debian/Ubuntu desktops. */
export type AptCategory = "lang" | "build" | "dev" | "net" | "data" | "media" | "shell";

export interface AptEntry {
	/** Stable id; the progress job is `apt-<id>`. */
	id: string;
	name: string;
	/** Ubuntu packages installed together (Android, and apt-based Linux desktops). */
	packages: string[];
	/** winget package ids (Windows); the entry is hidden there when missing. */
	win?: string[];
	/** Homebrew formulae (macOS); the entry is hidden there when missing. */
	mac?: string[];
	category: AptCategory;
	/** Download size, MB (rough, with dependencies). */
	sizeMb: number;
	zh: string;
	en: string;
	/** Extra search words. */
	keywords?: string;
}

export const APT_CATEGORIES: { id: AptCategory; zh: string; en: string }[] = [
	{ id: "lang", zh: "编程语言", en: "Languages" },
	{ id: "build", zh: "编译构建", en: "Build" },
	{ id: "dev", zh: "开发工具", en: "Dev tools" },
	{ id: "net", zh: "网络", en: "Network" },
	{ id: "data", zh: "数据库", en: "Databases" },
	{ id: "media", zh: "多媒体与文档", en: "Media & docs" },
	{ id: "shell", zh: "命令行工具", en: "CLI tools" },
];

export const APT_CATALOG: AptEntry[] = [
	// Languages
	{ id: "java", win: ["Microsoft.OpenJDK.21"], mac: ["openjdk"], name: "Java (OpenJDK)", packages: ["default-jdk-headless"], category: "lang", sizeMb: 220, zh: "OpenJDK 开发包（javac、java）", en: "OpenJDK development kit (javac, java)", keywords: "jdk jre maven" },
	{ id: "maven", win: ["Apache.Maven"], mac: ["maven"], name: "Maven", packages: ["maven"], category: "lang", sizeMb: 260, zh: "Java 项目构建工具（含 OpenJDK）", en: "Java build tool (includes OpenJDK)" },
	{ id: "gradle", win: ["Gradle.Gradle"], mac: ["gradle"], name: "Gradle", packages: ["gradle"], category: "lang", sizeMb: 300, zh: "Java / Kotlin 构建工具（含 OpenJDK）", en: "Java / Kotlin build tool (includes OpenJDK)" },
	{ id: "nodejs", win: ["OpenJS.NodeJS.LTS"], mac: ["node"], name: "Node.js (Ubuntu)", packages: ["nodejs", "npm"], category: "lang", sizeMb: 60, zh: "Ubuntu 软件源里的 Node.js 与 npm（App 自带的 Node 不受影响）", en: "Node.js and npm from Ubuntu (the app's own Node is unaffected)", keywords: "javascript" },
	{ id: "ruby", win: ["RubyInstallerTeam.Ruby.3.3"], mac: ["ruby"], name: "Ruby", packages: ["ruby"], category: "lang", sizeMb: 20, zh: "Ruby 解释器与 gem", en: "Ruby interpreter and gem" },
	{ id: "php", win: ["PHP.PHP.8.3"], mac: ["php"], name: "PHP", packages: ["php-cli"], category: "lang", sizeMb: 25, zh: "PHP 命令行解释器", en: "PHP command-line interpreter" },
	{ id: "lua", win: ["DEVCOM.Lua"], mac: ["lua"], name: "Lua", packages: ["lua5.4"], category: "lang", sizeMb: 1, zh: "Lua 5.4 解释器", en: "Lua 5.4 interpreter" },
	{ id: "dotnet", win: ["Microsoft.DotNet.SDK.8"], mac: ["dotnet"], name: ".NET SDK 8", packages: ["dotnet-sdk-8.0"], category: "lang", sizeMb: 180, zh: "C# / F# 开发包", en: "C# / F# SDK", keywords: "csharp" },
	{ id: "r", win: ["RProject.R"], mac: ["r"], name: "R", packages: ["r-base-core"], category: "lang", sizeMb: 70, zh: "R 统计计算环境", en: "R statistical computing", keywords: "statistics" },
	{ id: "ghc", mac: ["ghc"], name: "Haskell (GHC)", packages: ["ghc"], category: "lang", sizeMb: 200, zh: "Haskell 编译器", en: "Haskell compiler" },
	{ id: "ocaml", name: "OCaml", packages: ["ocaml"], category: "lang", sizeMb: 60, zh: "OCaml 编译器", en: "OCaml compiler" },
	{ id: "erlang", win: ["Erlang.ErlangOTP"], mac: ["erlang"], name: "Erlang", packages: ["erlang-base"], category: "lang", sizeMb: 40, zh: "Erlang/OTP 运行时", en: "Erlang/OTP runtime" },
	{ id: "elixir", mac: ["elixir"], name: "Elixir", packages: ["elixir"], category: "lang", sizeMb: 60, zh: "Elixir 语言（含 Erlang）", en: "Elixir (includes Erlang)" },
	{ id: "swipl", name: "SWI-Prolog", packages: ["swi-prolog-nox"], category: "lang", sizeMb: 20, zh: "Prolog 解释器", en: "Prolog interpreter" },
	{ id: "pyvenv", name: "Python venv/dev", packages: ["python3-venv", "python3-dev"], category: "lang", sizeMb: 15, zh: "系统 Python 的 venv 与头文件（编译 pip 扩展常用）", en: "venv and headers for the system Python (needed to build pip extensions)" },
	// Build
	{ id: "build-essential", name: "build-essential", packages: ["build-essential"], category: "build", sizeMb: 70, zh: "gcc、g++、make 等 C/C++ 编译工具链", en: "gcc, g++, make: the C/C++ toolchain", keywords: "gcc g++ make c cpp" },
	{ id: "clang", win: ["LLVM.LLVM"], mac: ["llvm"], name: "Clang / LLVM", packages: ["clang", "lld"], category: "build", sizeMb: 150, zh: "Clang 编译器与 lld 链接器", en: "Clang compiler and lld linker" },
	{ id: "cmake", win: ["Kitware.CMake"], mac: ["cmake"], name: "CMake", packages: ["cmake"], category: "build", sizeMb: 30, zh: "跨平台构建系统", en: "Cross-platform build system" },
	{ id: "ninja", win: ["Ninja-build.Ninja"], mac: ["ninja"], name: "Ninja", packages: ["ninja-build"], category: "build", sizeMb: 1, zh: "快速构建工具", en: "Fast build tool" },
	{ id: "pkg-config", name: "pkg-config", packages: ["pkg-config"], category: "build", sizeMb: 1, zh: "库编译参数查询", en: "Library flag lookup" },
	{ id: "autotools", name: "Autotools", packages: ["autoconf", "automake", "libtool"], category: "build", sizeMb: 10, zh: "autoconf / automake / libtool", en: "autoconf / automake / libtool" },
	{ id: "gdb", name: "GDB", packages: ["gdb"], category: "build", sizeMb: 20, zh: "GNU 调试器", en: "GNU debugger" },
	{ id: "valgrind", name: "Valgrind", packages: ["valgrind"], category: "build", sizeMb: 30, zh: "内存检查与性能分析", en: "Memory checker and profiler" },
	// Dev tools
	{ id: "openssh", name: "OpenSSH client", packages: ["openssh-client"], category: "dev", sizeMb: 2, zh: "ssh、scp、sftp。连接 SSH 服务器时缺少会自动安装", en: "ssh, scp, sftp. Installed automatically when an SSH connection needs it", keywords: "ssh scp sftp" },
	{ id: "sshpass", name: "sshpass", packages: ["sshpass"], category: "dev", sizeMb: 1, zh: "用命令行参数提供 SSH 密码", en: "Non-interactive SSH password" },
	{ id: "vim", win: ["vim.vim"], mac: ["vim"], name: "Vim", packages: ["vim"], category: "dev", sizeMb: 20, zh: "经典文本编辑器", en: "Classic text editor" },
	{ id: "neovim", win: ["Neovim.Neovim"], mac: ["neovim"], name: "Neovim", packages: ["neovim"], category: "dev", sizeMb: 25, zh: "现代化的 Vim", en: "Modern Vim", keywords: "nvim" },
	{ id: "nano", mac: ["nano"], name: "nano", packages: ["nano"], category: "dev", sizeMb: 1, zh: "简单易用的终端编辑器", en: "Simple terminal editor" },
	{ id: "tmux", mac: ["tmux"], name: "tmux", packages: ["tmux"], category: "dev", sizeMb: 2, zh: "终端复用器", en: "Terminal multiplexer" },
	{ id: "git-lfs", win: ["GitHub.GitLFS"], mac: ["git-lfs"], name: "Git LFS", packages: ["git-lfs"], category: "dev", sizeMb: 5, zh: "Git 大文件支持（需在环境中另装 git）", en: "Git large file support" },
	{ id: "diff-tools", name: "Patch & diff tools", packages: ["patch", "diffutils", "colordiff"], category: "dev", sizeMb: 1, zh: "patch / diff 工具", en: "patch / diff tools" },
	// Network
	{ id: "curl", win: ["cURL.cURL"], mac: ["curl"], name: "curl", packages: ["curl"], category: "net", sizeMb: 2, zh: "HTTP 命令行客户端", en: "HTTP command-line client" },
	{ id: "wget", win: ["JernejSimoncic.Wget"], mac: ["wget"], name: "wget", packages: ["wget"], category: "net", sizeMb: 1, zh: "文件下载工具", en: "File downloader" },
	{ id: "rsync", mac: ["rsync"], name: "rsync", packages: ["rsync"], category: "net", sizeMb: 1, zh: "增量同步文件", en: "Incremental file sync" },
	{ id: "netcat", mac: ["netcat"], name: "netcat", packages: ["netcat-openbsd"], category: "net", sizeMb: 1, zh: "TCP/UDP 连接测试", en: "TCP/UDP connection tool", keywords: "nc" },
	{ id: "nmap", win: ["Insecure.Nmap"], mac: ["nmap"], name: "nmap", packages: ["nmap"], category: "net", sizeMb: 6, zh: "端口扫描，可用来查找局域网里的设备", en: "Port scanner, handy for finding LAN devices" },
	{ id: "dnsutils", name: "dig / nslookup", packages: ["dnsutils"], category: "net", sizeMb: 3, zh: "DNS 查询工具", en: "DNS lookup tools", keywords: "dig nslookup" },
	{ id: "ping", name: "ping", packages: ["iputils-ping"], category: "net", sizeMb: 1, zh: "ICMP 连通性测试", en: "ICMP reachability test" },
	{ id: "iproute", name: "iproute2 / net-tools", packages: ["iproute2", "net-tools"], category: "net", sizeMb: 2, zh: "ip、ifconfig、netstat", en: "ip, ifconfig, netstat" },
	{ id: "mtr", name: "traceroute / mtr", packages: ["traceroute", "mtr-tiny"], category: "net", sizeMb: 1, zh: "路由追踪", en: "Route tracing" },
	{ id: "nginx", mac: ["nginx"], name: "nginx", packages: ["nginx"], category: "net", sizeMb: 5, zh: "Web 服务器 / 反向代理", en: "Web server / reverse proxy" },
	{ id: "openssh-server", name: "OpenSSH server", packages: ["openssh-server"], category: "net", sizeMb: 2, zh: "SSH 服务端（手机上无法使用 22 端口，需自选端口运行）", en: "SSH server (needs a port above 1024 on a phone)" },
	{ id: "socat", mac: ["socat"], name: "socat", packages: ["socat"], category: "net", sizeMb: 1, zh: "多功能网络中继", en: "Multipurpose relay" },
	// Databases
	{ id: "sqlite", win: ["SQLite.SQLite"], mac: ["sqlite"], name: "SQLite", packages: ["sqlite3"], category: "data", sizeMb: 1, zh: "嵌入式数据库命令行", en: "Embedded database shell" },
	{ id: "postgres-client", name: "PostgreSQL client", packages: ["postgresql-client"], category: "data", sizeMb: 5, zh: "psql 客户端", en: "psql client" },
	{ id: "mysql-client", name: "MySQL client", packages: ["default-mysql-client"], category: "data", sizeMb: 10, zh: "mysql 客户端", en: "mysql client" },
	{ id: "redis-tools", mac: ["redis"], name: "Redis tools", packages: ["redis-tools"], category: "data", sizeMb: 2, zh: "redis-cli 客户端", en: "redis-cli client" },
	{ id: "redis-server", name: "Redis server", packages: ["redis-server"], category: "data", sizeMb: 3, zh: "Redis 服务端", en: "Redis server" },
	{ id: "postgres", win: ["PostgreSQL.PostgreSQL.16"], mac: ["postgresql@16"], name: "PostgreSQL server", packages: ["postgresql"], category: "data", sizeMb: 50, zh: "PostgreSQL 数据库服务端", en: "PostgreSQL database server" },
	{ id: "mariadb", win: ["MariaDB.Server"], mac: ["mariadb"], name: "MariaDB server", packages: ["mariadb-server"], category: "data", sizeMb: 60, zh: "MariaDB 数据库服务端", en: "MariaDB database server", keywords: "mysql" },
	// Media & docs
	{ id: "ffmpeg", win: ["Gyan.FFmpeg"], mac: ["ffmpeg"], name: "FFmpeg", packages: ["ffmpeg"], category: "media", sizeMb: 130, zh: "音视频转码与处理", en: "Audio / video conversion", keywords: "video audio" },
	{ id: "imagemagick", win: ["ImageMagick.ImageMagick"], mac: ["imagemagick"], name: "ImageMagick", packages: ["imagemagick"], category: "media", sizeMb: 20, zh: "图片处理（convert / magick）", en: "Image processing (convert / magick)", keywords: "image convert" },
	{ id: "pandoc", win: ["JohnMacFarlane.Pandoc"], mac: ["pandoc"], name: "Pandoc", packages: ["pandoc"], category: "media", sizeMb: 60, zh: "文档格式转换", en: "Document converter", keywords: "markdown" },
	{ id: "poppler", mac: ["poppler"], name: "poppler-utils", packages: ["poppler-utils"], category: "media", sizeMb: 5, zh: "PDF 工具（pdftotext 等）", en: "PDF tools (pdftotext etc.)", keywords: "pdf" },
	{ id: "tesseract", win: ["UB-Mannheim.TesseractOCR"], mac: ["tesseract"], name: "Tesseract OCR", packages: ["tesseract-ocr", "tesseract-ocr-chi-sim"], category: "media", sizeMb: 40, zh: "文字识别（含简体中文）", en: "OCR (with Simplified Chinese)", keywords: "ocr" },
	{ id: "graphviz", win: ["Graphviz.Graphviz"], mac: ["graphviz"], name: "Graphviz", packages: ["graphviz"], category: "media", sizeMb: 20, zh: "绘制关系图", en: "Graph drawing", keywords: "dot" },
	{ id: "sox", win: ["ChrisBagwell.SoX"], mac: ["sox"], name: "SoX", packages: ["sox"], category: "media", sizeMb: 5, zh: "音频处理", en: "Audio processing" },
	// CLI tools
	{ id: "jq", win: ["jqlang.jq"], mac: ["jq"], name: "jq", packages: ["jq"], category: "shell", sizeMb: 1, zh: "JSON 处理", en: "JSON processor" },
	{ id: "ripgrep", win: ["BurntSushi.ripgrep.MSVC"], mac: ["ripgrep"], name: "ripgrep", packages: ["ripgrep"], category: "shell", sizeMb: 2, zh: "快速文本搜索（App 已自带 rg）", en: "Fast text search (the app already ships rg)", keywords: "rg grep" },
	{ id: "fd", win: ["sharkdp.fd"], mac: ["fd"], name: "fd", packages: ["fd-find"], category: "shell", sizeMb: 1, zh: "更友好的 find（命令名 fdfind）", en: "Friendlier find (command: fdfind)" },
	{ id: "fzf", win: ["junegunn.fzf"], mac: ["fzf"], name: "fzf", packages: ["fzf"], category: "shell", sizeMb: 2, zh: "模糊搜索", en: "Fuzzy finder" },
	{ id: "bat", win: ["sharkdp.bat"], mac: ["bat"], name: "bat", packages: ["bat"], category: "shell", sizeMb: 3, zh: "带高亮的 cat（命令名 batcat）", en: "cat with highlighting (command: batcat)" },
	{ id: "htop", mac: ["htop"], name: "htop", packages: ["htop"], category: "shell", sizeMb: 1, zh: "进程监视", en: "Process viewer" },
	{ id: "tree", mac: ["tree"], name: "tree", packages: ["tree"], category: "shell", sizeMb: 1, zh: "目录树", en: "Directory tree" },
	{ id: "zip", name: "zip / unzip", packages: ["zip", "unzip"], category: "shell", sizeMb: 1, zh: "ZIP 压缩解压", en: "ZIP archives" },
	{ id: "p7zip", win: ["7zip.7zip"], mac: ["sevenzip"], name: "7-Zip", packages: ["p7zip-full"], category: "shell", sizeMb: 5, zh: "7z 压缩解压", en: "7z archives" },
	{ id: "zstd", win: ["Facebook.Zstandard"], mac: ["zstd"], name: "zstd / xz", packages: ["zstd", "xz-utils"], category: "shell", sizeMb: 1, zh: "zstd 与 xz 压缩", en: "zstd and xz compression" },
	{ id: "zsh", name: "zsh", packages: ["zsh"], category: "shell", sizeMb: 5, zh: "Zsh 终端", en: "Zsh shell" },
	{ id: "fish", mac: ["fish"], name: "fish", packages: ["fish"], category: "shell", sizeMb: 10, zh: "Fish 终端", en: "Fish shell" },
	{ id: "strace", name: "strace", packages: ["strace"], category: "shell", sizeMb: 1, zh: "系统调用跟踪（PRoot 内功能受限）", en: "Syscall tracer (limited under PRoot)" },
	{ id: "bc", mac: ["bc"], name: "bc / calc", packages: ["bc"], category: "shell", sizeMb: 1, zh: "命令行计算器", en: "Command-line calculator" },
	{ id: "less", name: "less / file / man", packages: ["less", "file", "man-db"], category: "shell", sizeMb: 5, zh: "分页查看、文件类型、手册", en: "Pager, file types, manuals" },
	{ id: "locales", name: "Locales", packages: ["locales"], category: "shell", sizeMb: 4, zh: "语言环境数据", en: "Locale data" },
];

export function matchesApt(entry: AptEntry, query: string): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return true;
	const hay = `${entry.id} ${entry.name} ${entry.packages.join(" ")} ${entry.zh} ${entry.en} ${entry.keywords ?? ""}`.toLowerCase();
	return q.split(/\s+/).every((w) => hay.includes(w));
}

export type StorePlatform = "android" | "windows" | "mac" | "linux";

export function storePlatform(): StorePlatform {
	const ua = navigator.userAgent;
	if (/Android/i.test(ua)) return "android";
	if (/Windows/i.test(ua)) return "windows";
	if (/Mac/i.test(ua)) return "mac";
	return "linux";
}

/** The package ids to hand to this platform's package manager, or undefined when the entry is not available here. */
export function idsFor(entry: AptEntry, platform = storePlatform()): string[] | undefined {
	return platform === "windows" ? entry.win : platform === "mac" ? entry.mac : entry.packages;
}
