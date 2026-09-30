import { afterEach, describe, expect, test } from "bun:test";
import { createCipheriv } from "node:crypto";
import { createServer, connect, type Server, type Socket } from "node:net";
import { constants as zlibConstants, createDeflate } from "node:zlib";
import { RfbClient, vncAuthResponse, type RfbRect } from "./rfb";

/** Single DES straight from the definition, independent of the client's 3DES trick. */
function referenceAuth(password: string, challenge: Buffer): Buffer {
	const key = Buffer.alloc(8);
	Buffer.from(password, "latin1").copy(key, 0, 0, 8);
	const reversed = Buffer.from([...key].map((byte) => parseInt(byte.toString(2).padStart(8, "0").split("").reverse().join(""), 2)));
	const cipher = createCipheriv("des-ecb", reversed, null);
	cipher.setAutoPadding(false);
	return Buffer.concat([cipher.update(challenge), cipher.final()]);
}

/** Lets the fake server read exact byte counts, like the client does. */
function reader(socket: Socket) {
	let buffered = Buffer.alloc(0);
	let waiting: (() => void) | null = null;
	socket.on("data", (chunk) => {
		buffered = Buffer.concat([buffered, chunk]);
		waiting?.();
	});
	return async (count: number): Promise<Buffer> => {
		while (buffered.length < count) await new Promise<void>((resolve) => (waiting = resolve));
		const head = buffered.subarray(0, count);
		buffered = buffered.subarray(count);
		return head;
	};
}

const rgb = (r: number, g: number, b: number) => Buffer.from([r, g, b]);

const servers: Server[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.close(); });

async function serve(handler: (socket: Socket, read: (count: number) => Promise<Buffer>) => Promise<void>): Promise<number> {
	const server = createServer((socket) => void handler(socket, reader(socket)).catch(() => socket.destroy()));
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return (server.address() as { port: number }).port;
}

function header(x: number, y: number, width: number, height: number, encoding: number): Buffer {
	const buffer = Buffer.alloc(12);
	buffer.writeUInt16BE(x, 0);
	buffer.writeUInt16BE(y, 2);
	buffer.writeUInt16BE(width, 4);
	buffer.writeUInt16BE(height, 6);
	buffer.writeInt32BE(encoding, 8);
	return buffer;
}

function pixel(client: RfbClient, x: number, y: number): number[] {
	const index = (y * client.width + x) * 4;
	return [...client.framebuffer.subarray(index, index + 4)];
}

describe("vncAuthResponse", () => {
	test("matches DES with the bit-reversed password key", () => {
		const challenge = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
		for (const password of ["secret", "12345678", "longer-than-eight", ""]) {
			expect(vncAuthResponse(password, challenge).toString("hex")).toBe(referenceAuth(password, challenge).toString("hex"));
		}
	});
});

