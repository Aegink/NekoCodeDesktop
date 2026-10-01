import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	MAX_CUSTOM_PROMPTS,
	MAX_PROMPT_LENGTH,
	MAX_PROMPT_NAME_LENGTH,
	type CustomPrompt,
	type PromptsSnapshot,
	type SavePromptRequest,
} from "../shared/prompts";

interface StoredFile {
	version: 2;
	activeId: string | null;
	prompts: CustomPrompt[];
}

const FILE = "prompts.json";

function parsePrompt(value: unknown): CustomPrompt | null {
	const entry = value as Partial<CustomPrompt> | null;
	if (
		!entry ||
		typeof entry.id !== "string" ||
		!entry.id ||
		typeof entry.name !== "string" ||
		!entry.name.trim() ||
		typeof entry.content !== "string" ||
		!entry.content.trim()
	)
		return null;
	const createdAt = typeof entry.createdAt === "number" ? entry.createdAt : 0;
	return {
		id: entry.id,
		name: entry.name.slice(0, MAX_PROMPT_NAME_LENGTH),
		content: entry.content,
		createdAt,
		updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : createdAt,
	};
}

/**
 * The prompts the user wrote and which one is in use, in one file in app
 * data. The default prompt is not stored: it is the app's, and "in use" for
 * it is simply no custom prompt being active.
 */
export class PromptStore {
	private readonly path: string;
	private file: StoredFile | null = null;

	constructor(
		private readonly userDataDir: string,
		private readonly now: () => number = Date.now,
	) {
		this.path = join(userDataDir, FILE);
	}

	private load(): StoredFile {
		if (this.file) return this.file;
		let prompts: CustomPrompt[] = [];
		let activeId: string | null = null;
		if (existsSync(this.path)) {
			try {
				const parsed = JSON.parse(readFileSync(this.path, "utf8")) as Partial<StoredFile> | null;
				if (parsed?.version === 2 && Array.isArray(parsed.prompts)) {
					const seen = new Set<string>();
					for (const value of parsed.prompts) {
						const prompt = parsePrompt(value);
						if (prompt && !seen.has(prompt.id)) {
							seen.add(prompt.id);
							prompts.push(prompt);
						}
					}
					prompts = prompts.slice(0, MAX_CUSTOM_PROMPTS);
					// An active id that names nothing is the default prompt, not an error.
					if (typeof parsed.activeId === "string" && prompts.some((prompt) => prompt.id === parsed.activeId))
						activeId = parsed.activeId;
				}
			} catch {
				// Corrupt: the default prompt, and the next save replaces the file.
			}
		}
		this.file = { version: 2, activeId, prompts };
		return this.file;
	}

	snapshot(): PromptsSnapshot {
		const { activeId, prompts } = this.load();
		return { activeId, prompts: prompts.map((prompt) => ({ ...prompt })) };
	}

	/** The text sessions are built on, or null for the default prompt. Read on every prompt build. */
	activeContent(): string | null {
		const { activeId, prompts } = this.load();
		return prompts.find((prompt) => prompt.id === activeId)?.content ?? null;
	}

	save(request: SavePromptRequest): PromptsSnapshot {
		const name = typeof request?.name === "string" ? request.name.trim() : "";
		const content = typeof request?.content === "string" ? request.content.replace(/\r\n/g, "\n") : "";
		if (!name) throw new Error("请填写提示词名称");
		if (name.length > MAX_PROMPT_NAME_LENGTH) throw new Error(`名称过长（上限 ${MAX_PROMPT_NAME_LENGTH} 字符）`);
		if (!content.trim()) throw new Error("提示词内容不能为空");
		if (content.length > MAX_PROMPT_LENGTH) throw new Error(`提示词过长（上限 ${MAX_PROMPT_LENGTH} 字符）`);
		const current = this.load();
		const prompts = [...current.prompts];
		const at = this.now();
		let id: string;
		if (request.id) {
			const index = prompts.findIndex((prompt) => prompt.id === request.id);
			if (index === -1) throw new Error("该提示词已不存在");
			id = request.id;
			prompts[index] = { ...prompts[index], name, content, updatedAt: at };
		} else {
			if (prompts.length >= MAX_CUSTOM_PROMPTS) throw new Error(`最多保存 ${MAX_CUSTOM_PROMPTS} 条自定义提示词`);
			id = randomUUID();
			prompts.push({ id, name, content, createdAt: at, updatedAt: at });
		}
		this.persist({ version: 2, activeId: request.activate ? id : current.activeId, prompts });
		return this.snapshot();
	}

	/** Removing the prompt in use goes back to the default one. */
	remove(id: string): PromptsSnapshot {
		const current = this.load();
		this.persist({
			version: 2,
			activeId: current.activeId === id ? null : current.activeId,
			prompts: current.prompts.filter((prompt) => prompt.id !== id),
		});
		return this.snapshot();
	}

	/** `null` is the default prompt. */
	setActive(id: string | null): PromptsSnapshot {
		const current = this.load();
		if (id !== null && !current.prompts.some((prompt) => prompt.id === id)) throw new Error("该提示词已不存在");
		this.persist({ ...current, activeId: id });
		return this.snapshot();
	}

	private persist(next: StoredFile): void {
		mkdirSync(this.userDataDir, { recursive: true });
		const temporary = `${this.path}.tmp-${process.pid}`;
		try {
			writeFileSync(temporary, `${JSON.stringify(next, null, "\t")}\n`, { mode: 0o600 });
			renameSync(temporary, this.path);
		} catch (error) {
			rmSync(temporary, { force: true });
			throw error;
		}
		this.file = next;
	}
}
