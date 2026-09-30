// Adapted from oh-my-pi (MIT, © Mario Zechner, Can Bölük, Stencil Labs):
// packages/coding-agent/src/tools/sqlite-reader.ts. Ported from bun:sqlite to
// node:sqlite, read side only.
import { open } from "node:fs/promises";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { textWidth, truncateToWidth } from "./text-width";

/**
 * Reading a SQLite database through the `read` tool.
 *
 * The path addresses what to show — `app.db` lists tables, `app.db:users`
 * shows a table's schema and a few rows, `app.db:users:42` one row by key,
 * `app.db:users?limit=20&offset=40&order=id:desc&where=…` a page, and
 * `app.db?q=SELECT …` a raw query. The connection is query-only, so nothing
 * the model writes in a selector can change the database.
 */

const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "latin1");

export function looksLikeSqlite(bytes: Uint8Array): boolean {
	if (bytes.byteLength < SQLITE_MAGIC.byteLength) return false;
	for (let index = 0; index < SQLITE_MAGIC.byteLength; index++) {
		if (bytes[index] !== SQLITE_MAGIC[index]) return false;
	}
	return true;
}

export async function isSqliteFile(absolutePath: string): Promise<boolean> {
	try {
		const handle = await open(absolutePath, "r");
		try {
			const head = Buffer.alloc(SQLITE_MAGIC.byteLength);
			await handle.read(head, 0, head.byteLength, 0);
			return looksLikeSqlite(head);
		} finally {
			await handle.close();
		}
	} catch {
		return false;
	}
}

/**
 * Open for reading only. A WAL database whose `-wal`/`-shm` sidecars are
 * missing cannot be opened read-only, so that case falls back to a normal
 * connection pinned by `query_only` — it creates the sidecars and nothing else.
 */
