import { createCipheriv } from "node:crypto";
import type { Duplex } from "node:stream";
import { constants as zlibConstants, createInflate, type Inflate } from "node:zlib";

/**
 * A VNC (RFB 3.3–3.8) client, just enough of one: None and VNC password
 * security; Raw, CopyRect and ZRLE rectangles; the DesktopSize pseudo-encoding;
 * pointer and key events.
 *
 * The framebuffer is kept here as RGBA — the pixel format is chosen so the
 * server sends R, G, B in that byte order — so the panel can put it on a
 * canvas as is and a screenshot needs no conversion beyond the alpha byte.
 */

export interface RfbRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface RfbHandlers {
	/** Regions that changed in one server update. */
	onUpdate?: (rects: RfbRect[]) => void;
	onResize?: (width: number, height: number) => void;
	/** The connection ended; with the reason when it was not a clean close. */
	onClose?: (error: Error | null) => void;
}

const ENCODING_RAW = 0;
const ENCODING_COPYRECT = 1;
const ENCODING_ZRLE = 16;
const ENCODING_DESKTOP_SIZE = -223;
/**
 * Asked for so the server sends the pointer's shape apart from the picture
 * instead of painting it in: a pointer drawn into the framebuffer turns every
 * mouse move into a "change" and sits on top of what is under it.
 */
const ENCODING_CURSOR = -239;
const MAX_DIMENSION = 16384;

/** Reads exact byte counts from a stream, one read at a time. */
class ByteReader {
	private chunks: Buffer[] = [];
	private size = 0;
	private waiter: { count: number; resolve: (value: Buffer) => void; reject: (error: Error) => void } | null = null;
	private failure: Error | null = null;

	push(chunk: Buffer): void {
		this.chunks.push(chunk);
		this.size += chunk.length;
		this.drain();
	}

	fail(error: Error): void {
		this.failure ??= error;
		const waiter = this.waiter;
		this.waiter = null;
		waiter?.reject(this.failure);
	}

	private take(count: number): Buffer {
		const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
		const head = all.subarray(0, count);
		const rest = all.subarray(count);
		this.chunks = rest.length ? [rest] : [];
		this.size = rest.length;
		return head;
	}

	private drain(): void {
		if (this.waiter && this.size >= this.waiter.count) {
			const { count, resolve } = this.waiter;
			this.waiter = null;
			resolve(this.take(count));
		}
	}

	read(count: number): Promise<Buffer> {
		if (this.size >= count) return Promise.resolve(this.take(count));
		if (this.failure) return Promise.reject(this.failure);
		return new Promise((resolve, reject) => {
			this.waiter = { count, resolve, reject };
		});
	}

	async u8(): Promise<number> {
		return (await this.read(1))[0];
	}
	async u16(): Promise<number> {
		return (await this.read(2)).readUInt16BE(0);
	}
	async u32(): Promise<number> {
		return (await this.read(4)).readUInt32BE(0);
	}
}

/**
 * The VNC password response: DES over the challenge, keyed with the password's
 * first eight bytes each bit-reversed. Triple DES with the key three times over
 * is single DES, and unlike `des-ecb` it is in every runtime this runs on.
 */
export function vncAuthResponse(password: string, challenge: Buffer): Buffer {
	const key = Buffer.alloc(8);
	Buffer.from(password, "latin1").copy(key, 0, 0, 8);
	for (let i = 0; i < 8; i++) {
		let byte = key[i];
		let reversed = 0;
		for (let bit = 0; bit < 8; bit++) {
			reversed = (reversed << 1) | (byte & 1);
			byte >>= 1;
		}
		key[i] = reversed;
	}
	const cipher = createCipheriv("des-ede3", Buffer.concat([key, key, key]), null);
	cipher.setAutoPadding(false);
	return Buffer.concat([cipher.update(challenge), cipher.final()]);
}

async function reason(reader: ByteReader): Promise<string> {
	const length = await reader.u32();
	return (await reader.read(Math.min(length, 4096))).toString("utf8");
}

export class RfbClient {
	width = 0;
	height = 0;
	title = "";
	framebuffer = new Uint8Array(0);
	private reader = new ByteReader();
	private inflater: Inflate | null = null;
	private closed = false;
	private poll: ReturnType<typeof setInterval> | null = null;

	private constructor(
		private readonly stream: Duplex,
		private readonly handlers: RfbHandlers,
	) {}

