// 跨端错误码：后端抛出带 code 的 AppError，服务端把它序列化成 "i18n:<code>|<k=v>|<k=v>"
// 前端解析后用本地字典渲染，未识别的 code 回退到后端附带的原文，保证永不为空。

/** 错误码 -> 参数名。新增错误只需在此登记，前后端的类型与校验自动跟着走。 */
export const ERROR_PARAMS = {
	// 通用
	generic: [],
	notFound: ["what"],

	// 会话 / 工作区
	sessionNotFound: ["id"],
	sessionNotOpen: [],
	workspaceNotFound: ["id"],
	workdirNotFound: ["dir"],
	dirNotFound: ["dir"],
	dirNotWorkspace: [],
	folderNameEmpty: [],
	folderNameInvalid: ["name"],
	folderExists: ["name"],
	messageEmpty: [],
	messageChanged: [],
	messageNotFound: [],
	messageAlreadySent: [],
	waitForReply: [],
	aborted: [],
	modelNotFound: ["provider", "id"],
	unknownPermissionMode: ["mode"],
	unknownRuntime: ["runtime"],
	reloadFailed: ["error"],
	extensionError: ["error"],
	extensionTerminalOnly: [],
	themeTerminalOnly: [],

	// 图片
	imagesInvalid: [],
	imagesTooMany: ["max"],
	imageType: [],
	imageTooLarge: [],
	imageBadBase64: [],
	imagesTotalTooLarge: [],
	filesTooMany: ["max"],
	fileTooLarge: ["name", "max"],
	filesTotalTooLarge: ["max"],
	fileBadBase64: ["name"],
	fileNotFound: ["path"],
	imageOnlyTitle: [],

	// 网关
	gatewayNotFound: ["id"],
	gatewayNotRegistered: [],
	gatewayInvalid: ["errors"],
	gatewayNotFoundWithId: ["id"],
	baseUrlInvalid: [],
	baseUrlScheme: [],
	fetchFailed: ["status"],
	catalogEmpty: [],
	catalogInvalid: [],
	gatewayExists: [],
	gatewayFieldId: [],
	gatewayFieldName: [],
	gatewayFieldFormat: ["format"],
	gatewayFieldBaseUrlScheme: [],
	gatewayFieldBaseUrl: [],
	gatewayFieldAuthHeader: [],
	gatewayFieldApiKey: [],
	gatewayFieldHeader: ["name"],
	gatewayFieldModels: [],
	gatewayFieldModelId: [],
	gatewayFieldModelDuplicate: ["id"],
	gatewayKeyUnreadable: [],
	testFailed: ["error"],
	emptyReply: [],
	embeddingUnsupported: [],
	embeddingFailed: ["status", "detail"],
	transcribeUnsupported: [],
	transcribeFailed: ["status", "detail"],

	// 知识库
	kbNameEmpty: [],
	kbNotFound: ["id"],
	kbEmbeddingLocked: [],
	kbModelEmpty: [],
	kbDocumentTooLarge: ["max"],
	kbDocumentEmpty: [],
	kbStoreMissing: ["store"],
	kbStoreUnknown: ["store"],
	embeddingGatewayMissing: ["id"],
	kbUntitled: [],

	// 插件
	pluginNameInvalid: ["name", "detail"],
	pluginNameEndsWithDot: [],
	pluginNameReserved: ["name"],
	pluginSetupShape: [],
	pluginNameDuplicate: ["name"],
	pluginNotFound: ["id"],
	pluginBuiltinLocked: [],
	pluginDirectoryOnly: [],
	pluginDirInvalid: [],
	pluginNameClash: ["kind", "name"],
	pluginNotLoaded: [],
	pluginNameMismatch: ["declared", "installed"],
	pluginLoadFailed: ["error"],
	pluginHotReloadTui: [],
	pluginMultiFileReload: [],
	pluginMethodNotFound: ["plugin", "method"],
	pluginFilesRequired: [],
	pluginTooManyFiles: ["max"],
	pluginFilePathInvalid: ["path"],
	pluginFilePackageJson: [],
	pluginFileDuplicate: ["path"],
	pluginFileTooLarge: ["path", "max"],
	pluginTotalTooLarge: [],
	pluginEntryMissing: [],
	pluginEntryOutside: [],
	pluginStoreDuplicate: ["id"],
	pluginRoutePath: [],
	pluginMethodInvalid: ["method"],
	pluginToolDuplicate: ["name", "owner"],
	pluginToolNameEmpty: [],
	pluginToolNameInvalid: ["name"],
	pluginToolNameReserved: ["name"],
	pluginToolShape: ["name"],
	pluginBackgroundUnsupported: [],
	pluginLoadError: ["error"],

	// 子代理
	subagentUnavailable: [],
	subagentExtensionNotInstalled: [],
	subagentNotFound: [],
	subagentCallFailed: [],
	subagentNotRun: [],
	subagentUnknownState: [],
	subagentTimeout: [],

	// SSH / 系统对话框
	sshServerNotFound: ["name"],
	pickStartMissing: [],
	pickFailed: ["error"],
	openAppUnsupported: [],
	openAppNotFound: ["label"],
	openPathMissing: [],

	// 服务端网络与登录
	loginTooMany: ["wait"],
	loginNoPassword: [],
	loginWrongPassword: [],
	loginTokenInsteadOfPassword: [],
	bodyTooLarge: [],
	portInUse: ["port"],
	portDenied: ["port"],
	portRange: [],
	portOccupiedBySelf: [],
	listenManaged: [],
	lanNeedsPassword: [],
	networkLocalOnly: [],
	tunnelNeedsPassword: [],
	passwordFormat: [],
	passwordTooShort: ["min"],
	passwordTooLong: ["max"],
	allowlistFormat: [],
	allowlistHostInvalid: ["host"],
	allowlistTooMany: ["max"],
	invalidJsonFrame: [],
	unknownFrameType: [],
	serverClosed: [],

	// 原生对话框 / 其他
	folderPickTitle: [],
	fileManagerName: ["name"],
} as const satisfies Record<string, readonly string[]>;

