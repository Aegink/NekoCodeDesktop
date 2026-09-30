import { existsSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { BrowserWindow } from "electron";
import { spawn } from "node-pty";
import type { SshService } from "./ssh-service";
import type {
	TerminalCreateRequest,
	TerminalInputRequest,
	TerminalResizeRequest,
	TerminalSession,
} from "../shared/terminal";

const MAX_INPUT_BYTES = 64 * 1024;

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, Math.floor(value)));
}

/** A local pty or a remote shell channel, as the panel drives either. */
interface TerminalProcess {
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(): void;
}

export class TerminalService {
	private ptys = new Map<string, TerminalProcess>();

	constructor(
		private readonly win: BrowserWindow,
		private readonly ssh?: () => SshService,
	) {}

	private output(id: string, data: string): void {
		if (!this.win.isDestroyed()) this.win.webContents.send("terminal:data", { id, data });
	}

	private exited(id: string, exitCode: number, signal?: number): void {
		if (!this.ptys.delete(id)) return;
		if (!this.win.isDestroyed()) this.win.webContents.send("terminal:exit", { id, exitCode, signal });
	}

	async create(req: TerminalCreateRequest): Promise<TerminalSession> {
		const cols = clamp(req.cols, 2, 500);
		const rows = clamp(req.rows, 1, 300);
		if (req.sshHostId) return this.createRemote(req.sshHostId, cols, rows);
		if (!existsSync(req.cwd) || !statSync(req.cwd).isDirectory()) {
			throw new Error(`Terminal cwd does not exist: ${req.cwd}`);
		}
		const shell =
			process.env.SHELL ||
			(process.platform === "win32" ? "powershell.exe" : "/bin/bash");
		const args = process.platform === "win32" ? [] : ["-l"];
		const id = randomUUID();
		const pty = spawn(shell, args, {
			name: "xterm-256color",
			cols,
			rows,
			cwd: req.cwd,
			env: {
				...process.env,
				TERM: "xterm-256color",
				COLORTERM: "truecolor",
			},
		});
		this.ptys.set(id, pty);
		pty.onData((data) => this.output(id, data));
		pty.onExit(({ exitCode, signal }) => this.exited(id, exitCode, signal));
		return { id };
	}

	private async createRemote(hostId: string, cols: number, rows: number): Promise<TerminalSession> {
		const ssh = this.ssh?.();
		if (!ssh) throw new Error("SSH is unavailable");
		const { channel, close } = await ssh.shell(hostId, { cols, rows });
		const id = randomUUID();
		// Bytes, not strings: a multibyte character can straddle two packets.
		const decoder = new TextDecoder();
		this.ptys.set(id, {
			write: (data) => channel.write(data),
			resize: (nextCols, nextRows) => channel.setWindow(nextRows, nextCols, 0, 0),
			kill: close,
		});
		const onData = (chunk: Buffer) => this.output(id, decoder.decode(chunk, { stream: true }));
		channel.on("data", onData);
		channel.stderr.on("data", onData);
		channel.on("exit", (code: number | null) => this.exited(id, typeof code === "number" ? code : 0));
		channel.on("close", () => this.exited(id, 0));
		return { id };
	}

	write(req: TerminalInputRequest): void {
		if (Buffer.byteLength(req.data, "utf8") > MAX_INPUT_BYTES) {
			throw new Error("Terminal input exceeds 64KiB");
		}
		this.ptys.get(req.id)?.write(req.data);
	}

	resize(req: TerminalResizeRequest): void {
		this.ptys
			.get(req.id)
			?.resize(clamp(req.cols, 2, 500), clamp(req.rows, 1, 300));
	}

	kill(id: string): void {
		const pty = this.ptys.get(id);
		if (!pty) return;
		this.ptys.delete(id);
		try {
			pty.kill();
		} catch {
			// already dead
		}
	}

	killAll(): void {
		for (const id of [...this.ptys.keys()]) this.kill(id);
	}
}
