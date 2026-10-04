/**
 * Put text on the clipboard, falling back to a hidden selection where the
 * async clipboard is refused — a phone reaching the app over plain LAN http is
 * not a secure context, and `navigator.clipboard` is not there at all.
 */
export async function copyText(text: string): Promise<void> {
	if (navigator.clipboard && window.isSecureContext) {
		await navigator.clipboard.writeText(text);
		return;
	}
	const area = document.createElement("textarea");
	area.value = text;
	area.setAttribute("readonly", "");
	area.style.position = "fixed";
	area.style.opacity = "0";
	document.body.appendChild(area);
	area.select();
	try {
		if (!document.execCommand("copy")) throw new Error("copy refused");
	} finally {
		area.remove();
	}
}