describe("RfbClient", () => {
	test("authenticates, decodes Raw, ZRLE and CopyRect, follows a resize, and sends input", async () => {
		const received: Buffer[] = [];
		let challengeOk = false;
		const port = await serve(async (socket, read) => {
			socket.write("RFB 003.008\n");
			expect((await read(12)).toString()).toBe("RFB 003.008\n");
			socket.write(Buffer.from([1, 2])); // one type: VNC auth
			expect((await read(1))[0]).toBe(2);
			const challenge = Buffer.alloc(16, 7);
			socket.write(challenge);
			challengeOk = (await read(16)).equals(referenceAuth("pw", challenge));
			socket.write(Buffer.alloc(4)); // SecurityResult OK
			expect((await read(1))[0]).toBe(1); // shared
			const init = Buffer.alloc(24);
			init.writeUInt16BE(100, 0);
			init.writeUInt16BE(70, 2);
			init.writeUInt32BE(4, 20);
			socket.write(Buffer.concat([init, Buffer.from("demo")]));
			const format = await read(20);
			expect([...format.subarray(4, 8)]).toEqual([32, 24, 0, 1]);
			const encodings = await read(4);
			await read(encodings.readUInt16BE(2) * 4);
			await read(10); // first update request

			// Update 1: a raw 2×1 strip, and a ZRLE rect over the whole 100×70 screen (4 tiles).
			const tiles: Buffer[] = [];
			// Tile (0,0) 64×64: solid red.
			tiles.push(Buffer.concat([Buffer.from([1]), rgb(255, 0, 0)]));
			// Tile (64,0) 36×64: packed palette of 2 — left half blue, right half green per row.
			const packedRow = Buffer.alloc(Math.ceil(36 / 8));
			for (let col = 18; col < 36; col++) packedRow[col >> 3] |= 0x80 >> (col & 7);
			tiles.push(Buffer.concat([Buffer.from([2]), rgb(0, 0, 255), rgb(0, 255, 0), ...Array(64).fill(packedRow)]));
			// Tile (0,64) 64×6: plain RLE — 100 white, then the rest grey.
			const rest = 64 * 6 - 100;
			const runBytes = (run: number) => {
				const out: number[] = [];
				let left = run - 1;
				while (left >= 255) { out.push(255); left -= 255; }
				out.push(left);
				return Buffer.from(out);
			};
			tiles.push(Buffer.concat([Buffer.from([128]), rgb(255, 255, 255), runBytes(100), rgb(9, 9, 9), runBytes(rest)]));
			// Tile (64,64) 36×6: palette RLE with a single pixel then a run.
			tiles.push(Buffer.concat([Buffer.from([130]), rgb(1, 2, 3), rgb(4, 5, 6), Buffer.from([0]), Buffer.from([0x81]), runBytes(36 * 6 - 1)]));
			const deflate = createDeflate();
			const compressed: Buffer[] = [];
			deflate.on("data", (chunk) => compressed.push(chunk));
			deflate.write(Buffer.concat(tiles));
			await new Promise<void>((resolve) => deflate.flush(zlibConstants.Z_SYNC_FLUSH, () => resolve()));
			const zdata = Buffer.concat(compressed);
			const zlen = Buffer.alloc(4);
			zlen.writeUInt32BE(zdata.length);
			const rawStrip = Buffer.from([10, 20, 30, 0, 40, 50, 60, 0]);
			const update = Buffer.concat([
				Buffer.from([0, 0, 0, 2]),
				header(0, 0, 100, 70, 16), zlen, zdata,
				header(0, 0, 2, 1, 0), rawStrip,
			]);
			socket.write(update);
			await read(10);
			// Update 2: copy the raw strip down to (10,10).
			const copy = Buffer.alloc(4);
			copy.writeUInt16BE(0, 0);
			copy.writeUInt16BE(0, 2);
			socket.write(Buffer.concat([Buffer.from([0, 0, 0, 1]), header(10, 10, 2, 1, 1), copy]));
			await read(10);
			socket.on("data", (chunk) => received.push(chunk));
			// Update 3: the screen grows.
			socket.write(Buffer.concat([Buffer.from([0, 0, 0, 1]), header(0, 0, 120, 80, -223)]));
		});

		const updates: number[] = [];
		let resized: [number, number] | null = null;
		const socket = connect(port, "127.0.0.1");
		await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
		const client = await RfbClient.connect(socket, {
			password: "pw",
			onUpdate: (rects) => updates.push(rects.length),
			onResize: (width, height) => (resized = [width, height]),
		});
		expect(client.title).toBe("demo");
		expect(client.width).toBe(100);
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(challengeOk).toBe(true);
		expect(updates.slice(0, 2)).toEqual([2, 1]);
		expect(resized as [number, number] | null).toEqual([120, 80]);
		expect(client.width).toBe(120);

		client.pointer(5, 6, 1);
		client.key(0xff0d, true);
		await new Promise((resolve) => setTimeout(resolve, 100));
		const bytes = Buffer.concat(received);
		const pointerAt = bytes.indexOf(Buffer.from([5, 1, 0, 5, 0, 6]));
		expect(pointerAt).toBeGreaterThanOrEqual(0);
		expect(bytes.indexOf(Buffer.from([4, 1, 0, 0, 0, 0, 0xff, 0x0d]))).toBeGreaterThanOrEqual(0);
		client.close();
	});

	test("puts the right pixels where ZRLE, Raw and CopyRect say", async () => {
		const port = await serve(async (socket, read) => {
			socket.write("RFB 003.008\n");
			await read(12);
			socket.write(Buffer.from([1, 1])); // None
			await read(1);
			socket.write(Buffer.alloc(4));
			await read(1);
			const init = Buffer.alloc(24);
			init.writeUInt16BE(100, 0);
			init.writeUInt16BE(70, 2);
			socket.write(init);
			await read(20);
			const encodings = await read(4);
			await read(encodings.readUInt16BE(2) * 4);
			await read(10);
			const packedRow = Buffer.alloc(Math.ceil(36 / 8));
			for (let col = 18; col < 36; col++) packedRow[col >> 3] |= 0x80 >> (col & 7);
			const tiles = Buffer.concat([
				Buffer.from([1]), rgb(255, 0, 0),
				Buffer.from([2]), rgb(0, 0, 255), rgb(0, 255, 0), ...Array(64).fill(packedRow),
				Buffer.from([128]), rgb(255, 255, 255), Buffer.from([99]), rgb(9, 9, 9), Buffer.from([255, 28]),
				Buffer.from([130]), rgb(1, 2, 3), rgb(4, 5, 6), Buffer.from([0, 0x81, 214]),
			]);
			const deflate = createDeflate();
			const compressed: Buffer[] = [];
			deflate.on("data", (chunk) => compressed.push(chunk));
			deflate.write(tiles);
			await new Promise<void>((resolve) => deflate.flush(zlibConstants.Z_SYNC_FLUSH, () => resolve()));
			const zdata = Buffer.concat(compressed);
			const zlen = Buffer.alloc(4);
			zlen.writeUInt32BE(zdata.length);
			const copy = Buffer.alloc(4);
			socket.write(Buffer.concat([
				Buffer.from([0, 0, 0, 3]),
				header(0, 0, 100, 70, 16), zlen, zdata,
				header(0, 0, 2, 1, 0), Buffer.from([10, 20, 30, 0, 40, 50, 60, 0]),
				header(10, 10, 2, 1, 1), copy,
			]));
		});
		const socket = connect(port, "127.0.0.1");
		await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
		const updated = new Promise<void>((resolve) => {
			void RfbClient.connect(socket, { onUpdate: () => resolve() }).then((value) => (client = value));
		});
		let client!: RfbClient;
		await updated;
		expect(pixel(client, 0, 0)).toEqual([10, 20, 30, 255]); // raw, after the ZRLE underneath
		expect(pixel(client, 1, 0)).toEqual([40, 50, 60, 255]);
		expect(pixel(client, 10, 10)).toEqual([10, 20, 30, 255]); // copied
		expect(pixel(client, 30, 30)).toEqual([255, 0, 0, 255]); // solid tile
		expect(pixel(client, 64 + 5, 3)).toEqual([0, 0, 255, 255]); // packed palette, left
		expect(pixel(client, 64 + 30, 60)).toEqual([0, 255, 0, 255]); // packed palette, right
		expect(pixel(client, 0, 64)).toEqual([255, 255, 255, 255]); // plain RLE: first 100 of 64×6
		// Tiles are 64 wide: index 99, the last white, is (35,65); index 100 is (36,65).
		expect(pixel(client, 35, 65)).toEqual([255, 255, 255, 255]);
		expect(pixel(client, 36, 65)).toEqual([9, 9, 9, 255]);
		expect(pixel(client, 64, 64)).toEqual([1, 2, 3, 255]); // palette RLE single
		expect(pixel(client, 99, 69)).toEqual([4, 5, 6, 255]); // palette RLE run to the end
		client.close();
	});

	test("skips cursor shapes, and keeps a request waiting at the server when polling", async () => {
		let requests = 0;
		let sent = false;
		const port = await serve(async (socket, read) => {
			socket.write("RFB 003.008\n");
			await read(12);
			socket.write(Buffer.from([1, 1]));
			await read(1);
			socket.write(Buffer.alloc(4));
			await read(1);
			const init = Buffer.alloc(24);
			init.writeUInt16BE(4, 0);
			init.writeUInt16BE(2, 2);
			socket.write(init);
			await read(20);
			const encodings = await read(4);
			const list = await read(encodings.readUInt16BE(2) * 4);
			expect([...Array(list.length / 4).keys()].map((i) => list.readInt32BE(i * 4))).toContain(-239);
			for (;;) {
				const type = (await read(1))[0];
				if (type !== 3) return;
				await read(9);
				requests++;
				if (sent) continue;
				sent = true;
				// A 2×2 cursor shape (pixels + 1-bit mask), then one raw pixel.
				const cursor = Buffer.concat([header(0, 0, 2, 2, -239), Buffer.alloc(2 * 2 * 4, 9), Buffer.from([0xc0, 0xc0])]);
				const raw = Buffer.concat([header(3, 1, 1, 1, 0), Buffer.from([1, 2, 3, 0])]);
				socket.write(Buffer.concat([Buffer.from([0, 0, 0, 2]), cursor, raw]));
			}
		});
		const socket = connect(port, "127.0.0.1");
		await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
		const updates: RfbRect[][] = [];
		const client = await RfbClient.connect(socket, { pollMs: 20, onUpdate: (rects) => updates.push(rects) });
		await new Promise((resolve) => setTimeout(resolve, 200));
		// The cursor is neither drawn nor reported as a change.
		expect(updates).toEqual([[{ x: 3, y: 1, width: 1, height: 1 }]]);
		expect(pixel(client, 0, 0)).toEqual([0, 0, 0, 255]);
		expect(pixel(client, 3, 1)).toEqual([1, 2, 3, 255]);
		expect(requests).toBeGreaterThan(4);
		client.close();
	});

	test("reports a rejected password", async () => {
		const port = await serve(async (socket, read) => {
			socket.write("RFB 003.008\n");
			await read(12);
			socket.write(Buffer.from([1, 2]));
			await read(1);
			socket.write(Buffer.alloc(16));
			await read(16);
			const fail = Buffer.alloc(4);
			fail.writeUInt32BE(1);
			const why = Buffer.from("bad password");
			const length = Buffer.alloc(4);
			length.writeUInt32BE(why.length);
			socket.write(Buffer.concat([fail, length, why]));
		});
		const socket = connect(port, "127.0.0.1");
		await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
		await expect(RfbClient.connect(socket, { password: "nope" })).rejects.toThrow(/password rejected: bad password/);
	});
});
