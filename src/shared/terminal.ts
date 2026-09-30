export interface TerminalCreateRequest {
	cwd: string;
	cols: number;
	rows: number;
	/** A saved SSH host: open a remote login shell there instead of a local one. */
	sshHostId?: string;
}

export interface TerminalSession {
	id: string;
}

export interface TerminalResizeRequest {
	id: string;
	cols: number;
	rows: number;
}

export interface TerminalInputRequest {
	id: string;
	data: string;
}

export interface TerminalOutput {
	id: string;
	data: string;
}

export interface TerminalExit {
	id: string;
	exitCode: number;
	signal?: number;
}