	/** Handshake, authenticate, and start receiving updates. Resolves once the screen size is known. */
	static async connect(stream: Duplex, options: { password?: string | null; pollMs?: number } & RfbHandlers = {}): Promise<RfbClient> {
		const client = new RfbClient(stream, options);
		stream.on("data", (chunk: Buffer) => client.reader.push(chunk));
		stream.on("error", (error: Error) => client.finish(error));
		stream.on("close", () => client.finish(null));
		stream.on("end", () => client.finish(null));
		try {
			await client.handshake(options.password ?? null);
		} catch (error) {
			client.close();
			throw error;
		}
		void client.loop();
		// A server sends an update only against an outstanding request, and one
		// request per update caps a distant server at one update per round trip —
		// half a second apart over a slow link. A request always waiting lets each
		// change go out as soon as it is found. Ten bytes a tick is nothing.
		if (options.pollMs) {
			client.poll = setInterval(() => client.requestUpdate(true), options.pollMs);
			client.poll.unref?.();
		}
		return client;
	}

	private finish(error: Error | null): void {
		if (this.closed) return;
		this.closed = true;
		if (this.poll) clearInterval(this.poll);
		this.reader.fail(error ?? new Error("The remote desktop connection closed"));
		this.inflater?.close();
		this.handlers.onClose?.(error);
	}

	get isClosed(): boolean {
		return this.closed;
	}

	private async handshake(password: string | null): Promise<void> {
		const banner = (await this.reader.read(12)).toString("latin1");
		const match = /^RFB (\d{3})\.(\d{3})\n$/.exec(banner);
		if (!match) throw new Error("Not a VNC server");
		const minor = Number(match[1]) > 3 ? 8 : Math.min(Number(match[2]), 8);
		const version = minor >= 8 ? 8 : minor >= 7 ? 7 : 3;
		this.stream.write(`RFB 003.00${version}\n`);

		let type: number;
		if (version === 3) {
			type = await this.reader.u32();
			if (type === 0) throw new Error(`VNC server refused the connection: ${await reason(this.reader)}`);
		} else {
			const count = await this.reader.u8();
			if (count === 0) throw new Error(`VNC server refused the connection: ${await reason(this.reader)}`);
			const types = [...(await this.reader.read(count))];
			// A password is only for servers that ask for one; prefer None when offered.
			type = types.includes(1) ? 1 : types.includes(2) ? 2 : -1;
			if (type < 0) throw new Error(`The VNC server wants a security type this app does not support (${types.join(", ")})`);
			this.stream.write(Buffer.from([type]));
		}
		if (type === 2) {
			if (!password) throw new Error("The VNC server needs a password: save it with the host");
			const challenge = await this.reader.read(16);
			this.stream.write(vncAuthResponse(password, challenge));
		} else if (type !== 1) {
			throw new Error(`Unsupported VNC security type ${type}`);
		}
		// 3.7 reports the result only after a password; 3.8 always does.
		if (version === 8 || type === 2) {
			const result = await this.reader.u32();
			if (result !== 0) {
				const why = version === 8 ? await reason(this.reader).catch(() => "") : "";
				throw new Error(type === 2 ? `VNC password rejected${why ? `: ${why}` : ""}` : `VNC security failed${why ? `: ${why}` : ""}`);
			}
		}

		this.stream.write(Buffer.from([1])); // ClientInit: shared
		const init = await this.reader.read(24);
		this.resize(init.readUInt16BE(0), init.readUInt16BE(2));
		const nameLength = init.readUInt32BE(20);
		this.title = (await this.reader.read(Math.min(nameLength, 4096))).toString("utf8");
		if (nameLength > 4096) await this.reader.read(nameLength - 4096);

		// SetPixelFormat: 32 bpp, depth 24, little-endian true colour, R G B in byte order.
		const format = Buffer.alloc(20);
		format[0] = 0;
		format.set([32, 24, 0, 1], 4);
		format.writeUInt16BE(255, 8);
		format.writeUInt16BE(255, 10);
		format.writeUInt16BE(255, 12);
		format.set([0, 8, 16], 14);
		this.stream.write(format);

		const encodings = [ENCODING_ZRLE, ENCODING_COPYRECT, ENCODING_RAW, ENCODING_DESKTOP_SIZE, ENCODING_CURSOR];
		const set = Buffer.alloc(4 + encodings.length * 4);
		set[0] = 2;
		set.writeUInt16BE(encodings.length, 2);
		encodings.forEach((encoding, index) => set.writeInt32BE(encoding, 4 + index * 4));
		this.stream.write(set);
		this.requestUpdate(false);
	}

