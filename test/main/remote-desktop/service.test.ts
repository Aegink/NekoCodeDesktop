import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createCipheriv } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { Server, utils, type Connection } from "ssh2";
import type { DesktopFrame, DesktopState } from "../../../src/shared/remote-desktop";
import { SshService } from "../../../src/main/ssh-service";
import { SshStore } from "../../../src/main/ssh-store";
import { clusterRects, parseLaunchOutput, RemoteDesktopService, X11VNC_LAUNCH_SCRIPT } from "../../../src/main/remote-desktop/service";
import { configureRemoteDesktopTool, createRemoteDesktopTool, screenshotScale } from "../../../src/main/remote-desktop/tool";

const SCREEN = { width: 1920, height: 1080 };

function des(password: string, challenge: Buffer): Buffer {
	const key = Buffer.alloc(8);
	Buffer.from(password, "latin1").copy(key, 0, 0, 8);
	const reversed = Buffer.from([...key].map((byte) => parseInt(byte.toString(2).padStart(8, "0").split("").reverse().join(""), 2)));
	const cipher = createCipheriv("des-ecb", reversed, null);
	cipher.setAutoPadding(false);
	return Buffer.concat([cipher.update(challenge), cipher.final()]);
}

type Event = { type: "pointer"; x: number; y: number; buttons: number } | { type: "key"; keysym: number; down: boolean };

/** A VNC server on one stream: password auth, a solid screen, and a log of the input it receives. */
async function serveRfb(stream: Duplex, password: string, events: Event[]): Promise<void> {
	let buffered = Buffer.alloc(0);
	let wake: (() => void) | null = null;
	stream.on("data", (chunk: Buffer) => {
		buffered = Buffer.concat([buffered, chunk]);
		wake?.();
	});
	const read = async (count: number) => {
		while (buffered.length < count) await new Promise<void>((resolve) => (wake = resolve));
		const head = buffered.subarray(0, count);
		buffered = buffered.subarray(count);
		return head;
	};
	stream.write("RFB 003.008\n");
	await read(12);
	stream.write(Buffer.from([1, 2]));
	await read(1);
	const challenge = Buffer.alloc(16, 3);
	stream.write(challenge);
	const ok = (await read(16)).equals(des(password, challenge));
	const result = Buffer.alloc(4);
	result.writeUInt32BE(ok ? 0 : 1);
	stream.write(ok ? result : Buffer.concat([result, Buffer.from([0, 0, 0, 3]), Buffer.from("bad")]));
	if (!ok) return;
	await read(1);
	const init = Buffer.alloc(24);
	init.writeUInt16BE(SCREEN.width, 0);
	init.writeUInt16BE(SCREEN.height, 2);
	init.writeUInt32BE(7, 20);
	stream.write(Buffer.concat([init, Buffer.from("desktop")]));
	for (;;) {
		const type = (await read(1))[0];
		if (type === 0) await read(19);
		else if (type === 2) {
			const header = await read(3);
			await read(header.readUInt16BE(1) * 4);
		} else if (type === 3) {
			const request = await read(9);
			if (request[0] === 0) {
				// A full request: one grey band at the top, as ZRLE would be overkill here.
				const header = Buffer.alloc(16);
				header.writeUInt16BE(1, 2);
				header.writeUInt16BE(SCREEN.width, 8);
				header.writeUInt16BE(1, 10);
				header.writeInt32BE(0, 12);
				stream.write(Buffer.concat([header, Buffer.alloc(SCREEN.width * 4, 128)]));
			}
		} else if (type === 4) {
			const key = await read(7);
			events.push({ type: "key", down: key[0] === 1, keysym: key.readUInt32BE(3) });
		} else if (type === 5) {
			const pointer = await read(5);
			const event = { type: "pointer" as const, buttons: pointer[0], x: pointer.readUInt16BE(1), y: pointer.readUInt16BE(3) };
			events.push(event);
			// A press repaints a 40×40 patch under the pointer, as a button would.
			if (event.buttons & 1) {
				const x = Math.min(SCREEN.width - 40, Math.max(0, event.x - 20));
				const y = Math.min(SCREEN.height - 40, Math.max(0, event.y - 20));
				const header = Buffer.alloc(16);
				header.writeUInt16BE(1, 2);
				header.writeUInt16BE(x, 4);
				header.writeUInt16BE(y, 6);
				header.writeUInt16BE(40, 8);
				header.writeUInt16BE(40, 10);
				header.writeInt32BE(0, 12);
				stream.write(Buffer.concat([header, Buffer.alloc(40 * 40 * 4, 200)]));
			}
		} else return;
	}
}

