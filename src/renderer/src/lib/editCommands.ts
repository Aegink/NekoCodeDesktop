// Edit commands for right-click menus on text fields.
//
// On the desktop they run natively through webContents, so a menu paste is
// indistinguishable from Ctrl+V: the field's `paste` handler sees the real
// clipboard (images included) and the edit lands in its undo history. The
// WebUI has no such bridge and makes do with what the browser allows.

import { api } from "../api";
import type { EditCommand } from "../../../shared/window";
import { isMacNavigatorPlatform } from "./utils";

export type EditableField = HTMLTextAreaElement | HTMLInputElement;

export function hasSelection(field: EditableField): boolean {
	return field.selectionStart !== null && field.selectionStart !== field.selectionEnd;
}

/** Ctrl+X on Windows/Linux, ⌘X on macOS — for the menu's shortcut column. */
export function editShortcut(key: string, shift = false): string {
	return isMacNavigatorPlatform() ? `${shift ? "⇧" : ""}⌘${key}` : `Ctrl+${shift ? "Shift+" : ""}${key}`;
}

/** Redo is ⇧⌘Z on macOS but Ctrl+Y by Windows/Linux convention. */
export function redoShortcut(): string {
	return isMacNavigatorPlatform() ? editShortcut("Z", true) : editShortcut("Y");
}

/**
 * A browser paste can't fire a trusted `paste` event, so read the clipboard
 * and apply the same rule the field's paste handler does: text wins, and only
 * a clipboard holding nothing but images becomes attachments.
 */
async function browserPaste(field: EditableField, onImages?: (files: File[]) => void): Promise<void> {
	const clipboard = navigator.clipboard;
	if (!clipboard) return; // insecure context (plain-http WebUI): nothing readable
	if (typeof clipboard.read === "function") {
		const items = await clipboard.read();
		const text = items.find((item) => item.types.includes("text/plain"));
		if (text) {
			const value = await (await text.getType("text/plain")).text();
			insertText(field, value);
			return;
		}
		const images: File[] = [];
		for (const item of items) {
			const type = item.types.find((entry) => entry.startsWith("image/"));
			if (type) images.push(new File([await item.getType(type)], `image.${type.slice(6)}`, { type }));
		}
		if (images.length > 0) onImages?.(images);
		return;
	}
	insertText(field, await clipboard.readText());
}

function insertText(field: EditableField, value: string) {
	if (!value) return;
	// execCommand keeps the edit undoable and fires `input`, so a controlled
	// React field sees it like typing.
	if (!document.execCommand("insertText", false, value)) field.setRangeText(value, field.selectionStart ?? field.value.length, field.selectionEnd ?? field.value.length, "end");
}

export async function runEditCommand(
	command: EditCommand,
	field: EditableField,
	onImages?: (files: File[]) => void,
): Promise<void> {
	field.focus();
	if (api.runtime === "electron") {
		await api.editCommand(command);
		return;
	}
	if (command === "paste") {
		await browserPaste(field, onImages);
		return;
	}
	document.execCommand(command);
}
