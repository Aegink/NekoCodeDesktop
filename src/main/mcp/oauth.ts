import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { safeStorage } from "electron";
import type { AuthProvider, McpFetch } from "@earendil-works/pi-mcp";
import type { McpOAuthState, McpOAuthStateStore, OAuthChallenge, OAuthClientInformationMixed } from "@earendil-works/pi-mcp/oauth";
import { piMcpOAuth } from "../pi";

/**
 * Sign-in for hosted MCP servers that use OAuth.
 *
 * A connection never opens a browser by itself: it sends the stored access
 * token, refreshes it when it is about to expire or is rejected, and otherwise
 * fails as needing sign-in. Signing in is the settings page's button, which
 * runs the authorization code flow (PKCE, dynamic client registration) against
 * a loopback callback. The flow itself is pi-mcp's; this file is the storage
 * and the wiring.
 */

const FILE = "mcp-auth.json";
const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/callback";
/** Redirect URI for refreshes when none is stored; a refresh never redirects anyone. */
const FALLBACK_REDIRECT_URL = `http://${CALLBACK_HOST}${CALLBACK_PATH}`;
/** Access tokens this close to expiry are refreshed before they are sent. */
const REFRESH_SKEW_MS = 30_000;
const REFRESH_REQUEST_TIMEOUT_MS = 15_000;
const CLIENT_NAME = "NekoCode";

type Encryption = Pick<
	typeof safeStorage,
	"isEncryptionAvailable" | "encryptString" | "decryptString" | "getSelectedStorageBackend"
>;

interface AuthFile {
	version: 1;
	/** Keyed by server URL; each value is a safeStorage-encrypted `McpOAuthState`, base64. */
	servers: Record<string, string>;
}

/** A sign-in the server needs before it will answer. */
export class McpSignInRequiredError extends Error {
	constructor() {
		super("需要登录");
		this.name = "McpSignInRequiredError";
	}
}

/**
 * OAuth state per server URL — client registration, tokens, the pending PKCE
 * verifier — encrypted, because a refresh token is standing access.
 */
export class McpAuthStore {
	private readonly path: string;

	constructor(
		private readonly userDataDir: string,
		private readonly encryption: Encryption,
	) {
		this.path = join(userDataDir, FILE);
	}

	private read(): AuthFile {
		if (!existsSync(this.path)) return { version: 1, servers: {} };
		try {
			const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<AuthFile> | null;
			return { version: 1, servers: typeof parsed?.servers === "object" && parsed.servers ? parsed.servers : {} };
		} catch {
			// A damaged file costs a sign-in, which is recoverable.
			return { version: 1, servers: {} };
		}
	}

	private write(file: AuthFile): void {
		mkdirSync(this.userDataDir, { recursive: true });
		const temporary = `${this.path}.tmp-${process.pid}`;
		try {
			writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
			renameSync(temporary, this.path);
		} catch (error) {
			rmSync(temporary, { force: true });
			throw error;
		}
	}

	load(serverUrl: string): McpOAuthState | undefined {
		const secret = this.read().servers[key(serverUrl)];
		if (!secret) return undefined;
		try {
			return JSON.parse(this.encryption.decryptString(Buffer.from(secret, "base64"))) as McpOAuthState;
		} catch {
			// Encrypted under another keyring or user: sign in again.
			return undefined;
		}
	}

	save(serverUrl: string, state: McpOAuthState): void {
		if (
			!this.encryption.isEncryptionAvailable() ||
			(process.platform === "linux" && this.encryption.getSelectedStorageBackend() === "basic_text")
		) {
			throw new Error("系统密钥环不可用，无法安全保存 MCP 登录凭据");
		}
		const file = this.read();
		file.servers[key(serverUrl)] = this.encryption.encryptString(JSON.stringify(state)).toString("base64");
		this.write(file);
	}

	remove(serverUrl: string): void {
		const file = this.read();
		if (!(key(serverUrl) in file.servers)) return;
		delete file.servers[key(serverUrl)];
		this.write(file);
	}

	/** Whether there is an access token to send — the settings row's "signed in". */
	signedIn(serverUrl: string): boolean {
		return !!this.load(serverUrl)?.tokens?.access_token;
	}

	forServer(serverUrl: string): McpOAuthStateStore {
		return { load: () => this.load(serverUrl), save: (state) => this.save(serverUrl, state) };
	}
}

function key(serverUrl: string): string {
	return String(new URL(serverUrl));
}

function registeredRedirectUrls(client: OAuthClientInformationMixed | undefined): string[] {
	return client && "redirect_uris" in client ? client.redirect_uris : [];
}

/**
 * Bearer tokens for one server's connection.
 *
 * Refreshes are shared: many servers rotate refresh tokens, and two refreshes
 * with the same one would burn the grant. `onChallenge` hears the server's
 * `WWW-Authenticate` so a later sign-in can ask for the scope it wants.
 */