export function openSqliteReadConnection(filePath: string): DatabaseSync {
	let db: DatabaseSync | undefined;
	try {
		db = new DatabaseSync(filePath, { readOnly: true });
		db.prepare("SELECT name FROM sqlite_master LIMIT 1").get();
	} catch {
		db?.close();
		db = new DatabaseSync(filePath);
	}
	try {
		db.exec("PRAGMA query_only = ON");
		db.exec("PRAGMA busy_timeout = 3000");
		db.prepare("SELECT name FROM sqlite_master LIMIT 1").get();
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}

const SQLITE_PATH_PATTERN = /\.(?:sqlite3?|db3?)(?=(?::|\?|$))/gi;
const DEFAULT_QUERY_LIMIT = 20;
const DEFAULT_SCHEMA_SAMPLE_LIMIT = 5;
const MAX_QUERY_LIMIT = 500;
/** Row cap for raw `?q=` SQL — protects against `SELECT *` on multi-million-row tables. */
export const MAX_RAW_QUERY_ROWS = 1000;
const MAX_RENDER_WIDTH = 120;
const MAX_COLUMN_WIDTH = 40;
/** Narrower than this and every cell collapses to a lone ellipsis. */
const MIN_COLUMN_WIDTH = 3;
const COLUMN_SEPARATOR_WIDTH = 3;
const TABLE_FRAME_WIDTH = 1;
/**
 * Upper bound on rows scanned when counting a table for the listing. SQLite
 * keeps no row count, so `COUNT(*)` is a full scan — seconds on a large file,
 * run synchronously on the main process. Large tables use the planner's
 * `sqlite_stat1` estimate instead.
 */
const ROW_COUNT_PROBE_CAP = 50_000;

type SqliteRow = Record<string, unknown>;

interface SqliteMasterRow {
	name: string;
	sql: string | null;
}

interface SqliteTableInfoRow {
	cid: number;
	name: string;
	type: string;
	notnull: number;
	dflt_value: unknown;
	pk: number;
}

export interface SqlitePathCandidate {
	sqlitePath: string;
	subPath: string;
	queryString: string;
}

export type SqliteSelector =
	| { kind: "list" }
	| { kind: "schema"; table: string; sampleLimit: number }
	| { kind: "row"; table: string; key: string }
	| { kind: "query"; table: string; limit: number; offset: number; order?: string; where?: string }
	| { kind: "raw"; sql: string };

export type SqliteRowLookup = { kind: "pk"; column: string; type: string } | { kind: "rowid" };

export type TableRowCount =
	| { kind: "exact"; rows: number }
	| { kind: "estimate"; rows: number }
	| { kind: "atLeast"; rows: number };

export interface SqliteTableSummary {
	name: string;
	count: TableRowCount;
}

function rowsOf(statement: StatementSync, ...params: SQLInputValue[]): SqliteRow[] {
	return statement.all(...params) as SqliteRow[];
}

function rowOf(statement: StatementSync, ...params: SQLInputValue[]): SqliteRow | undefined {
	return statement.get(...params) as SqliteRow | undefined;
}

function splitSqliteRemainder(remainder: string): { subPath: string; queryString: string } {
	const queryIndex = remainder.indexOf("?");
	if (queryIndex === -1) return { subPath: remainder.replace(/^:+/, ""), queryString: "" };
	return {
		subPath: remainder.slice(0, queryIndex).replace(/^:+/, ""),
		queryString: remainder.slice(queryIndex + 1),
	};
}

function quoteSqliteIdentifier(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

function sanitizeCell(value: string): string {
	return value.replaceAll("\t", "    ").replaceAll(/\r?\n/g, "\\n");
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function stringifySqliteValue(value: unknown): string {
	if (value === null) return "NULL";
	if (value === undefined) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
	if (value instanceof Uint8Array) return `<BLOB ${formatBytes(value.byteLength)}>`;
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

function padCell(value: string, width: number): string {
	const truncated = truncateToWidth(sanitizeCell(value), Math.max(width, MIN_COLUMN_WIDTH));
	const visible = textWidth(truncated);
	return visible >= width ? truncated : `${truncated}${" ".repeat(width - visible)}`;
}

function tableFitsAtMinimum(columnCount: number): boolean {
	return MIN_COLUMN_WIDTH * columnCount + COLUMN_SEPARATOR_WIDTH * columnCount + TABLE_FRAME_WIDTH <= MAX_RENDER_WIDTH;
}

/** Too many columns for a table: one `column: value` block per row, like psql's expanded mode. */
function buildVerticalBlocks(columns: string[], rows: SqliteRow[]): string {
	if (rows.length === 0) return "(no rows)";
	let nameWidth = MIN_COLUMN_WIDTH;
	for (const column of columns) nameWidth = Math.max(nameWidth, textWidth(sanitizeCell(column)));
	nameWidth = Math.min(MAX_COLUMN_WIDTH, nameWidth);
	return rows
		.map((row, index) => {
			const block = [`── Row ${index + 1} ──`];
			for (const column of columns) {
				const value = sanitizeCell(stringifySqliteValue(row[column]));
				block.push(truncateToWidth(`${padCell(column, nameWidth)}: ${value}`, MAX_RENDER_WIDTH));
			}
			return block.join("\n");
		})
		.join("\n\n");
}

function buildAsciiTable(columns: string[], rows: SqliteRow[]): string {
	if (columns.length === 0) return rows.length === 0 ? "(no rows)" : "(rows returned without named columns)";
	if (!tableFitsAtMinimum(columns.length)) return buildVerticalBlocks(columns, rows);

	const widths = columns.map((column) =>
		Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, textWidth(sanitizeCell(column)))),
	);
	for (const row of rows) {
		columns.forEach((column, index) => {
			const cellWidth = textWidth(sanitizeCell(stringifySqliteValue(row[column])));
			widths[index] = Math.max(widths[index] ?? MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, cellWidth));
		});
	}

	const overhead = columns.length * COLUMN_SEPARATOR_WIDTH + TABLE_FRAME_WIDTH;
	const total = () => widths.reduce((sum, width) => sum + width, 0) + overhead;
	while (total() > MAX_RENDER_WIDTH) {
		let widest = -1;
		let widestWidth = MIN_COLUMN_WIDTH;
		widths.forEach((width, index) => {
			if (width > widestWidth) {
				widest = index;
				widestWidth = width;
			}
		});
		if (widest === -1) break;
		widths[widest] = Math.max(MIN_COLUMN_WIDTH, widths[widest] - 1);
	}

	const header = `| ${columns.map((column, index) => padCell(column, widths[index])).join(" | ")} |`;
	const divider = `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`;
	const lines = [header, divider];
	if (rows.length === 0) lines.push("(no rows)");
	for (const row of rows) {
		lines.push(`| ${columns.map((column, index) => padCell(stringifySqliteValue(row[column]), widths[index])).join(" | ")} |`);
	}
	return lines.map((line) => truncateToWidth(line, MAX_RENDER_WIDTH)).join("\n");
}

function parseLimit(value: string | null, fallback: number): number {
	if (value === null || value.trim().length === 0) return fallback;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`SQLite limit must be a positive integer; got '${value}'`);
	return Math.min(parsed, MAX_QUERY_LIMIT);
}

