import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpTransport } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair, type InMemoryTransport } from "@earendil-works/pi-mcp/testing";
import { parseKeyValueLines, qualifyToolName, splitCommand, type McpServerConfig } from "../../shared/mcp";
import { McpAuthStore } from "./oauth";
import { McpService, toParameterSchema, usesOAuth } from "./service";

/** An encryption stand-in: reversible, and visibly not plaintext. */
const encryption = {
	isEncryptionAvailable: () => true,
	getSelectedStorageBackend: () => "gnome_libsecret" as const,
	encryptString: (text: string) => Buffer.from(`enc:${text}`, "utf8"),
	decryptString: (buffer: Buffer) => buffer.toString("utf8").replace(/^enc:/, ""),
};

const directories: string[] = [];
const services: McpService[] = [];
const servers: Server[] = [];

afterEach(() => {
	for (const service of services.splice(0)) service.close();
	for (const server of servers.splice(0)) server.close();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function userData(): string {
	const directory = mkdtempSync(join(tmpdir(), "neko-mcp-"));
	directories.push(directory);
	return directory;
}

/**
 * A minimal MCP server on the far side of an in-memory transport: the
 * handshake, one tool that echoes, one that fails, one that returns an image.
 */
function fakeServer(server: InMemoryTransport, tools = ["echo", "fail", "picture"]): void {
	const reply = (id: unknown, result: unknown) => void server.send({ jsonrpc: "2.0", id, result } as never);
	server.onMessage((message) => {
		const request = message as { id?: unknown; method: string; params?: Record<string, unknown> };
		if (request.id === undefined) return;
		if (request.method === "initialize") {
			reply(request.id, {
				protocolVersion: String(request.params?.protocolVersion),
				capabilities: { tools: {} },
				serverInfo: { name: "fake", version: "1.0.0" },
			});
		} else if (request.method === "tools/list") {
			reply(request.id, {
				tools: tools.map((name) => ({ name, description: `${name} tool`, inputSchema: { type: "object", properties: {} } })),
			});
		} else if (request.method === "tools/call") {
			const name = request.params?.name;
			const args = request.params?.arguments as Record<string, unknown> | undefined;
			if (name === "fail") reply(request.id, { isError: true, content: [{ type: "text", text: "boom" }] });
			else if (name === "picture") reply(request.id, { content: [{ type: "image", data: "aGk=", mimeType: "image/png" }] });
			else reply(request.id, { content: [{ type: "text", text: `echo ${JSON.stringify(args ?? {})}` }] });
		}
	});
	void server.start();
}

function serviceWith(createTransport: (config: McpServerConfig) => Promise<McpTransport>, auth?: McpAuthStore) {
	const service = new McpService(userData(), () => process.cwd(), () => undefined, {
		auth,
		openUrl: () => undefined,
		createTransport: (config) => createTransport(config),
	});
	services.push(service);
	return service;
}

describe("MCP service", () => {
	test("a connected server's tools reach the agent, namespaced, and run through pi-mcp", async () => {
		const service = serviceWith(async () => {
			const { client, server } = createInMemoryTransportPair();
			fakeServer(server);
			return client;
		});
		const snapshot = await service.save({ name: "fake", transport: "stdio", enabled: true, command: "unused" });

		expect(snapshot.servers[0].state).toBe("ready");
		expect(service.toolNames()).toEqual(["mcp__fake__echo", "mcp__fake__fail", "mcp__fake__picture"]);

		const echo = service.tools().find((tool) => tool.name === "mcp__fake__echo")!;
		const result = await echo.execute("call-1", { query: "hi" } as never, undefined, undefined, undefined as never);
		expect(result.content).toEqual([{ type: "text", text: 'echo {"query":"hi"}' }]);
	});

	test("a server reporting failure fails the call instead of passing its error off as a result", async () => {
		const service = serviceWith(async () => {
			const { client, server } = createInMemoryTransportPair();
			fakeServer(server);
			return client;
		});
		await service.save({ name: "fake", transport: "stdio", enabled: true, command: "unused" });
		const fail = service.tools().find((tool) => tool.name === "mcp__fake__fail")!;
		expect(fail.execute("call-1", {} as never, undefined, undefined, undefined as never)).rejects.toThrow("boom");
	});

	test("images come back as images, not as a placeholder", async () => {
		const service = serviceWith(async () => {
			const { client, server } = createInMemoryTransportPair();
			fakeServer(server);
			return client;
		});
		await service.save({ name: "fake", transport: "stdio", enabled: true, command: "unused" });
		const picture = service.tools().find((tool) => tool.name === "mcp__fake__picture")!;
		const result = await picture.execute("call-1", {} as never, undefined, undefined, undefined as never);
		expect(result.content).toEqual([{ type: "image", data: "aGk=", mimeType: "image/png" }]);
	});

	test("a server that drops is dialled again by the next call", async () => {
		let dials = 0;
		let live: InMemoryTransport | null = null;
		const service = serviceWith(async () => {
			dials++;
			const { client, server } = createInMemoryTransportPair();
			fakeServer(server);
			live = server;
			return client;
		});
		await service.save({ name: "fake", transport: "stdio", enabled: true, command: "unused" });
		const echo = service.tools().find((tool) => tool.name === "mcp__fake__echo")!;

		await live!.close();
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(service.snapshot().servers[0].state).toBe("error");

		const result = await echo.execute("call-2", {} as never, undefined, undefined, undefined as never);
		expect(result.content[0]).toEqual({ type: "text", text: "echo {}" });
		expect(dials).toBe(2);
	});

	test("one broken server leaves the others connected", async () => {
		const service = serviceWith(async (config) => {
			if (config.name === "broken") throw new Error("缺少启动命令");
			const { client, server } = createInMemoryTransportPair();
			fakeServer(server, ["only"]);
			return client;
		});
		await service.save({ name: "broken", transport: "stdio", enabled: true, command: "x" });
		const snapshot = await service.save({ name: "good", transport: "stdio", enabled: true, command: "x" });

		expect(snapshot.servers.map((server) => [server.config.name, server.state])).toEqual([
			["broken", "error"],
			["good", "ready"],
		]);
		expect(service.toolNames()).toEqual(["mcp__good__only"]);
	});

	test("a real stdio server is spawned, spoken to, and closed", async () => {
		const script = join(userData(), "server.mjs");
		writeFileSync(
			script,
			`import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
	const request = JSON.parse(line);
	if (request.id === undefined) return;
	if (request.method === "initialize") send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "stdio", version: "1" } } });
	else if (request.method === "tools/list") send({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "cwd", inputSchema: { type: "object" } }] } });
	else if (request.method === "tools/call") send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: process.env.GREETING }] } });
});
`,
		);
		const service = new McpService(userData(), () => process.cwd(), () => undefined);
		services.push(service);
		const snapshot = await service.save({
			name: "local",
			transport: "stdio",
			enabled: true,
			command: process.execPath,
			args: [script],
			env: { GREETING: "hello from stdio" },
		});

		expect(snapshot.servers[0].state).toBe("ready");
		const tool = service.tools()[0];
		const result = await tool.execute("call-1", {} as never, undefined, undefined, undefined as never);
		expect(result.content).toEqual([{ type: "text", text: "hello from stdio" }]);
	});

	test("a hosted server answering 401 asks for sign-in rather than failing", async () => {
		const http = createServer((_request, response) => {
			response.writeHead(401, { "www-authenticate": 'Bearer resource_metadata="http://127.0.0.1:1/.well-known/oauth-protected-resource"' });
			response.end();
		});
		servers.push(http);
		await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
		const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;

		const service = new McpService(userData(), () => process.cwd(), () => undefined, {
			auth: new McpAuthStore(userData(), encryption),
			openUrl: () => undefined,
		});
		services.push(service);
		const snapshot = await service.save({ name: "hosted", transport: "http", enabled: true, url });

		expect(snapshot.servers[0].state).toBe("needs-auth");
		expect(snapshot.servers[0].signedIn).toBe(false);
	});

	test("a server with its own Authorization header is not an OAuth server", () => {
		const base = { id: "1", name: "x", enabled: true, url: "https://x.test/mcp" };
		expect(usesOAuth({ ...base, transport: "http" })).toBe(true);
		expect(usesOAuth({ ...base, transport: "http", headers: { authorization: "Bearer t" } })).toBe(false);
		expect(usesOAuth({ ...base, transport: "stdio" })).toBe(false);
	});
});

describe("MCP OAuth credentials", () => {
	test("tokens are stored encrypted, per server URL, and can be forgotten", () => {
		const directory = userData();
		const store = new McpAuthStore(directory, encryption);
		const url = "https://mcp.example.com/mcp";
		store.save(url, { serverUrl: url, tokens: { access_token: "secret-token", token_type: "Bearer" } });

		expect(store.signedIn(url)).toBe(true);
		expect(store.signedIn("https://other.example.com/mcp")).toBe(false);
		expect(new McpAuthStore(directory, encryption).load(url)?.tokens?.access_token).toBe("secret-token");

		store.remove(url);
		expect(store.signedIn(url)).toBe(false);
	});

	test("nothing is written without a keyring to encrypt it with", () => {
		const store = new McpAuthStore(userData(), { ...encryption, isEncryptionAvailable: () => false });
		expect(() => store.save("https://x.test/mcp", { serverUrl: "https://x.test/mcp" })).toThrow("密钥环");
	});
});

describe("MCP helpers", () => {
	test("a usable input schema passes through unchanged", () => {
		const schema = { type: "object", properties: { query: { type: "string" } }, required: ["query"] };
		expect(toParameterSchema(schema)).toEqual(schema);
	});

	test("a missing or non-object schema becomes a callable no-argument tool", () => {
		const empty = { type: "object", properties: {} };
		expect(toParameterSchema(undefined)).toEqual(empty);
		expect(toParameterSchema({ type: "string" })).toEqual(empty);
		expect(toParameterSchema([1, 2])).toEqual(empty);
		expect(toParameterSchema({ type: "object" })).toEqual(empty);
	});

	test("a pasted command line splits the way a shell would", () => {
		expect(splitCommand('npx -y @scope/server --root "/my files"')).toEqual({
			command: "npx",
			args: ["-y", "@scope/server", "--root", "/my files"],
		});
		expect(splitCommand("   ")).toEqual({ command: "", args: [] });
	});

	test("key=value lines keep everything after the first separator", () => {
		expect(parseKeyValueLines("# comment\nTOKEN=abc=def==\n\n  API_URL = https://x.test  \nbroken")).toEqual({
			TOKEN: "abc=def==",
			API_URL: "https://x.test",
		});
	});

	test("tool names are namespaced so two servers can both offer a search", () => {
		expect(qualifyToolName("linear", "search")).toBe("mcp__linear__search");
		expect(qualifyToolName("my server!", "search")).toBe("mcp__my_server___search");
	});
});

describe("MCP OAuth sign-in", () => {
	/**
	 * A hosted MCP server that is also its own authorization server: discovery,
	 * dynamic registration, an authorize endpoint that approves at once, and a
	 * token endpoint. `/mcp` answers only with the token it issued.
	 */
	async function oauthServer() {
		const issued = "issued-access-token";
		let base = "";
		let registered: { redirect_uris: string[] } | null = null;
		const http = createServer((request, response) => {
			const url = new URL(request.url ?? "/", base);
			const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
				response.writeHead(status, { "content-type": "application/json", ...headers });
				response.end(JSON.stringify(body));
			};
			let raw = "";
			request.on("data", (chunk) => (raw += chunk));
			request.on("end", () => {
				if (url.pathname === "/.well-known/oauth-protected-resource/mcp" || url.pathname === "/.well-known/oauth-protected-resource") {
					return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
				}
				if (url.pathname === "/.well-known/oauth-authorization-server") {
					return json(200, {
						issuer: base,
						authorization_endpoint: `${base}/authorize`,
						token_endpoint: `${base}/token`,
						registration_endpoint: `${base}/register`,
						response_types_supported: ["code"],
						code_challenge_methods_supported: ["S256"],
						grant_types_supported: ["authorization_code", "refresh_token"],
						token_endpoint_auth_methods_supported: ["none"],
					});
				}
				if (url.pathname === "/register") {
					registered = JSON.parse(raw) as { redirect_uris: string[] };
					return json(201, { ...registered, client_id: "client-1" });
				}
				if (url.pathname === "/authorize") {
					// The user approves: back to the app's loopback callback with a code.
					const redirect = new URL(url.searchParams.get("redirect_uri")!);
					redirect.searchParams.set("code", "the-code");
					redirect.searchParams.set("state", url.searchParams.get("state")!);
					response.writeHead(302, { location: redirect.href });
					return response.end();
				}
				if (url.pathname === "/token") {
					const form = new URLSearchParams(raw);
					if (form.get("code") !== "the-code" || !form.get("code_verifier")) return json(400, { error: "invalid_grant" });
					return json(200, { access_token: issued, token_type: "Bearer", expires_in: 3600, refresh_token: "refresh-1" });
				}
				if (url.pathname === "/mcp") {
					if (request.headers.authorization !== `Bearer ${issued}`) {
						response.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
						return response.end();
					}
					if (request.method !== "POST") {
						response.writeHead(405);
						return response.end();
					}
					const message = JSON.parse(raw) as { id?: unknown; method: string; params?: Record<string, unknown> };
					if (message.id === undefined) {
						response.writeHead(202);
						return response.end();
					}
					if (message.method === "initialize") {
						return json(200, { jsonrpc: "2.0", id: message.id, result: {
							protocolVersion: message.params?.protocolVersion,
							capabilities: { tools: {} },
							serverInfo: { name: "hosted", version: "1" },
						} });
					}
					if (message.method === "tools/list") {
						return json(200, { jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "whoami", inputSchema: { type: "object" } }] } });
					}
					return json(200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "no" } });
				}
				response.writeHead(404);
				response.end();
			});
		});
		servers.push(http);
		await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
		base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
		return { url: `${base}/mcp`, registered: () => registered };
	}

	test("signing in runs the browser flow, stores the token, and connects with it", async () => {
		const server = await oauthServer();
		const opened: string[] = [];
		const auth = new McpAuthStore(userData(), encryption);
		const service = new McpService(userData(), () => process.cwd(), () => undefined, {
			auth,
			// The browser: follow the authorization URL, which lands on the app's callback.
			openUrl: async (url) => {
				opened.push(url);
				await fetch(url);
			},
		});
		services.push(service);

		const before = await service.save({ name: "hosted", transport: "http", enabled: true, url: server.url });
		expect(before.servers[0].state).toBe("needs-auth");

		const after = await service.signIn(before.servers[0].config.id);

		expect(opened).toHaveLength(1);
		expect(new URL(opened[0]).searchParams.get("code_challenge_method")).toBe("S256");
		expect(server.registered()?.redirect_uris[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
		expect(after.servers[0]).toMatchObject({ state: "ready", signedIn: true });
		expect(service.toolNames()).toEqual(["mcp__hosted__whoami"]);

		const signedOut = await service.signOut(before.servers[0].config.id);
		expect(signedOut.servers[0]).toMatchObject({ state: "needs-auth", signedIn: false });
	});
});
