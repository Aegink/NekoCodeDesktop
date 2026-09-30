import type { SessionSummary } from "../../../shared/agent";

/** A session being carried to the chat area: from the sidebar, or a pane's grip. */
export type DraggedSession = Pick<SessionSummary, "id" | "cwd" | "sessionFile">;

export const SESSION_DRAG_TYPE = "application/x-nekocode-session";

/**
 * The session in flight. `dataTransfer` can only be read on drop, but the snap
 * preview has to know during `dragover` whether the session is already on screen.
 */
let current: DraggedSession | null = null;

export function draggedSession(): DraggedSession | null {
	return current;
}

export function isSessionDrag(event: React.DragEvent | DragEvent): boolean {
	return current !== null && (event.dataTransfer?.types.includes(SESSION_DRAG_TYPE) ?? false);
}

/**
 * Start carrying a session, with a small title card as the drag image rather
 * than a ghost of whatever row it was picked up from.
 */
export function startSessionDrag(event: React.DragEvent, session: DraggedSession, title: string): void {
	current = { id: session.id, cwd: session.cwd, sessionFile: session.sessionFile };
	event.dataTransfer.effectAllowed = "move";
	event.dataTransfer.setData(SESSION_DRAG_TYPE, JSON.stringify(current));
	const card = document.createElement("div");
	card.className = "split-drag-card";
	card.textContent = title;
	document.body.appendChild(card);
	event.dataTransfer.setDragImage(card, 14, 14);
	// The image is captured synchronously; the element is only needed for this tick.
	requestAnimationFrame(() => card.remove());
	window.addEventListener("dragend", endSessionDrag, { once: true });
}

export function endSessionDrag(): void {
	current = null;
}
