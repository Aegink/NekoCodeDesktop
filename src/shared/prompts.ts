/**
 * Which system prompt a session is built on: NekoCode's default one, or a
 * prompt the user wrote. The default prompt's text never leaves main — the
 * settings page only knows that it exists.
 *
 * A custom prompt stands in for the default role, rules and mode/phase
 * guidance. What the runtime generates — mode, permission, tool list and tool
 * guidance — is still appended, so permissions and tools stay accurate. The
 * internal helpers (Fusion, Fast Context, background tasks, commit messages,
 * compaction) always use the default prompts.
 */
export interface CustomPrompt {
	id: string;
	name: string;
	content: string;
	createdAt: number;
	updatedAt: number;
}

export interface PromptsSnapshot {
	/** The custom prompt in use, or null for the default prompt. */
	activeId: string | null;
	prompts: CustomPrompt[];
}

/** No `id` adds a prompt; `activate` also puts it in use. */
export interface SavePromptRequest {
	id?: string;
	name: string;
	content: string;
	activate?: boolean;
}

export const MAX_PROMPT_NAME_LENGTH = 80;
export const MAX_PROMPT_LENGTH = 100_000;
export const MAX_CUSTOM_PROMPTS = 50;

/** Filled in by the runtime wherever a custom prompt writes it. */
export const PROMPT_PLACEHOLDERS = ["{{MODEL_ID}}"] as const;