function parseOffset(value: string | null): number {
	if (value === null || value.trim().length === 0) return 0;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`SQLite offset must be a non-negative integer; got '${value}'`);
	return parsed;
}

function getTableMasterRow(db: DatabaseSync, table: string): SqliteMasterRow {
	const row = rowOf(
		db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name = ?"),
		table,
	) as SqliteMasterRow | undefined;
	if (!row) throw new Error(`SQLite table '${table}' not found`);
	return row;
}

function getTableInfoRows(db: DatabaseSync, table: string): SqliteTableInfoRow[] {
	getTableMasterRow(db, table);
	return rowsOf(db.prepare(`PRAGMA table_info(${quoteSqliteIdentifier(table)})`)) as unknown as SqliteTableInfoRow[];
}

function getTableColumns(db: DatabaseSync, table: string): string[] {
	return getTableInfoRows(db, table).map((column) => column.name);
}

function getPrimaryKeyColumns(db: DatabaseSync, table: string): SqliteTableInfoRow[] {
	return getTableInfoRows(db, table)
		.filter((column) => column.pk > 0)
		.sort((left, right) => left.pk - right.pk);
}

function coerceIntegerKey(key: string, label: string): number | bigint {
	const trimmed = key.trim();
	if (!/^-?\d+$/.test(trimmed)) throw new Error(`${label} must be an integer; got '${key}'`);
	const asNumber = Number.parseInt(trimmed, 10);
	return Number.isSafeInteger(asNumber) ? asNumber : BigInt(trimmed);
}

function coerceLookupValue(key: string, type: string): SQLInputValue {
	const normalizedType = type.trim().toUpperCase();
	if (normalizedType.includes("INT")) return coerceIntegerKey(key, `Primary key '${key}'`);
	if (normalizedType.includes("REAL") || normalizedType.includes("FLOA") || normalizedType.includes("DOUB")) {
		const parsed = Number(key);
		if (Number.isFinite(parsed)) return parsed;
	}
	return key;
}

function resolveOrderClause(order: string | undefined, columns: string[]): string {
	const trimmed = order?.trim();
	if (!trimmed) return "";
	const separatorIndex = trimmed.lastIndexOf(":");
	const column = separatorIndex === -1 ? trimmed : trimmed.slice(0, separatorIndex);
	const direction = separatorIndex === -1 ? "asc" : trimmed.slice(separatorIndex + 1).trim().toLowerCase();
	if (!columns.includes(column)) throw new Error(`SQLite order column '${column}' not found in table schema`);
	if (direction !== "asc" && direction !== "desc")
		throw new Error(`SQLite order direction must be 'asc' or 'desc'; got '${direction}'`);
	return ` ORDER BY ${quoteSqliteIdentifier(column)} ${direction.toUpperCase()}`;
}

const FORBIDDEN_WHERE_KEYWORDS = new Set(["limit", "offset", "union", "intersect", "except", "attach", "detach", "pragma"]);
const COMMENT_OR_TERMINATOR_ERROR =
	"SQLite 'where' clause must not contain comments, statement terminators or parameters; use '?q=SELECT ...' for raw SQL";
const FORBIDDEN_KEYWORD_ERROR =
	"SQLite 'where' clause must not contain LIMIT/OFFSET/UNION/INTERSECT/EXCEPT/ATTACH/DETACH/PRAGMA; use '?q=SELECT ...' for raw SQL";

/**
 * Reject SQL control syntax in a `where=` clause — outside string literals —
 * that would let it escape the bound `LIMIT ? OFFSET ?` pagination. Raw SQL
 * stays available through `?q=`.
 */
