import type { UiElement } from "./window-model";

/**
 * How each action reaches a window: in the background through UI Automation,
 * or as real input with the window brought to the front.
 *
 * Background is preferred — it leaves the user's mouse and focus alone — but
 * only where it is known to work:
 *
 * - In classic Win32, WinForms and their kin, a UI Automation Invoke runs the
 *   button's handler synchronously: a handler that opens a modal dialog does
 *   not return until the dialog closes, and meanwhile the whole app stops
 *   answering UI Automation. Measured: a two-minute hang. Real input has no
 *   such coupling.
 * - In web UIs (Chromium, Electron, CEF hosts such as NetEase Cloud Music) most
 *   clickable things are plain elements with script handlers — a song title, a
 *   card, an icon. UI Automation's default action on those does nothing; a real
 *   click is what the page listens for. Real buttons, links and fields still
 *   take the default action fine.
 * - Keys posted to a window's frame do not reach the focused control in any of
 *   these: Enter posted to NetEase's search box and Escape posted to a WinForms
 *   dialog both did nothing while reporting success. Keys and typing are real
 *   input everywhere.
 * - XAML and WPF dispatch Invoke asynchronously and handle it fully, so their
 *   clicks stay in the background.
 */

export type Framework = "classic" | "xaml" | "web" | "unknown";

const XAML_CLASSES = [
	/^ApplicationFrameWindow$/, // UWP host
	/^Windows\.UI\.Core\.CoreWindow$/,
	/^WinUIDesktopWin32WindowClass$/,
	/^HwndWrapper\[/, // WPF
];

const WEB_CLASSES = [
	/^Chrome_WidgetWin_\d+$/, // Chromium, Edge, Electron, WebView2 hosts
	/^CefBrowserWindow$/,
	/^OrpheusBrowserHost$/, // NetEase Cloud Music
	/^MozillaWindowClass$/,
	/BrowserHost|WebView|CefClient/i,
];

/** Classes known to run Invoke synchronously. */
const CLASSIC_CLASSES = [
	/^WindowsForms10\./,
	/^#32770$/, // standard dialogs
	/^Afx/, // MFC
	/^T[A-Z]\w*Form$|^TApplication$/, // Delphi / C++Builder VCL
	/^ThunderRT6/, // Visual Basic 6
	/^Notepad$|^WordPadClass$|^MSPaintApp$/,
	/^SunAwt/, // Java AWT/Swing
];

export function frameworkOf(className: string): Framework {
	if (XAML_CLASSES.some((pattern) => pattern.test(className))) return "xaml";
	if (WEB_CLASSES.some((pattern) => pattern.test(className))) return "web";
	if (CLASSIC_CLASSES.some((pattern) => pattern.test(className))) return "classic";
	return "unknown";
}

/**
 * Elements whose click is a state change, not a command: toggling, selecting,
 * expanding, focusing a field. Their patterns do not run arbitrary handlers
 * the way Invoke does, so classic apps can take them in the background.
 */
const STATEFUL_ROLES = new Set(["CheckBox", "RadioButton", "ListItem", "TreeItem", "TabItem", "DataItem", "ComboBox", "Edit", "Document", "Text"]);

/** In a web UI, the roles of real controls, whose default action is what a click does. */
const WEB_CONTROL_ROLES = new Set(["Button", "Hyperlink", "MenuItem", "CheckBox", "RadioButton", "TabItem", "ComboBox", "Edit", "SplitButton"]);

export type Route =
	/** UI Automation, in the background. */
	| "background"
	/** UI Automation in the background, but watched: past a short wait it is presumed blocked by a modal. */
	| "guarded"
	/** Real input, with the window brought to the front. */
	| "foreground";

export interface RouteContext {
	framework: Framework;
	/** The app is waiting on a modal opened by an earlier action; it will not answer UI Automation. */
	blocked: boolean;
}

export interface ClickKind {
	button?: string;
	count?: number;
}

/** How to click an element, or a point when there is none. */
export function clickRoute(element: UiElement | undefined, context: RouteContext, kind: ClickKind = {}): Route {
	if (context.blocked) return "foreground";
	// UI Automation has no double click and no right click: those are pointer gestures.
	if ((kind.count ?? 1) > 1 || (kind.button && kind.button !== "left")) return "foreground";
	switch (context.framework) {
		case "xaml":
			return "background";
		case "web":
			return element && WEB_CONTROL_ROLES.has(element.role) ? "background" : "foreground";
		case "classic":
			return element && STATEFUL_ROLES.has(element.role) ? "background" : "foreground";
		default:
			return element && STATEFUL_ROLES.has(element.role) ? "background" : "guarded";
	}
}

/** Keys and typing: real input, the only kind every toolkit reliably receives. */
export function keyRoute(_context: RouteContext): Route {
	return "foreground";
}

/** Whether a driver error means background delivery did not work and real input should be tried. */
export function needsForeground(errorCode: string | undefined, text: string): boolean {
	return errorCode === "background_unavailable" || /background[_ ]unavailable|delivery_mode:\s*"?foreground/i.test(text);
}

/** Whether a read failed because the app is not answering UI Automation. */
export function isUnresponsive(text: string): boolean {
	return /unresponsive|timed out after/i.test(text);
}

/** Key names as models write them, to the driver's names. */
const KEY_ALIASES: Record<string, string> = {
	enter: "return",
	esc: "escape",
	del: "delete",
	ins: "insert",
	pgup: "pageup",
	pgdn: "pagedown",
	page_up: "pageup",
	page_down: "pagedown",
	arrowup: "up",
	arrowdown: "down",
	arrowleft: "left",
	arrowright: "right",
	control: "ctrl",
	cmd: "win",
	meta: "win",
	windows: "win",
	option: "alt",
	spacebar: "space",
};

export function normalizeKey(name: string): string {
	const key = name.trim().toLowerCase();
	return KEY_ALIASES[key] ?? key;
}
