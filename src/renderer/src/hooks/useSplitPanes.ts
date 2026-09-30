import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentSnapshot } from "../../../shared/agent";
import { api } from "../api";
import type { DropPlan } from "../lib/splitLayout";
import type { DraggedSession } from "../lib/sessionDrag";
import { shareStructure } from "../lib/structural-share";

/** How long a closed pane stays on screen for its exit animation. */
export const PANE_EXIT_MS = 240;

/**
 * One place a conversation is shown in the chat area.
 *
 * A pane is identified by its key, not by the session in it: the key is what
 * keeps its chat view mounted — draft, scroll position and all — while panes
 * are added, moved and closed around it. `seq` fixes its place in the DOM, so a
 * reorder is a change of position only and never re-parents the element.
 */
export interface PaneSlot {
	key: string;
	seq: number;
	/**
	 * The session shown. While the chat area holds a single pane this is not
	 * read — that pane always shows the selected session, as it did before
	 * there were panes.
	 */
	session: DraggedSession | null;
	/** Closed, and playing its exit before it goes. */
	leaving?: number;
}

interface PaneState {
	/** Live panes in layout order, then the ones on their way out. */
	slots: PaneSlot[];
	focused: string;
}

const PRIMARY: PaneSlot = { key: "primary", seq: 0, session: null };

export interface SplitPanes {
	/** Every pane to render, leaving ones included, in stable DOM order. */
	slots: PaneSlot[];
	/** Live panes in layout order. */
	live: PaneSlot[];
	split: boolean;
	focused: string;
	snapshotFor(slot: PaneSlot): AgentSnapshot | null;
	/** Resolves once the pane's session is the selected one, so actions can go to it. */
	ready(key: string): Promise<void>;
	focus(key: string): void;
	drop(session: DraggedSession, plan: DropPlan): void;
	close(key: string): void;
	maximize(key: string): void;
	/** A session is going away; take its pane down first. */
	forget(sessionId: string): void;
}

/**
 * The chat area's panes: up to four sessions side by side.
 *
 * Main still has one selected session, and every composer action goes to it,
 * so the focused pane is always the selected one; focusing another pane opens
 * its session. The others are kept current by main's `agent:paneSnapshot`.
 */