function findWhereClauseViolation(sql: string): string | null {
	let inSingleQuote = false;
	let inDoubleQuote = false;
	let tokenStart = -1;
	let keywordViolation: string | null = null;
	const flushToken = (end: number): void => {
		if (tokenStart >= 0 && !keywordViolation && FORBIDDEN_WHERE_KEYWORDS.has(sql.slice(tokenStart, end).toLowerCase()))
			keywordViolation = FORBIDDEN_KEYWORD_ERROR;
		tokenStart = -1;
	};
	for (let index = 0; index <= sql.length; index++) {
		const char = index < sql.length ? sql[index] : undefined;
		const next = sql[index + 1];
		if (inSingleQuote) {
			if (char === "'" && next === "'") index += 1;
			else if (char === "'") inSingleQuote = false;
			continue;
		}
		if (inDoubleQuote) {
			if (char === '"' && next === '"') index += 1;
			else if (char === '"') inDoubleQuote = false;
			continue;
		}
		if (char !== undefined && /[A-Za-z0-9_]/.test(char)) {
			if (tokenStart < 0) tokenStart = index;
			continue;
		}
		flushToken(index);
		if (char === undefined) break;
		if (char === "'") inSingleQuote = true;
		else if (char === '"') inDoubleQuote = true;
		// A bound parameter would shift the pagination values; node:sqlite has no
		// parameter count to check afterwards, so it is refused up front.
		else if (char === ";" || char === "?" || char === "$" || char === "@") return COMMENT_OR_TERMINATOR_ERROR;
		else if ((char === "-" && next === "-") || (char === "/" && next === "*") || (char === "*" && next === "/"))
			return COMMENT_OR_TERMINATOR_ERROR;
	}
	return keywordViolation;
}

function validateWhereClause(where: string | undefined): string | undefined {
	const trimmed = where?.trim();
	if (!trimmed) return undefined;
	const violation = findWhereClauseViolation(trimmed);
	if (violation) throw new Error(violation);
	return trimmed;
}

/** Every way `path` could split into a database file and a selector, longest file first. */
export function parseSqlitePathCandidates(filePath: string): SqlitePathCandidate[] {
	const normalized = filePath.replace(/\\/g, "/");
	const seen = new Set<string>();
	const candidates: SqlitePathCandidate[] = [];
	for (const match of normalized.matchAll(SQLITE_PATH_PATTERN)) {
		const end = match.index + match[0].length;
		const sqlitePath = filePath.slice(0, end);
		const { subPath, queryString } = splitSqliteRemainder(normalized.slice(end));
		const key = `${sqlitePath}\0${subPath}\0${queryString}`;
		if (seen.has(key)) continue;
		seen.add(key);
		candidates.push({ sqlitePath, subPath, queryString });
	}
	return candidates.sort((left, right) => right.sqlitePath.length - left.sqlitePath.length);
}

export function parseSqliteSelector(subPath: string, queryString: string): SqliteSelector {
	const normalizedSubPath = subPath.replace(/^:+/, "").trim();
	const params = new URLSearchParams(queryString);
	const rawQuery = params.get("q");
	if (rawQuery !== null) {
		const otherKeys = [...params.keys()].filter((key) => key !== "q");
		if (normalizedSubPath || otherKeys.length > 0)
			throw new Error("SQLite raw queries cannot be combined with table selectors or pagination");
		if (!rawQuery.trim()) throw new Error("SQLite query parameter 'q' cannot be empty");
		return { kind: "raw", sql: rawQuery };
	}
	if (!normalizedSubPath) {
		if (params.size > 0) throw new Error("SQLite query parameters require a table selector or q=SELECT...");
		return { kind: "list" };
	}
	const separatorIndex = normalizedSubPath.indexOf(":");
	const table = separatorIndex === -1 ? normalizedSubPath : normalizedSubPath.slice(0, separatorIndex);
	const key = separatorIndex === -1 ? undefined : normalizedSubPath.slice(separatorIndex + 1);
	if (!table) throw new Error("SQLite selectors must include a table name");
	if (key !== undefined && key.length > 0) {
		if (params.size > 0) throw new Error("SQLite row lookups cannot be combined with query parameters");
		return { kind: "row", table, key };
	}
	const where = validateWhereClause(params.get("where") ?? undefined);
	const order = params.get("order")?.trim() || undefined;
	const known = new Set(["limit", "offset", "order", "where"]);
	for (const name of params.keys()) {
		if (!known.has(name)) throw new Error(`Unsupported SQLite query parameter '${name}'`);
	}
	if (params.has("limit") || params.has("offset") || order !== undefined || where !== undefined) {
		return {
			kind: "query",
			table,
			limit: parseLimit(params.get("limit"), DEFAULT_QUERY_LIMIT),
			offset: parseOffset(params.get("offset")),
			order,
			where,
		};
	}
	return { kind: "schema", table, sampleLimit: DEFAULT_SCHEMA_SAMPLE_LIMIT };
}

