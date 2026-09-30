import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { detectSpecialRead, renderDocument, renderSpecialRead } from "./read-formats";
import { pageText } from "./read-tool";

/** A stored (uncompressed) zip; readZip does not check CRCs, so they are left zero. */
function makeZip(files: Record<string, string>): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const [name, text] of Object.entries(files)) {
		const nameBytes = Buffer.from(name);
		const data = Buffer.from(text);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(0x800, 8);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(nameBytes.length, 28);
		central.writeUInt32LE(offset, 42);
		locals.push(local, nameBytes, data);
		centrals.push(central, nameBytes);
		offset += 30 + nameBytes.length + data.length;
	}
	const directory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(Object.keys(files).length, 8);
	end.writeUInt16LE(Object.keys(files).length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, directory, end]);
}

function makeTar(files: Record<string, string>): Buffer {
	const blocks: Buffer[] = [];
	for (const [name, text] of Object.entries(files)) {
		const data = Buffer.from(text);
		const header = Buffer.alloc(512);
		header.write(name, 0);
		header.write(data.length.toString(8).padStart(11, "0"), 124);
		header.write("0", 156);
		header.write("ustar", 257);
		blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
	}
	return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

const MINIMAL_PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R 6 0 R]/Count 2>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 24 Tf 72 72 Td (Hello PDF) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
6 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]>>endobj
trailer<</Root 1 0 R>>
%%EOF`;

let dir: string;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "neko-read-"));
	const db = new DatabaseSync(join(dir, "app.db"));
	db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, score REAL)");
	const insert = db.prepare("INSERT INTO users (name, score) VALUES (?, ?)");
	for (let i = 1; i <= 30; i++) insert.run(`user${i}`, i / 2);
	db.close();
	writeFileSync(join(dir, "bundle.zip"), makeZip({ "src/a.txt": "alpha\nbeta", "bin/x.dat": "\0\0\0binary", "src/": "" }));
	writeFileSync(join(dir, "pkg.tar"), makeTar({ "package/index.js": "module.exports = 1;" }));
	writeFileSync(join(dir, "doc.pdf"), MINIMAL_PDF);
	writeFileSync(join(dir, "plain.txt"), "just text");
});

afterAll(() => {
	// Bun's node:sqlite keeps the file locked until closed statements are
	// collected (Electron's Node releases them on close); Windows then refuses
	// to delete the directory.
	Bun.gc(true);
	rmSync(dir, { recursive: true, force: true });
});

describe("sqlite", () => {
	test("the database lists its tables with row counts", async () => {
		const target = await detectSpecialRead("app.db", dir);
		expect(target?.kind).toBe("sqlite");
		const text = await renderSpecialRead(target!);
		expect(text).toContain("users (30 rows)");
	});

	test("a table shows schema and sample rows, a key one row, a query a page", async () => {
		expect(await renderSpecialRead((await detectSpecialRead("app.db:users", dir))!)).toContain("CREATE TABLE users");
		expect(await renderSpecialRead((await detectSpecialRead("app.db:users:7", dir))!)).toContain("name: user7");
		const page = await renderSpecialRead((await detectSpecialRead("app.db:users?limit=5&offset=10&order=id:desc", dir))!);
		expect(page).toContain("user20");
		expect(page).toContain("[15 more rows");
	});

	test("raw SQL keeps its slashes, and the connection cannot write", async () => {
		const target = await detectSpecialRead("app.db?q=SELECT score/2 AS half FROM users WHERE id = 4", dir);
		expect(target).toMatchObject({ kind: "sqlite", queryString: "q=SELECT score/2 AS half FROM users WHERE id = 4" });
		expect(await renderSpecialRead(target!)).toContain("1");
		const write = await detectSpecialRead("app.db?q=DELETE FROM users", dir);
		await expect(renderSpecialRead(write!)).rejects.toThrow();
	});

	test("a where clause cannot smuggle in its own pagination or statements", async () => {
		await expect(
			renderSpecialRead((await detectSpecialRead("app.db:users?where=1=1; DROP TABLE users", dir))!),
		).rejects.toThrow(/terminators/);
	});
});

describe("archives", () => {
	test("a zip lists its files, and a member reads as text", async () => {
		const listing = await renderSpecialRead((await detectSpecialRead("bundle.zip", dir))!);
		expect(listing).toContain("src/a.txt");
		expect(listing).toContain("2 files");
		expect(await renderSpecialRead((await detectSpecialRead("bundle.zip:src/a.txt", dir))!)).toBe("alpha\nbeta");
		expect(await renderSpecialRead((await detectSpecialRead("bundle.zip:bin/x.dat", dir))!)).toContain("Binary file");
		await expect(renderSpecialRead((await detectSpecialRead("bundle.zip:missing.txt", dir))!)).rejects.toThrow(/No entry/);
	});

	test("a tar member reads too", async () => {
		expect(await renderSpecialRead((await detectSpecialRead("pkg.tar:package/index.js", dir))!)).toBe("module.exports = 1;");
	});

	test("a path that is not a container reads as a plain file", async () => {
		expect(await detectSpecialRead("plain.txt", dir)).toBeNull();
		expect(await detectSpecialRead("nothing.zip:a", dir)).toBeNull();
	});
});

describe("documents", () => {
	test("a PDF reads page by page, and a page range narrows it", async () => {
		const all = await renderSpecialRead((await detectSpecialRead("doc.pdf", dir))!);
		expect(all).toContain("PDF — 2 pages");
		expect(all).toContain("Hello PDF");
		expect(all).toContain("No text layer on page 2");
		const one = await renderSpecialRead((await detectSpecialRead("doc.pdf:1", dir))!);
		expect(one).toContain("showing page 1");
		expect(one).not.toContain("## Page 2");
	});

	test("a notebook shows cells and their text outputs, not image data", async () => {
		const notebook = JSON.stringify({
			metadata: { kernelspec: { language: "python" } },
			cells: [
				{ cell_type: "markdown", source: ["# Title"] },
				{
					cell_type: "code",
					execution_count: 3,
					source: "print(1)",
					outputs: [{ output_type: "stream", text: ["1\n"] }, { output_type: "display_data", data: { "image/png": "AAAA" } }],
				},
			],
		});
		const text = await renderDocument("ipynb", Buffer.from(notebook));
		expect(text).toContain("python · 2 cells");
		expect(text).toContain("# %% [code] cell 2 · In [3]");
		expect(text).toContain("[image/png output]");
		expect(text).not.toContain("AAAA");
	});

	test("Word, Excel and PowerPoint come out as Markdown", async () => {
		const docx = makeZip({
			"word/document.xml":
				'<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Intro</w:t></w:r></w:p>' +
				"<w:p><w:r><w:t>Body &amp; soul</w:t></w:r></w:p>" +
				"<w:tbl><w:tr><w:tc><w:p><w:r><w:t>k</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>v</w:t></w:r></w:p></w:tc></w:tr></w:tbl>" +
				"</w:body></w:document>",
		});
		const word = await renderDocument("docx", docx);
		expect(word).toContain("## Intro");
		expect(word).toContain("Body & soul");
		expect(word).toContain("| k | v |");

		const xlsx = makeZip({
			"xl/workbook.xml": '<workbook><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
			"xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
			"xl/sharedStrings.xml": "<sst><si><t>name</t></si><si><t>neko</t></si></sst>",
			"xl/worksheets/sheet1.xml":
				'<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>age</t></is></c></row>' +
				'<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>3</v></c></row></sheetData></worksheet>',
		});
		const excel = await renderDocument("xlsx", xlsx);
		expect(excel).toContain("## Data");
		expect(excel).toContain("| name | age |");
		expect(excel).toContain("| neko | 3 |");

		const pptx = makeZip({
			"ppt/slides/slide2.xml": "<p:sld><a:p><a:r><a:t>Second</a:t></a:r></a:p></p:sld>",
			"ppt/slides/slide1.xml": "<p:sld><a:p><a:r><a:t>First</a:t></a:r></a:p></p:sld>",
		});
		const deck = await renderDocument("pptx", pptx);
		expect(deck.indexOf("First")).toBeLessThan(deck.indexOf("Second"));
		expect(deck).toContain("2 slides");
	});
});

describe("paging", () => {
	const pi = {
		truncateHead: (text: string) => ({ content: text, truncated: false, firstLineExceedsLimit: false, outputLines: text.split("\n").length }),
		formatSize: (bytes: number) => `${bytes}B`,
		DEFAULT_MAX_BYTES: 50_000,
	} as never;

	test("offset and limit page a rendering the way they page a file", () => {
		const text = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
		expect(pageText(pi, text, 3, 2)).toBe("line 3\nline 4\n\n[6 more lines. Use offset=5 to continue.]");
		expect(() => pageText(pi, text, 20, undefined)).toThrow(/beyond end/);
	});
});