let server: Server;
let store: SshStore;
let service: RemoteDesktopService;
let hostId: string;
const dirs: string[] = [];
const events: Event[] = [];
const launches: string[] = [];
const emitted: Array<{ channel: string; payload: unknown }> = [];
const encoded: Array<{ region: { x: number; y: number; width: number; height: number }; target: { width: number; height: number } }> = [];
const a11yScripts: string[] = [];
/** What the fake desktop's accessibility tree holds, as the Python script would print it. */
const A11Y_OUTPUT = JSON.stringify({
	elements: [
		{ role: "password text", name: "密码", text: "••", states: ["focused", "editable"], x: 810, y: 480, width: 300, height: 30, app: "lightdm", window: "Login", active: true },
		{ role: "push button", name: "登录", states: [], x: 900, y: 600, width: 120, height: 40, app: "lightdm", window: "Login", active: true },
		{ role: "push button", name: "Dock", states: [], x: 500, y: 1150, width: 48, height: 48, app: "panel", window: "", active: false },
	],
	omitted: 3,
});

beforeAll(async () => {
	const key = utils.generateKeyPairSync("ed25519");
	let oneTimePassword = "";
	server = new Server({ hostKeys: [key.private] }, (client: Connection) => {
		client.on("error", () => {});
		client.on("authentication", (ctx) => (ctx.method === "password" && ctx.password === "pw" ? ctx.accept() : ctx.reject(["password"])));
		client.on("ready", () => {
			client.on("session", (accept) => {
				accept().on("exec", (acceptExec, _reject, info) => {
					const stream = acceptExec();
					let input = "";
					if (info.command.includes("python3 -")) {
						// The accessibility wrapper: the script arrives on stdin, then EOF.
						stream.on("data", (chunk: Buffer) => (input += chunk.toString()));
						stream.on("end", () => {
							a11yScripts.push(input);
							stream.write(`${A11Y_OUTPUT}\n`);
							stream.exit(0);
							stream.end();
						});
						return;
					}
					launches.push(info.command);
					stream.on("data", (chunk: Buffer) => {
						input += chunk.toString();
						if (!input.includes("\n")) return;
						oneTimePassword = input.trim();
						stream.write("NEKO_DISPLAY=:10\nNEKO_PORT=5950\n");
						stream.exit(0);
						stream.end();
					});
				});
			});
			client.on("tcpip", (accept, _reject, info) => {
				if (info.destPort !== 5950) return _reject();
				void serveRfb(accept(), oneTimePassword, events);
			});
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	const dir = mkdtempSync(join(tmpdir(), "nekocode-desktop-"));
	dirs.push(dir);
	store = new SshStore(dir, {
		isEncryptionAvailable: () => true,
		getSelectedStorageBackend: () => "kwallet6" as const,
		encryptString: (value: string) => Buffer.from(value, "utf8").reverse(),
		decryptString: (value: Buffer) => Buffer.from(value).reverse().toString("utf8"),
	});
	store.save({ name: "gui", host: "127.0.0.1", port, username: "neko", auth: "password", secret: "pw" });
	hostId = store.hosts()[0].id;
	const ssh = new SshService(store);
	service = new RemoteDesktopService({
		connect: (id) => ssh.dedicated(id),
		emit: (channel, payload) => emitted.push({ channel, payload }),
		frameIntervalMs: 10,
	});
	configureRemoteDesktopTool(() => ({
		store,
		service,
		encode: (_rgba, _width, _height, region, target) => {
			encoded.push({ region, target });
			return { data: "aW1n", mimeType: "image/png" };
		},
	}));
});

afterAll(() => {
	service.disconnectAll();
	server.close();
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const tool = createRemoteDesktopTool();
async function call(params: Record<string, unknown>) {
	const result = await tool.execute("call", params as never, undefined, undefined, undefined as never);
	return result.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
}

describe("remote desktop over SSH", () => {
	test("starts x11vnc through sh -c, tunnels to it, and authenticates with the one-time password", async () => {
		const content = await call({ op: "screenshot" });
		expect(launches).toHaveLength(1);
		expect(launches[0].startsWith("sh -c '")).toBe(true);
		expect(launches[0]).toContain("x11vnc -display");
		expect(content[0].text).toBe("[gui] Screen 1920×1080, shown at 1280×720: give coordinates in these screenshot pixels.");
		expect(content[1]).toEqual({ type: "image", data: "aW1n", mimeType: "image/png" });
		expect(encoded.at(-1)).toEqual({ region: { x: 0, y: 0, width: 1920, height: 1080 }, target: { width: 1280, height: 720 } });
		expect(service.display(hostId)).toBe("10");
		const state = service.state(hostId) as DesktopState;
		expect(state).toMatchObject({ phase: "connected", controller: "agent", width: 1920, height: 1080, title: "desktop", hostName: "gui" });
	});

	test("scales clicks to the screen, and returns only the region that changed", async () => {
		events.length = 0;
		const content = await call({ op: "click", x: 640, y: 360 });
		const presses = events.filter((event) => event.type === "pointer" && event.buttons === 1);
		expect(presses).toEqual([{ type: "pointer", buttons: 1, x: 960, y: 540 }]);
		// The patch is 940–980 × 520–560 on screen; with the margin, 916–1004 × 496–584.
		expect(encoded.at(-1)).toEqual({ region: { x: 916, y: 496, width: 88, height: 88 }, target: { width: 59, height: 59 } });
		expect(content[0].text).toContain("[gui] click done. Only part of the screen changed;");
		expect(content[0].text).toContain("image 1: (611, 331)–(669, 389)");
		expect(content[1]).toMatchObject({ type: "image" });
		const marks = emitted.filter((entry) => entry.channel === "desktop:action").map((entry) => entry.payload);
		expect(marks.at(-1)).toMatchObject({ hostId, kind: "click", x: 960, y: 540 });
	});

	test("says so, without an image, when nothing changed", async () => {
		const content = await call({ op: "key", keys: "shift" });
		expect(content).toEqual([{ type: "text", text: "[gui] key shift done. The screen did not change since your last look." }]);
	});

	test("types text and presses combos as keysyms, modifiers held around the key", async () => {
		events.length = 0;
		await call({ op: "type", text: "Hi" });
		await call({ op: "key", keys: "ctrl+shift+t" });
		const keys = events.filter((event) => event.type === "key").map((event) => event.type === "key" ? `${event.down ? "+" : "-"}${event.keysym.toString(16)}` : "");
		expect(keys).toEqual(["+48", "-48", "+69", "-69", "+ffe3", "+ffe1", "+74", "-74", "-ffe1", "-ffe3"]);
		await expect(call({ op: "key", keys: "ctrl+hyper" })).rejects.toThrow(/Unknown key: hyper/);
	});

	test("refuses the agent while the user holds control, and passes the user's input", async () => {
		service.setController(hostId, "user");
		await expect(call({ op: "click", x: 1, y: 1 })).rejects.toThrow(/user has taken control/);
		events.length = 0;
		service.userPointer({ hostId, x: 10, y: 20, buttons: 4 });
		service.userKey({ hostId, keysym: 0xff0d, down: true });
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(events).toEqual([
			{ type: "pointer", buttons: 4, x: 10, y: 20 },
			{ type: "key", keysym: 0xff0d, down: true },
		]);
		service.setController(hostId, "agent");
		events.length = 0;
		service.userPointer({ hostId, x: 1, y: 1, buttons: 1 });
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(events).toEqual([]);
	});

	test("sends the panel a full frame when it starts watching", () => {
		emitted.length = 0;
		service.watch(hostId, true);
		const frame = emitted.find((entry) => entry.channel === "desktop:frame")?.payload as DesktopFrame;
		expect(frame).toMatchObject({ hostId, x: 0, y: 0, width: 1920, height: 1080, full: true, screenWidth: 1920 });
		expect([...frame.data.subarray(0, 4)]).toEqual([128, 128, 128, 255]);
		service.watch(hostId, false);
	});

	test("runs a sequence in one call, and stops at the step that fails", async () => {
		events.length = 0;
		const content = await call({
			op: "sequence",
			steps: [
				{ op: "click", x: 300, y: 300 },
				{ op: "type", text: "pw" },
				{ op: "key", keys: "enter" },
			],
		});
		expect(content[0].text).toStartWith("[gui] click → type (2 characters) → key enter done.");
		const keys = events.filter((event) => event.type === "key" && event.down).map((event) => (event.type === "key" ? event.keysym : 0));
		expect(keys).toEqual([0x70, 0x77, 0xff0d]);
		await expect(call({ op: "sequence", steps: [{ op: "key", keys: "tab" }, { op: "key", keys: "nope" }] })).rejects.toThrow(
			/Step 2 \(key\) failed after 1 done: Unknown key: nope/,
		);
	});

	test("lists elements as the desktop's user, and acts on them by number", async () => {
		const content = await call({ op: "elements" });
		const script = a11yScripts.at(-1) ?? "";
		expect(script).toContain("org.a11y.Bus");
		// The options travel as the script's first line, a Python string holding JSON.
		expect(JSON.parse(JSON.parse(script.split("\n")[0].slice("OPTS = ".length)))).toEqual({ limit: 150, query: "", width: 1920, height: 1080 });
		const text = content[0].text ?? "";
		expect(text).toContain('Active window "Login" (lightdm):');
		expect(text).toContain('[1] password text "密码" [focused, editable] (540,320 200×20) = "••"');
		expect(text).toContain('[2] push button "登录" (600,400 80×27)');
		expect(text).toContain('[3] push button "Dock" off-screen?');
		expect(text).toContain("(3 more not listed; narrow with query)");
		events.length = 0;
		await call({ op: "click", element: 2 });
		expect(events.filter((event) => event.type === "pointer" && event.buttons === 1)).toEqual([{ type: "pointer", buttons: 1, x: 960, y: 620 }]);
		events.length = 0;
		await call({ op: "type", element: 1, text: "x" });
		expect(events.find((event) => event.type === "pointer" && event.buttons === 1)).toEqual({ type: "pointer", buttons: 1, x: 960, y: 495 });
		await expect(call({ op: "click", element: 3 })).rejects.toThrow(/outside the screen/);
		await expect(call({ op: "click", element: 9 })).rejects.toThrow(/No element 9/);
	});

	test("zooms into a region at full resolution", async () => {
		const content = await call({ op: "zoom", x: 100, y: 100, width: 200, height: 100 });
		expect(encoded.at(-1)).toEqual({ region: { x: 150, y: 150, width: 300, height: 150 }, target: { width: 1200, height: 600 } });
		expect(content[0].text).toContain("enlarged 6.0×");
	});

	test("look=screen always sends the whole screen, look=none never an image", async () => {
		expect((await call({ op: "move", x: 10, y: 10, look: "screen" })).map((part) => part.type)).toEqual(["text", "image"]);
		expect((await call({ op: "click", x: 10, y: 10, look: "none" })).map((part) => part.type)).toEqual(["text"]);
	});

	test("rejects coordinates outside the screenshot", async () => {
		await expect(call({ op: "click", x: 2000, y: 10 })).rejects.toThrow(/outside the 1280×720 screenshot/);
	});

	test("disconnecting closes it, and the next action reconnects", async () => {
		service.disconnect(hostId);
		expect(service.state(hostId)).toBeNull();
		await call({ op: "screenshot" });
		expect(launches).toHaveLength(2);
		expect(service.state(hostId)?.phase).toBe("connected");
	});
});

describe("launch output", () => {
	test("reads the port, or explains what is missing", () => {
		expect(parseLaunchOutput("NEKO_PORT=5951\n", "h")).toEqual({ port: 5951, display: null });
		expect(parseLaunchOutput("NEKO_DISPLAY=:10\nNEKO_PORT=5951\n", "h")).toEqual({ port: 5951, display: "10" });
		expect(parseLaunchOutput("NEKO_ERR=missing\n", "h")).toMatchObject({ error: expect.stringContaining("apt install x11vnc") });
		expect(parseLaunchOutput("NEKO_ERR=no-display\n", "h")).toMatchObject({ error: expect.stringContaining("No graphical X session") });
		expect(parseLaunchOutput("NEKO_ERR=start\nXOpenDisplay failed\n", "h")).toMatchObject({ error: expect.stringContaining("XOpenDisplay failed") });
	});

	test("the script has no doubled backslashes for fish to eat", () => {
		expect(X11VNC_LAUNCH_SCRIPT.includes("\\\\")).toBe(false);
		expect(X11VNC_LAUNCH_SCRIPT).toContain("-localhost");
		expect(X11VNC_LAUNCH_SCRIPT).toContain('-passwdfile "rm:$f"');
		// A user's session outranks root's display, which is usually the login screen.
		expect(X11VNC_LAUNCH_SCRIPT).toContain('elif [ "$owner" != 0 ]; then rank=1');
		// Root attaching to another user's X server cannot share memory with it.
		expect(X11VNC_LAUNCH_SCRIPT).toContain('[ "$dispowner" = "$me" ] || shm=-noshm');
	});

	test("groups nearby changes and keeps distant ones apart, largest first", () => {
		const dialog = [
			{ x: 500, y: 300, width: 400, height: 20 },
			{ x: 500, y: 330, width: 400, height: 200 },
		];
		const clock = { x: 1850, y: 5, width: 60, height: 16 };
		expect(clusterRects([clock, ...dialog], 32)).toEqual([{ x: 500, y: 300, width: 400, height: 230 }, clock]);
	});

	test("screenshots keep within 1280×800 and never upscale", () => {
		expect(screenshotScale(1920, 1080)).toMatchObject({ width: 1280, height: 720 });
		expect(screenshotScale(2560, 1600)).toMatchObject({ width: 1280, height: 800 });
		expect(screenshotScale(1024, 768)).toEqual({ width: 1024, height: 768, factor: 1 });
	});
});
