import type { ChangedFile, RepoStatus } from "../../../../shared/git";

/** The one letter an explorer shows for a changed file, as VS Code does. */
export type GitLetter = "M" | "A" | "D" | "U" | "R" | "C";

export const GIT_STATUS_CLASS: Record<GitLetter, string> = {
	M: "text-[#d7a64a]",
	A: "text-[#73c991]",
	U: "text-[#73c991]",
	R: "text-[#4fc1ff]",
	D: "text-[#e5534b]",
	C: "text-[#e5534b]",
};

/** `git status --porcelain` renames read `old -> new`; the new side is the file. */
export function changedPath(file: ChangedFile): string {
	const arrow = file.path.indexOf(" -> ");
	return (arrow >= 0 ? file.path.slice(arrow + 4) : file.path).replace(/^"|"$/g, "");
}

export function gitLetter(status: string): GitLetter {
	if (status === "??") return "U";
	if (status.includes("U") || status === "AA" || status === "DD") return "C";
	if (status.includes("D")) return "D";
	if (status.includes("R")) return "R";
	if (status.includes("A")) return "A";
	return "M";
}

export interface GitDecorations {
	branch: string | null;
	isRepo: boolean;
	files: ChangedFile[];
	/** A file's letter, or for a folder the letter of something changed inside it. */
	status(relPath: string, isDir: boolean): GitLetter | null;
}

export function gitDecorations(repo: RepoStatus | null): GitDecorations {
	const byPath = new Map<string, GitLetter>();
	const byFolder = new Map<string, GitLetter>();
	for (const file of repo?.files ?? []) {
		const path = changedPath(file).replace(/\/$/, "");
		const letter = gitLetter(file.status);
		byPath.set(path, letter);
		for (let at = path.lastIndexOf("/"); at > 0; at = path.lastIndexOf("/", at - 1)) {
			const folder = path.slice(0, at);
			if (!byFolder.has(folder)) byFolder.set(folder, letter);
		}
	}
	return {
		branch: repo?.branch ?? null,
		isRepo: repo?.isRepo ?? false,
		files: repo?.files ?? [],
		status: (relPath, isDir) => (isDir ? (byFolder.get(relPath) ?? byPath.get(relPath) ?? null) : (byPath.get(relPath) ?? null)),
	};
}
