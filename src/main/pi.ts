export type PiCodingAgentModule = typeof import("@earendil-works/pi-coding-agent");

let piModulePromise: Promise<PiCodingAgentModule> | null = null;

/**
 * Load the PI SDK on first use.
 *
 * `@earendil-works/pi-coding-agent` is ESM-only while the Electron main bundle is
 * CJS, so a static import compiles to `require()` and fails with
 * ERR_PACKAGE_PATH_NOT_EXPORTED. The dynamic `import()` is also why the SDK is not
 * pulled in during startup: it brings a native clipboard module that would bloat
 * the main process before any session exists.
 */
export function pi(): Promise<PiCodingAgentModule> {
	piModulePromise ??= import("@earendil-works/pi-coding-agent");
	return piModulePromise;
}

export type PiAiModule = typeof import("@earendil-works/pi-ai");

let piAiModulePromise: Promise<PiAiModule> | null = null;

/**
 * Load pi-ai on first use. ESM-only like pi-coding-agent — a static import would
 * compile to `require()` in the CJS main bundle and fail.
 */
export function piAi(): Promise<PiAiModule> {
	piAiModulePromise ??= import("@earendil-works/pi-ai");
	return piAiModulePromise;
}

export type PiMcpModule = typeof import("@earendil-works/pi-mcp");
export type PiMcpOAuthModule = typeof import("@earendil-works/pi-mcp/oauth");

let piMcpModulePromise: Promise<PiMcpModule> | null = null;
let piMcpOAuthModulePromise: Promise<PiMcpOAuthModule> | null = null;

/** Load the MCP client on first use; ESM-only like the rest of pi. */
export function piMcp(): Promise<PiMcpModule> {
	piMcpModulePromise ??= import("@earendil-works/pi-mcp");
	return piMcpModulePromise;
}

/** MCP's OAuth half, a separate entry point: only servers that sign in need it. */
export function piMcpOAuth(): Promise<PiMcpOAuthModule> {
	piMcpOAuthModulePromise ??= import("@earendil-works/pi-mcp/oauth");
	return piMcpOAuthModulePromise;
}