export type ErrorCode = keyof typeof ERROR_PARAMS;

/** 错误码的线上前缀。前端据此区分“可翻译的错误码”与普通文本。 */
export const ERROR_PREFIX = "i18n:";

/**
 * 携带错误码的错误。`params` 的值会原样回传给前端填进译文模板。
 * 不是 ErrorCode 的 code 不允许出现，避免前后端拼错字符串。
 */
export class AppError extends Error {
	readonly code: ErrorCode;
	readonly params: Record<string, string | number>;

	constructor(code: ErrorCode, params: Record<string, string | number> = {}) {
		// message 保留可读的参数信息，便于日志排查；跨进程传输一律走 encodeError。
		const detail = Object.entries(params)
			.map(([k, v]) => `${k}=${String(v)}`)
			.join(", ");
		super(detail ? `${code} (${detail})` : code);
		this.name = "AppError";
		this.code = code;
		this.params = params;
	}
}

/** 把任意抛出物编码成线上字符串；非 AppError 保持原有 message。 */
export function encodeError(err: unknown): string {
	if (err instanceof AppError) {
		const parts = Object.entries(err.params).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
		return [ERROR_PREFIX + err.code, ...parts].join("|");
	}
	return err instanceof Error ? err.message : String(err);
}

/** 解析线上字符串；不是错误码则返回 null。 */
export function decodeError(raw: string): { code: ErrorCode; params: Record<string, string> } | null {
	if (!raw.startsWith(ERROR_PREFIX)) return null;
	const [head, ...rest] = raw.slice(ERROR_PREFIX.length).split("|");
	if (!head || !(head in ERROR_PARAMS)) return null;
	const params: Record<string, string> = {};
	for (const part of rest) {
		const eq = part.indexOf("=");
		if (eq <= 0) continue;
		try {
			params[part.slice(0, eq)] = decodeURIComponent(part.slice(eq + 1));
		} catch {
			params[part.slice(0, eq)] = part.slice(eq + 1);
		}
	}
	return { code: head as ErrorCode, params };
}
