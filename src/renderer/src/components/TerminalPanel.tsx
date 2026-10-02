import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { SshHost } from "../../../shared/ssh";
import { api, errorMessage } from "../api";
import { readCodeFontFamily, useAppearancePreferences } from "../hooks/useAppearancePreferences";
import { useTranslation } from "../i18n";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { XIcon } from "../lib/icons";

const LOCAL = "__local__";

export function TerminalPanel({
	cwd,
	onClose,
	docked = false,
}: {
	cwd: string | null;
	onClose: () => void;
	/** Rendered inside the right dock: fill the pane instead of the bottom-drawer chrome. */
	docked?: boolean;
}) {
	const { t } = useTranslation();
	const hostRef = useRef<HTMLDivElement | null>(null);
	const terminalRef = useRef<Terminal | null>(null);
	const fitRef = useRef<FitAddon | null>(null);
	const sessionIdRef = useRef<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [height, setHeight] = useState(240);
	const [servers, setServers] = useState<SshHost[]>([]);
	/** A saved SSH host's id, or null for a shell on this machine. */
	const [target, setTarget] = useState<string | null>(null);

	useEffect(() => {
		if (api.runtime === "web") return;
		api.sshStatus().then((status) => setServers(status.hosts)).catch(() => {});
	}, []);
	const server = target ? servers.find((entry) => entry.id === target) : undefined;
	const { preferences: appearance } = useAppearancePreferences();
	// Read at creation through a ref so a font change restyles the live terminal
	// below instead of tearing down its shell session.
	const appearanceRef = useRef(appearance);
	appearanceRef.current = appearance;

	useEffect(() => {
		const terminal = terminalRef.current;
		if (!terminal) return;
		terminal.options.fontFamily = readCodeFontFamily();
		terminal.options.fontSize = appearance.terminalFontSizePx;
		fitRef.current?.fit();
		const id = sessionIdRef.current;
		if (id) void api.terminalResize({ id, cols: terminal.cols, rows: terminal.rows });
	}, [appearance.terminalFontSizePx, appearance.codeFontFamily]);

	useEffect(() => {
		// A remote shell needs no project; a local one starts in it.
		if (!cwd && !target) return;
		const host = hostRef.current;
		if (!host) return;
		setError(null);

		const { terminalFontSizePx } = appearanceRef.current;
		const terminal = new Terminal({
			fontFamily: readCodeFontFamily(),
			fontSize: terminalFontSizePx,
			cursorBlink: true,
			theme: { background: "transparent" },
		});
		const fit = new FitAddon();
		terminal.loadAddon(fit);
		terminal.open(host);
		fit.fit();
		terminalRef.current = terminal;
		fitRef.current = fit;

		let disposed = false;
		const offData = api.onTerminalData((output) => {
			if (output.id === sessionIdRef.current) terminal.write(output.data);
		});
		const offExit = api.onTerminalExit((exit) => {
			if (exit.id === sessionIdRef.current) {
				terminal.write(`\r\n${t("terminal.exited", { code: exit.exitCode })}\r\n`);
			}
		});

		if (target) terminal.write(`${t("terminal.connecting")}\r\n`);
		api
			.terminalCreate({ cwd: cwd ?? "", cols: terminal.cols, rows: terminal.rows, ...(target ? { sshHostId: target } : {}) })
			.then((session) => {
				if (disposed) {
					void api.terminalKill(session.id);
					return;
				}
				sessionIdRef.current = session.id;
			})
			.catch((cause: unknown) => setError(errorMessage(cause)));

		const onDataDisposable = terminal.onData((data) => {
			const id = sessionIdRef.current;
			if (id) void api.terminalInput({ id, data });
		});

		const resizeObserver = new ResizeObserver(() => {
			fit.fit();
			const id = sessionIdRef.current;
			if (id) void api.terminalResize({ id, cols: terminal.cols, rows: terminal.rows });
		});
		resizeObserver.observe(host);

		return () => {
			disposed = true;
			offData();
			offExit();
			onDataDisposable.dispose();
			resizeObserver.disconnect();
			const id = sessionIdRef.current;
			sessionIdRef.current = null;
			if (id) void api.terminalKill(id);
			terminal.dispose();
			terminalRef.current = null;
			fitRef.current = null;
		};
	}, [cwd, t, target]);

	return (
		<div
			className={cn(
				"flex min-h-0 flex-col bg-[var(--color-token-terminal-background)]",
				docked
					? "flex-1"
					: "thread-terminal-drawer shrink-0 border-t border-[color:var(--app-surface-divider)]",
			)}
			style={docked ? undefined : { height }}
		>
			<div className="flex h-8 shrink-0 items-center gap-2 px-2">
				{servers.length ? (
					<Select
						value={target ?? LOCAL}
						onValueChange={(value) => setTarget(value && value !== LOCAL ? String(value) : null)}
					>
						<SelectTrigger aria-label={t("terminal.target")} className="h-6 w-auto min-w-0 max-w-48" size="sm" variant="ghost">
							<SelectValue>{server ? server.name : t("terminal.local")}</SelectValue>
						</SelectTrigger>
						<SelectPopup surface="settings">
							<SelectItem value={LOCAL}>{t("terminal.local")}</SelectItem>
							{servers.map((entry) => (
								<SelectItem key={entry.id} value={entry.id}>
									{entry.name}
								</SelectItem>
							))}
						</SelectPopup>
					</Select>
				) : null}
				<span className="min-w-0 truncate text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground">
					{server
						? `SSH — ${server.username}@${server.host}${server.remoteDir ? `:${server.remoteDir}` : ""}`
						: `${t("terminal.title")} ${cwd ? `— ${cwd}` : ""}`}
				</span>
				<div className="flex-1" />
				<Button onClick={onClose} size="icon-chip" variant="ghost">
					<XIcon className="size-3" />
				</Button>
			</div>
			{error ? (
				<p className="px-2 pb-1 text-[length:var(--app-font-size-ui-sm,11px)] text-destructive">
					{error}
				</p>
			) : null}
			<div
				ref={hostRef}
				className={cn("min-h-0 flex-1 px-1 pb-1", "[&_.xterm]:h-full")}
				onMouseDown={(event) => event.stopPropagation()}
			/>
		</div>
	);
}
