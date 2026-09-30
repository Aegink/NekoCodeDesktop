import { useEffect, useState } from "react";
import type { TaskBoardEntry } from "../../../shared/task-board";
import { api } from "../api";

/**
 * The task board, kept current by main's pushes.
 *
 * Read once on mount and then only listened to: main re-sends the whole board
 * whenever any task on it moves, so there is nothing to poll.
 */
export function useTaskBoard(): TaskBoardEntry[] {
	const [entries, setEntries] = useState<TaskBoardEntry[]>([]);
	useEffect(() => {
		let pushed = false;
		const unsubscribe = api.onAgentTasks((next) => {
			pushed = true;
			setEntries(next);
		});
		api
			.agentTasks()
			.then((initial) => {
				// A push that landed first is newer than this reply.
				if (!pushed) setEntries(initial);
			})
			.catch(() => undefined);
		return unsubscribe;
	}, []);
	return entries;
}