	private resize(width: number, height: number): void {
		if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION) throw new Error(`Implausible remote screen size ${width}×${height}`);
		this.width = width;
		this.height = height;
		this.framebuffer = new Uint8Array(width * height * 4);
		for (let i = 3; i < this.framebuffer.length; i += 4) this.framebuffer[i] = 255;
	}

	requestUpdate(incremental = true, rect: RfbRect = { x: 0, y: 0, width: this.width, height: this.height }): void {
		if (this.closed) return;
		const message = Buffer.alloc(10);
		message[0] = 3;
		message[1] = incremental ? 1 : 0;
		message.writeUInt16BE(rect.x, 2);
		message.writeUInt16BE(rect.y, 4);
		message.writeUInt16BE(rect.width, 6);
		message.writeUInt16BE(rect.height, 8);
		this.stream.write(message);
	}

	pointer(x: number, y: number, buttons: number): void {
		if (this.closed) return;
		const message = Buffer.alloc(6);
		message[0] = 5;
		message[1] = buttons & 0xff;
		message.writeUInt16BE(Math.max(0, Math.min(this.width - 1, Math.round(x))), 2);
		message.writeUInt16BE(Math.max(0, Math.min(this.height - 1, Math.round(y))), 4);
		this.stream.write(message);
	}

	key(keysym: number, down: boolean): void {
		if (this.closed) return;
		const message = Buffer.alloc(8);
		message[0] = 4;
		message[1] = down ? 1 : 0;
		message.writeUInt32BE(keysym >>> 0, 4);
		this.stream.write(message);
	}

	close(): void {
		if (!this.closed) this.stream.destroy();
		this.finish(null);
	}

	private async loop(): Promise<void> {
		try {
			while (!this.closed) {
				const type = await this.reader.u8();
				switch (type) {
					case 0:
						await this.update();
						break;
					case 1: {
						// SetColourMapEntries: never asked for with true colour; skip it.
						const header = await this.reader.read(5);
						await this.reader.read(header.readUInt16BE(3) * 6);
						break;
					}
					case 2: // Bell
						break;
					case 3: {
						await this.reader.read(3);
						const length = await this.reader.u32();
						await this.reader.read(length);
						break;
					}
					default:
						throw new Error(`Unknown VNC server message ${type}`);
				}
			}
		} catch (error) {
			if (!this.closed) {
				this.stream.destroy();
				this.finish(error instanceof Error ? error : new Error(String(error)));
			}
		}
	}

	private async update(): Promise<void> {
		await this.reader.read(1);
		const count = await this.reader.u16();
		const rects: RfbRect[] = [];
		let resized = false;
		for (let i = 0; i < count; i++) {
			const header = await this.reader.read(12);
			const rect = { x: header.readUInt16BE(0), y: header.readUInt16BE(2), width: header.readUInt16BE(4), height: header.readUInt16BE(6) };
			const encoding = header.readInt32BE(8);
			if (encoding === ENCODING_DESKTOP_SIZE) {
				this.resize(rect.width, rect.height);
				resized = true;
				continue;
			}
			if (encoding === ENCODING_CURSOR) {
				// The shape (32-bit pixels) and its 1-bit mask; not drawn anywhere.
				await this.reader.read(rect.width * rect.height * 4 + Math.ceil(rect.width / 8) * rect.height);
				continue;
			}
			if (rect.x + rect.width > this.width || rect.y + rect.height > this.height) throw new Error("VNC rectangle outside the screen");
			if (encoding === ENCODING_RAW) this.raw(rect, await this.reader.read(rect.width * rect.height * 4));
			else if (encoding === ENCODING_COPYRECT) this.copyRect(rect, await this.reader.u16(), await this.reader.u16());
			else if (encoding === ENCODING_ZRLE) {
				const length = await this.reader.u32();
				this.zrle(rect, await this.inflate(await this.reader.read(length)));
			} else throw new Error(`The VNC server sent an unrequested encoding (${encoding})`);
			rects.push(rect);
		}
		if (resized) this.handlers.onResize?.(this.width, this.height);
		if (rects.length || resized) this.handlers.onUpdate?.(resized ? [{ x: 0, y: 0, width: this.width, height: this.height }] : rects);
		this.requestUpdate(!resized);
	}

	private raw(rect: RfbRect, data: Buffer): void {
		const fb = this.framebuffer;
		for (let row = 0; row < rect.height; row++) {
			let source = row * rect.width * 4;
			let target = ((rect.y + row) * this.width + rect.x) * 4;
			for (let col = 0; col < rect.width; col++, source += 4, target += 4) {
				fb[target] = data[source];
				fb[target + 1] = data[source + 1];
				fb[target + 2] = data[source + 2];
			}
		}
	}

	private copyRect(rect: RfbRect, sourceX: number, sourceY: number): void {
		if (sourceX + rect.width > this.width || sourceY + rect.height > this.height) throw new Error("VNC CopyRect source outside the screen");
		const stride = this.width * 4;
		const rowBytes = rect.width * 4;
		const copy = new Uint8Array(rowBytes * rect.height);
		for (let row = 0; row < rect.height; row++) {
			const start = (sourceY + row) * stride + sourceX * 4;
			copy.set(this.framebuffer.subarray(start, start + rowBytes), row * rowBytes);
		}
		for (let row = 0; row < rect.height; row++) {
			this.framebuffer.set(copy.subarray(row * rowBytes, (row + 1) * rowBytes), (rect.y + row) * stride + rect.x * 4);
		}
	}

	/** ZRLE shares one zlib stream across the connection, so its dictionary must survive between rectangles. */
	private inflate(data: Buffer): Promise<Buffer> {
		this.inflater ??= createInflate();
		const inflater = this.inflater;
		return new Promise((resolve, reject) => {
			const out: Buffer[] = [];
			const onData = (chunk: Buffer) => out.push(chunk);
			const onError = (error: Error) => {
				inflater.off("data", onData);
				reject(error);
			};
			inflater.on("data", onData);
			inflater.once("error", onError);
			inflater.write(data);
			inflater.flush(zlibConstants.Z_SYNC_FLUSH, () => {
				inflater.off("data", onData);
				inflater.off("error", onError);
				resolve(Buffer.concat(out));
			});
		});
	}

	private zrle(rect: RfbRect, data: Buffer): void {
		let offset = 0;
		const need = (count: number) => {
			if (offset + count > data.length) throw new Error("Truncated ZRLE data");
		};
		const cpixel = (): number => {
			need(3);
			const value = data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16);
			offset += 3;
			return value;
		};
		const fb = this.framebuffer;
		const put = (x: number, y: number, pixel: number) => {
			const index = (y * this.width + x) * 4;
			fb[index] = pixel & 0xff;
			fb[index + 1] = (pixel >> 8) & 0xff;
			fb[index + 2] = (pixel >> 16) & 0xff;
		};
		for (let tileY = rect.y; tileY < rect.y + rect.height; tileY += 64) {
			const tileHeight = Math.min(64, rect.y + rect.height - tileY);
			for (let tileX = rect.x; tileX < rect.x + rect.width; tileX += 64) {
				const tileWidth = Math.min(64, rect.x + rect.width - tileX);
				need(1);
				const mode = data[offset++];
				const total = tileWidth * tileHeight;
				// Pixels are laid out row by row within the tile.
				const at = (index: number, pixel: number) => put(tileX + (index % tileWidth), tileY + Math.floor(index / tileWidth), pixel);
				if (mode === 0) {
					for (let i = 0; i < total; i++) at(i, cpixel());
				} else if (mode === 1) {
					const pixel = cpixel();
					for (let i = 0; i < total; i++) at(i, pixel);
				} else if (mode >= 2 && mode <= 16) {
					const palette = Array.from({ length: mode }, cpixel);
					const bits = mode === 2 ? 1 : mode <= 4 ? 2 : 4;
					const perRow = Math.ceil((tileWidth * bits) / 8);
					need(perRow * tileHeight);
					for (let row = 0; row < tileHeight; row++) {
						const rowStart = offset + row * perRow;
						for (let col = 0; col < tileWidth; col++) {
							const bit = col * bits;
							const byte = data[rowStart + (bit >> 3)];
							const index = (byte >> (8 - bits - (bit & 7))) & ((1 << bits) - 1);
							put(tileX + col, tileY + row, palette[index] ?? 0);
						}
					}
					offset += perRow * tileHeight;
				} else if (mode === 128 || mode >= 130) {
					const palette = mode === 128 ? null : Array.from({ length: mode - 128 }, cpixel);
					let i = 0;
					while (i < total) {
						let pixel: number;
						let run = 1;
						if (palette) {
							need(1);
							const index = data[offset++];
							pixel = palette[index & 0x7f] ?? 0;
							if (index & 0x80) run = this.runLength(data, () => offset, (next) => (offset = next));
						} else {
							pixel = cpixel();
							run = this.runLength(data, () => offset, (next) => (offset = next));
						}
						if (i + run > total) throw new Error("ZRLE run past the end of its tile");
						for (let end = i + run; i < end; i++) at(i, pixel);
					}
				} else {
					throw new Error(`Invalid ZRLE tile subencoding ${mode}`);
				}
			}
		}
	}

	private runLength(data: Buffer, get: () => number, set: (offset: number) => void): number {
		let offset = get();
		let run = 1;
		for (;;) {
			if (offset >= data.length) throw new Error("Truncated ZRLE run length");
			const byte = data[offset++];
			run += byte;
			if (byte !== 255) break;
		}
		set(offset);
		return run;
	}
}
