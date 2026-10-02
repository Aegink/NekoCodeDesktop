import { describe, expect, test } from "bun:test";
import { bufferReader, fontDisplayName, mergeFontFamilies, readFontInfos } from "../../src/shared/font-names";

type NameEntry = { platform: number; encoding: number; language: number; nameId: number; value: string };

function utf16be(value: string): number[] {
	const out: number[] = [];
	for (const char of value) {
		const code = char.charCodeAt(0);
		out.push(code >> 8, code & 0xff);
	}
	return out;
}

function u16(value: number): number[] {
	return [(value >> 8) & 0xff, value & 0xff];
}

function u32(value: number): number[] {
	return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function nameTable(entries: NameEntry[]): number[] {
	const strings: number[] = [];
	const records: number[] = [];
	for (const entry of entries) {
		const bytes = utf16be(entry.value);
		records.push(
			...u16(entry.platform),
			...u16(entry.encoding),
			...u16(entry.language),
			...u16(entry.nameId),
			...u16(bytes.length),
			...u16(strings.length),
		);
		strings.push(...bytes);
	}
	return [...u16(0), ...u16(entries.length), ...u16(6 + records.length), ...records, ...strings];
}

function os2Table({ codePages, monoPanose }: { codePages: number; monoPanose: boolean }): number[] {
	const bytes = new Array(86).fill(0);
	bytes[1] = 1; // version 1
	bytes[32] = 2; // panose family: Latin text
	bytes[35] = monoPanose ? 9 : 3;
	bytes.splice(78, 4, ...u32(codePages));
	return bytes;
}

function postTable(fixedPitch: boolean): number[] {
	return [...u32(0x00030000), ...u32(0), ...u16(0), ...u16(0), ...u32(fixedPitch ? 1 : 0)];
}

/** A minimal sfnt holding just the tables the reader looks at. */
function buildFont(tables: Record<string, number[]>): Uint8Array {
	const tags = Object.keys(tables);
	const headerLength = 12 + tags.length * 16;
	const directory: number[] = [];
	const body: number[] = [];
	for (const tag of tags) {
		const data = tables[tag];
		directory.push(...[...tag].map((char) => char.charCodeAt(0)), ...u32(0), ...u32(headerLength + body.length), ...u32(data.length));
		body.push(...data);
		while (body.length % 4) body.push(0);
	}
	return new Uint8Array([...u32(0x00010000), ...u16(tags.length), 0, 0, 0, 0, 0, 0, ...directory, ...body]);
}

describe("readFontInfos", () => {
	test("prefers the typographic family and picks up the Simplified Chinese name", async () => {
		const font = buildFont({
			name: nameTable([
				{ platform: 3, encoding: 1, language: 0x0409, nameId: 1, value: "Neko Sans Light" },
				{ platform: 3, encoding: 1, language: 0x0409, nameId: 16, value: "Neko Sans" },
				{ platform: 3, encoding: 1, language: 0x0404, nameId: 16, value: "貓貓黑體" },
				{ platform: 3, encoding: 1, language: 0x0804, nameId: 16, value: "猫猫黑体" },
			]),
			"OS/2": os2Table({ codePages: 1 << 18, monoPanose: false }),
			post: postTable(false),
		});
		const [info] = await readFontInfos(bufferReader(font));
		expect(info).toEqual({ family: "Neko Sans", localizedFamily: "猫猫黑体", chinese: true, monospace: false });
		expect(fontDisplayName(info)).toBe("猫猫黑体");
	});

	test("detects monospace from the post table or the panose proportion", async () => {
		const name = nameTable([{ platform: 3, encoding: 1, language: 0x0409, nameId: 1, value: "Neko Mono" }]);
		const viaPost = buildFont({ name, post: postTable(true) });
		const viaPanose = buildFont({ name, "OS/2": os2Table({ codePages: 1, monoPanose: true }) });
		expect((await readFontInfos(bufferReader(viaPost)))[0]).toEqual({ family: "Neko Mono", chinese: false, monospace: true });
		expect((await readFontInfos(bufferReader(viaPanose)))[0].monospace).toBe(true);
	});

	test("reads every face of a collection", async () => {
		const faceA = buildFont({ name: nameTable([{ platform: 3, encoding: 1, language: 0x0409, nameId: 1, value: "A" }]) });
		const faceB = buildFont({ name: nameTable([{ platform: 3, encoding: 1, language: 0x0409, nameId: 1, value: "B" }]) });
		// Collection: header + 2 offsets, then each face with its table offsets shifted.
		const relocate = (face: Uint8Array, base: number) => {
			const copy = face.slice();
			const view = new DataView(copy.buffer);
			const count = view.getUint16(4);
			for (let index = 0; index < count; index++) view.setUint32(12 + index * 16 + 8, view.getUint32(12 + index * 16 + 8) + base);
			return copy;
		};
		const headerLength = 12 + 8;
		const bOffset = headerLength + faceA.length;
		const ttc = new Uint8Array([
			...[..."ttcf"].map((char) => char.charCodeAt(0)),
			...u32(0x00010000),
			...u32(2),
			...u32(headerLength),
			...u32(bOffset),
			...relocate(faceA, headerLength),
			...relocate(faceB, bOffset),
		]);
		expect((await readFontInfos(bufferReader(ttc))).map((info) => info.family)).toEqual(["A", "B"]);
	});

	test("returns nothing for files that are not sfnt fonts", async () => {
		expect(await readFontInfos(bufferReader(new TextEncoder().encode("wOF2 definitely not a ttf")))).toEqual([]);
	});
});

describe("mergeFontFamilies", () => {
	test("collapses faces of one family and keeps any Chinese name", () => {
		expect(
			mergeFontFamilies([
				{ family: "SimSun", chinese: true, monospace: false },
				{ family: "simsun", localizedFamily: "宋体", chinese: false, monospace: true },
			]),
		).toEqual([{ family: "SimSun", localizedFamily: "宋体", chinese: true, monospace: true }]);
	});
});