export function useSplitPanes({
	enabled,
	active,
	open,
}: {
	/** Off in the WebUI and in external-agent workspaces: both are one-session views. */
	enabled: boolean;
	active: AgentSnapshot | null;
	open: (session: DraggedSession) => Promise<void>;
}): SplitPanes {
	const [state, setState] = useState<PaneState>({ slots: [PRIMARY], focused: PRIMARY.key });
	const [paneSnapshots, setPaneSnapshots] = useState<ReadonlyMap<string, AgentSnapshot>>(new Map());
	const seq = useRef(1);
	const activeSession: DraggedSession | null = active
		? { id: active.session.id, cwd: active.session.cwd, sessionFile: active.session.sessionFile }
		: null;
	const activeId = activeSession?.id ?? null;
	const activeIdRef = useRef(activeId);
	activeIdRef.current = activeId;
	/** The session a focus change is waiting on, and its reply. */
	const pending = useRef<{ id: string; promise: Promise<void> } | null>(null);

	const live = state.slots.filter((slot) => slot.leaving === undefined);
	const split = live.length > 1;

	const select = useCallback(
		(session: DraggedSession | null): Promise<void> => {
			if (!session || session.id === activeIdRef.current) return Promise.resolve();
			if (pending.current?.id === session.id) return pending.current.promise;
			const promise = open(session).finally(() => {
				if (pending.current?.promise === promise) pending.current = null;
			});
			pending.current = { id: session.id, promise };
			return promise;
		},
		[open],
	);

	const focus = (key: string) => {
		const slot = live.find((entry) => entry.key === key);
		if (!slot || !split) return;
		if (state.focused !== key) setState((previous) => ({ ...previous, focused: key }));
		void select(slot.session);
	};

	const ready = (key: string): Promise<void> => {
		const slot = live.find((entry) => entry.key === key);
		if (!split || !slot) return Promise.resolve();
		if (state.focused !== key) setState((previous) => ({ ...previous, focused: key }));
		return select(slot.session);
	};

	/** Live panes as they stand, the lone pane standing for the selected session. */
	const effectiveLive = (): PaneSlot[] =>
		live.length === 1 ? [{ ...live[0], session: activeSession }] : live;

	const retire = (slots: PaneSlot[], keep: ReadonlySet<string>): PaneSlot[] => {
		const now = Date.now();
		return slots
			.filter((slot) => !keep.has(slot.key))
			.map((slot) => (slot.leaving === undefined ? { ...slot, leaving: now } : slot));
	};

	const drop = (session: DraggedSession, plan: DropPlan) => {
		const current = effectiveLive();
		const byId = new Map(current.flatMap((slot) => (slot.session ? [[slot.session.id, slot] as const] : [])));
		const next = plan.order.flatMap((id): PaneSlot[] => {
			const existing = byId.get(id);
			if (existing) return [existing];
			if (id !== session.id) return [];
			return [{ key: `pane-${seq.current}`, seq: seq.current++, session }];
		});
		const target = next.find((slot) => slot.session?.id === session.id);
		if (!target) return;
		const keep = new Set(next.map((slot) => slot.key));
		setState({ slots: [...next, ...retire(state.slots, keep)], focused: target.key });
		void select(session);
	};

	const close = (key: string) => {
		const index = live.findIndex((slot) => slot.key === key);
		if (!split || index === -1) return;
		const remaining = live.filter((slot) => slot.key !== key);
		const focused = state.focused === key ? remaining[Math.min(index, remaining.length - 1)] : null;
		setState({
			slots: [...remaining, ...retire(state.slots, new Set(remaining.map((slot) => slot.key)))],
			focused: focused?.key ?? state.focused,
		});
		if (focused) void select(focused.session);
	};

	const maximize = (key: string) => {
		const slot = live.find((entry) => entry.key === key);
		if (!split || !slot) return;
		setState({ slots: [slot, ...retire(state.slots, new Set([key]))], focused: key });
		void select(slot.session);
	};

	const forget = (sessionId: string) => {
		const slot = live.find((entry) => entry.session?.id === sessionId);
		if (split && slot) close(slot.key);
	};

	// The selection moved on its own — a sidebar click, a fork, a new session.
	// A session already in a pane takes the focus; any other means the user
	// went somewhere the split is not, so it folds into the focused pane.
	const lastActive = useRef(activeId);
	useEffect(() => {
		const previous = lastActive.current;
		lastActive.current = activeId;
		if (!activeId || activeId === previous) return;
		const awaited = pending.current?.id;
		if (awaited && awaited !== activeId) return;
		setState((current) => {
			const panes = current.slots.filter((slot) => slot.leaving === undefined);
			if (panes.length < 2) return current;
			const hit = panes.find((slot) => slot.session?.id === activeId);
			if (hit) return hit.key === current.focused ? current : { ...current, focused: hit.key };
			const focused = panes.find((slot) => slot.key === current.focused) ?? panes[0];
			return {
				slots: [{ ...focused, session: null }, ...retire(current.slots, new Set([focused.key]))],
				focused: focused.key,
			};
		});
	}, [activeId]);

	// An external-agent workspace has nowhere to show panes: fold them.
	useEffect(() => {
		if (enabled) return;
		setState((current) => {
			const panes = current.slots.filter((slot) => slot.leaving === undefined);
			if (panes.length < 2) return current;
			const focused = panes.find((slot) => slot.key === current.focused) ?? panes[0];
			return { slots: [focused, ...retire(current.slots, new Set([focused.key]))], focused: focused.key };
		});
	}, [enabled]);

	// Closed panes go once their exit has played.
	const hasLeaving = state.slots.some((slot) => slot.leaving !== undefined);
	useEffect(() => {
		if (!hasLeaving) return;
		const timer = window.setTimeout(() => {
			const cutoff = Date.now() - PANE_EXIT_MS;
			setState((current) => {
				const slots = current.slots.filter((slot) => slot.leaving === undefined || slot.leaving > cutoff);
				return slots.length === current.slots.length ? current : { ...current, slots };
			});
		}, PANE_EXIT_MS + 20);
		return () => window.clearTimeout(timer);
	}, [state.slots, hasLeaving]);

	// Sessions no pane shows any more take their snapshots with them.
	const shownIds = state.slots.flatMap((slot) => (slot.session ? [slot.session.id] : [])).join("\n");
	useEffect(() => {
		const ids = new Set(shownIds.split("\n"));
		setPaneSnapshots((current) => {
			if ([...current.keys()].every((id) => ids.has(id))) return current;
			return new Map([...current].filter(([id]) => ids.has(id)));
		});
	}, [shownIds]);

	useEffect(() => {
		if (!enabled) return;
		return api.onAgentPaneSnapshot((next) =>
			setPaneSnapshots((current) =>
				new Map(current).set(next.session.id, shareStructure(current.get(next.session.id) ?? null, next)),
			),
		);
	}, [enabled]);

	// Tell main which sessions to keep streaming here. Leaving panes are not
	// among them: what they show for their last quarter second is what they had.
	const watched = split ? live.flatMap((slot) => (slot.session ? [slot.session] : [])) : [];
	const watchKey = watched.map((session) => session.sessionFile).join("\n");
	const everWatched = useRef(false);
	useEffect(() => {
		if (!enabled || (!watchKey && !everWatched.current)) return;
		everWatched.current = true;
		let cancelled = false;
		api
			.agentWatchPanes(watched.map(({ cwd, sessionFile }) => ({ cwd, sessionFile })))
			.then((snapshots) => {
				if (cancelled || snapshots.length === 0) return;
				setPaneSnapshots((current) => {
					const next = new Map(current);
					for (const snapshot of snapshots) {
						// A push since the request went out is newer than this reply.
						if (!next.has(snapshot.session.id)) next.set(snapshot.session.id, snapshot);
					}
					return next;
				});
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [watchKey, enabled]);

	const snapshotFor = (slot: PaneSlot): AgentSnapshot | null => {
		if (!split && slot.leaving === undefined) return active;
		const id = slot.session?.id;
		if (!id || active?.session.id === id) return active;
		return paneSnapshots.get(id) ?? null;
	};

	return {
		slots: [...state.slots].sort((a, b) => a.seq - b.seq),
		live,
		split,
		focused: split ? state.focused : (live[0]?.key ?? PRIMARY.key),
		snapshotFor,
		ready,
		focus,
		drop,
		close,
		maximize,
		forget,
	};
}