export function createMcpAuthProvider(options: {
	serverUrl: string;
	store: McpAuthStore;
	onChallenge: (challenge: OAuthChallenge) => void;
}): AuthProvider {
	const { serverUrl, store } = options;
	let refreshing: Promise<void> | undefined;

	const refresh = (stale: string | undefined, fetch: McpFetch = globalThis.fetch, challenge?: OAuthChallenge) => {
		refreshing ??= (async () => {
			const oauth = await piMcpOAuth();
			const state = store.load(serverUrl);
			// Someone else — a sign-in, another request — already replaced it.
			if (state?.tokens?.access_token !== stale) return;
			if (!state?.tokens?.refresh_token) throw new oauth.McpOAuthAuthorizationRequiredError();
			const provider = new oauth.McpOAuthProvider({
				serverUrl,
				redirectUrl: registeredRedirectUrls(state.clientInformation)[0] ?? FALLBACK_REDIRECT_URL,
				clientMetadata: { client_name: CLIENT_NAME },
				store: store.forServer(serverUrl),
				onRedirect: () => undefined,
			});
			const result = await oauth.authorizeMcp(provider, {
				serverUrl,
				resourceMetadataUrl: challenge?.resourceMetadataUrl,
				scope: challenge?.scope,
				fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(REFRESH_REQUEST_TIMEOUT_MS) }),
			});
			if (result === "REDIRECT") throw new oauth.McpOAuthAuthorizationRequiredError();
		})().finally(() => {
			refreshing = undefined;
		});
		return refreshing;
	};

	return {
		token: async () => {
			await refreshing?.catch(() => undefined);
			const state = store.load(serverUrl);
			const token = state?.tokens?.access_token;
			const expired = state?.tokensExpireAt !== undefined && state.tokensExpireAt - REFRESH_SKEW_MS <= Date.now();
			if (!expired || !state?.tokens?.refresh_token) return token;
			// A failed refresh sends the old token; the server's 401 decides what follows.
			await refresh(token).catch(() => undefined);
			return store.load(serverUrl)?.tokens?.access_token;
		},
		onUnauthorized: async (context) => {
			const oauth = await piMcpOAuth();
			const challenge = oauth.parseWwwAuthenticate(context.response.headers.get("www-authenticate"));
			options.onChallenge(challenge);
			// A refresh keeps the granted scope; asking for more takes a new sign-in.
			if (challenge.error === "insufficient_scope") throw new oauth.McpOAuthAuthorizationRequiredError();
			await refresh(context.token, context.fetch, challenge);
		},
	};
}

/**
 * Sign in to a server: the stored refresh token when that is enough, else the
 * browser. Resolves once tokens are stored; rejects when the user gives up,
 * which the callback server reports after its timeout.
 */
export async function signInMcpServer(options: {
	serverUrl: string;
	store: McpAuthStore;
	challenge?: OAuthChallenge;
	openUrl: (url: string) => void | Promise<void>;
}): Promise<void> {
	const { serverUrl, store } = options;
	const oauth = await piMcpOAuth();
	const stored = store.load(serverUrl);
	// The registered client's redirect URI only works on the port it was registered with.
	const registered = registeredRedirectUrls(stored?.clientInformation)[0];
	const preferredPort = registered ? Number(new URL(registered).port) || undefined : undefined;
	const listen = (port: number | undefined) =>
		oauth.OAuthCallbackServer.listen({
			host: CALLBACK_HOST,
			path: CALLBACK_PATH,
			port: port ?? 0,
			renderPage: (page) => callbackPage(page.ok, page.ok ? undefined : page.message),
		});
	const callback = await listen(preferredPort).catch(() => listen(undefined));
	try {
		if (stored) {
			const next: McpOAuthState = { ...stored };
			delete next.oauthState;
			// A client registered for another redirect URI cannot use this one, and its tokens are its own.
			if (!registeredRedirectUrls(stored.clientInformation).includes(callback.redirectUrl)) {
				delete next.clientInformation;
				delete next.tokens;
				delete next.tokensExpireAt;
			}
			store.save(serverUrl, next);
		}

		let authorizationUrl: URL | undefined;
		const provider = new oauth.McpOAuthProvider({
			serverUrl,
			redirectUrl: callback.redirectUrl,
			clientMetadata: { client_name: CLIENT_NAME },
			store: store.forServer(serverUrl),
			onRedirect: (url) => {
				authorizationUrl = url;
			},
		});
		const flow = {
			serverUrl,
			resourceMetadataUrl: options.challenge?.resourceMetadataUrl,
			scope: options.challenge?.scope,
		};
		const skipRefresh = options.challenge?.error === "insufficient_scope";
		if ((await oauth.authorizeMcp(provider, { ...flow, skipRefresh })) === "AUTHORIZED") return;
		if (!authorizationUrl) throw new Error("OAuth 流程没有给出授权地址");

		const state = await provider.state();
		// Listening before the browser opens: a redirect that beats the waiter
		// would be turned away as belonging to no sign-in.
		const arrival = callback.waitForCallback(state);
		arrival.catch(() => undefined);
		await options.openUrl(authorizationUrl.href);
		const { code } = await arrival;
		await oauth.authorizeMcp(provider, { ...flow, authorizationCode: code });
	} finally {
		await callback.close();
	}
}

function callbackPage(ok: boolean, message?: string): string {
	const title = ok ? "已登录 MCP 服务器" : "登录失败";
	const body = ok ? "可以关闭此页面，回到 NekoCode。" : escapeHtml(message ?? "");
	return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;display:flex;min-height:90vh;align-items:center;justify-content:center"><div style="text-align:center"><h2>${title}</h2><p>${body}</p></div></body></html>`;
}

function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}