/** The planner's per-table row estimate from `sqlite_stat1`, when the file was ever analyzed. */
function loadRowEstimates(db: DatabaseSync): Map<string, number> {
	const estimates = new Map<string, number>();
	const hasStat1 = rowOf(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'"));
	if (!hasStat1) return estimates;
	for (const { tbl, stat } of rowsOf(db.prepare("SELECT tbl, stat FROM sqlite_stat1")) as { tbl: string; stat: string | null }[]) {
		const rows = stat ? Number.parseInt(stat, 10) : Number.NaN;
		if (!Number.isFinite(rows)) continue;
		const previous = estimates.get(tbl);
		if (previous === undefined || rows > previous) estimates.set(tbl, rows);
	}
	return estimates;
}

/** Count a table while reading at most `cap + 1` rows. */
function probeRowCount(db: DatabaseSync, table: string, cap: number): TableRowCount {
	const counted = Number(
		rowOf(db.prepare(`SELECT COUNT(*) AS count FROM (SELECT 1 FROM ${quoteSqliteIdentifier(table)} LIMIT ${cap + 1})`))?.count ?? 0,
	);
	return counted > cap ? { kind: "atLeast", rows: cap } : { kind: "exact", rows: counted };
}

export function listTables(db: DatabaseSync, options: { probeCap?: number } = {}): SqliteTableSummary[] {
	const cap = options.probeCap ?? ROW_COUNT_PROBE_CAP;
	const names = rowsOf(
		db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name COLLATE NOCASE"),
	) as { name: string }[];
	const estimates = loadRowEstimates(db);
	return names.map(({ name }) => {
		const estimate = estimates.get(name);
		const count: TableRowCount =
			estimate !== undefined && estimate > cap ? { kind: "estimate", rows: estimate } : probeRowCount(db, name, cap);
		return { name, count };
	});
}

export function getTableSchema(db: DatabaseSync, table: string): string {
	const row = getTableMasterRow(db, table);
	if (!row.sql) throw new Error(`SQLite schema for table '${table}' is unavailable`);
	return row.sql;
}

export function resolveTableRowLookup(db: DatabaseSync, table: string): SqliteRowLookup {
	const primaryKeyColumns = getPrimaryKeyColumns(db, table);
	if (primaryKeyColumns.length === 1) return { kind: "pk", column: primaryKeyColumns[0].name, type: primaryKeyColumns[0].type };
	if (primaryKeyColumns.length > 1) throw new Error(`SQLite table '${table}' has a composite primary key; use '?where=' instead`);
	if (/\bWITHOUT\s+ROWID\b/i.test(getTableSchema(db, table)))
		throw new Error(`SQLite table '${table}' does not expose ROWID; use '?where=' instead`);
	return { kind: "rowid" };
}

export function queryRows(
	db: DatabaseSync,
	table: string,
	options: { limit: number; offset: number; order?: string; where?: string },
): { columns: string[]; rows: SqliteRow[]; totalCount: number } {
	const columns = getTableColumns(db, table);
	const where = validateWhereClause(options.where);
	const whereClause = where ? ` WHERE ${where}` : "";
	const orderClause = resolveOrderClause(options.order, columns);
	const totalCount = Number(rowOf(db.prepare(`SELECT COUNT(*) AS count FROM ${quoteSqliteIdentifier(table)}${whereClause}`))?.count ?? 0);
	const rows = rowsOf(
		db.prepare(`SELECT * FROM ${quoteSqliteIdentifier(table)}${whereClause}${orderClause} LIMIT ? OFFSET ?`),
		options.limit,
		options.offset,
	);
	return { columns, rows, totalCount };
}

export function getRowByKey(db: DatabaseSync, table: string, pk: { column: string; type?: string }, key: string): SqliteRow | null {
	getTableMasterRow(db, table);
	const sql = `SELECT * FROM ${quoteSqliteIdentifier(table)} WHERE ${quoteSqliteIdentifier(pk.column)} = ? LIMIT 1`;
	return rowOf(db.prepare(sql), coerceLookupValue(key, pk.type ?? "")) ?? null;
}

export function getRowByRowId(db: DatabaseSync, table: string, key: string): SqliteRow | null {
	getTableMasterRow(db, table);
	const sql = `SELECT * FROM ${quoteSqliteIdentifier(table)} WHERE rowid = ? LIMIT 1`;
	return rowOf(db.prepare(sql), coerceIntegerKey(key, "SQLite ROWID")) ?? null;
}

export function executeReadQuery(db: DatabaseSync, sql: string): { columns: string[]; rows: SqliteRow[]; truncated: boolean } {
	const statement = db.prepare(sql);
	const columns = statement.columns().map((column) => column.name);
	const rows: SqliteRow[] = [];
	let truncated = false;
	for (const row of statement.iterate()) {
		if (rows.length >= MAX_RAW_QUERY_ROWS) {
			truncated = true;
			break;
		}
		rows.push(row as SqliteRow);
	}
	return { columns, rows, truncated };
}

function formatRowCount(count: TableRowCount): string {
	switch (count.kind) {
		case "exact":
			return `${count.rows} rows`;
		case "estimate":
			return `~${count.rows} rows`;
		case "atLeast":
			return `${count.rows}+ rows`;
	}
}

export function renderTableList(tables: SqliteTableSummary[]): string {
	if (tables.length === 0) return "(no tables)";
	return tables.map((table) => truncateToWidth(`${table.name} (${formatRowCount(table.count)})`, MAX_RENDER_WIDTH)).join("\n");
}

export function renderSchema(createSql: string, sample: { columns: string[]; rows: SqliteRow[] }): string {
	const schema = createSql
		.replaceAll("\t", "    ")
		.split("\n")
		.map((line) => truncateToWidth(line, MAX_RENDER_WIDTH))
		.join("\n");
	return [schema, "", "Sample rows:", buildAsciiTable(sample.columns, sample.rows)].join("\n");
}

export function renderRow(row: SqliteRow): string {
	const entries = Object.entries(row);
	if (entries.length === 0) return "(no columns)";
	return entries
		.map(([column, value]) => truncateToWidth(sanitizeCell(`${column}: ${stringifySqliteValue(value)}`), MAX_RENDER_WIDTH))
		.join("\n");
}

export function renderTable(
	columns: string[],
	rows: SqliteRow[],
	meta: { totalCount: number; offset: number; limit: number; table: string },
): string {
	const parts = [buildAsciiTable(columns, rows)];
	const shown = Math.min(meta.totalCount, meta.offset + rows.length);
	if (shown < meta.totalCount) {
		const next = meta.offset + rows.length;
		parts.push(
			`[${meta.totalCount - shown} more rows; append :${meta.table}?limit=${meta.limit}&offset=${next} to the database path to continue]`,
		);
	}
	return parts.join("\n");
}

/** Render whatever `subPath`/`queryString` select from the database at `absolutePath`. */
export function readSqlite(absolutePath: string, subPath: string, queryString: string): string {
	const selector = parseSqliteSelector(subPath, queryString);
	const db = openSqliteReadConnection(absolutePath);
	try {
		switch (selector.kind) {
			case "list": {
				const tables = listTables(db);
				const shown = tables.slice(0, 500);
				const more = tables.length - shown.length;
				return [
					`SQLite database — ${tables.length} tables. Read <db>:<table> for schema and sample rows.`,
					renderTableList(shown),
					...(more > 0 ? [`[${more} more tables]`] : []),
				].join("\n");
			}
			case "schema": {
				const sample = queryRows(db, selector.table, { limit: selector.sampleLimit, offset: 0 });
				let output = renderSchema(getTableSchema(db, selector.table), sample);
				if (sample.rows.length < sample.totalCount) {
					output += `\n[${sample.totalCount - sample.rows.length} more rows; append :${selector.table}?limit=20&offset=${sample.rows.length} to the database path to continue]`;
				}
				return output;
			}
			case "row": {
				const lookup = resolveTableRowLookup(db, selector.table);
				const row =
					lookup.kind === "pk"
						? getRowByKey(db, selector.table, lookup, selector.key)
						: getRowByRowId(db, selector.table, selector.key);
				return row ? renderRow(row) : `No row found in table '${selector.table}' for key '${selector.key}'.`;
			}
			case "query": {
				const page = queryRows(db, selector.table, selector);
				return renderTable(page.columns, page.rows, {
					totalCount: page.totalCount,
					offset: selector.offset,
					limit: selector.limit,
					table: selector.table,
				});
			}
			case "raw": {
				const result = executeReadQuery(db, selector.sql);
				let output = buildAsciiTable(result.columns, result.rows);
				if (result.truncated)
					output += `\n[Output capped at ${MAX_RAW_QUERY_ROWS} rows; add a LIMIT/OFFSET clause to the query to page through more]`;
				return output;
			}
		}
	} finally {
		db.close();
	}
}
