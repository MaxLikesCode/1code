"use client"

import { memo, useCallback, useEffect, useRef, useState } from "react"
import {
	Play,
	Square,
	Loader2,
	CheckCircle2,
	XCircle,
	ChevronDown,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { trpc } from "@/lib/trpc"

// Strip ANSI escape codes for clean display
function stripAnsi(str: string): string {
	return str.replace(
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escape sequences
		/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
		"",
	)
}

interface RunningTaskState {
	taskId: string
	scriptName: string
	status: "running" | "success" | "error" | "stopped"
	logs: string[]
	exitCode?: number | null
}

// Invisible component that subscribes to a task's output stream
function TaskOutputStream({
	taskId,
	onData,
	onExit,
}: {
	taskId: string
	onData: (taskId: string, data: string) => void
	onExit: (taskId: string, exitCode: number | null) => void
}) {
	trpc.tasks.stream.useSubscription(taskId, {
		onData: (event) => {
			if (event.type === "stdout" || event.type === "stderr") {
				if (event.data) onData(taskId, event.data)
			} else if (event.type === "exit") {
				onExit(taskId, event.exitCode ?? null)
			}
		},
	})
	return null
}

interface TasksWidgetProps {
	worktreePath: string
	workspaceId: string
}

export const TasksWidget = memo(function TasksWidget({
	worktreePath,
	workspaceId,
}: TasksWidgetProps) {
	const { data: scriptData } = trpc.tasks.getScripts.useQuery(
		{ worktreePath },
		{ staleTime: 30_000 },
	)

	const [runningTasks, setRunningTasks] = useState<
		Map<string, RunningTaskState>
	>(new Map())
	const [expandedScript, setExpandedScript] = useState<string | null>(null)

	const logEndRef = useRef<HTMLDivElement>(null)

	const runMutation = trpc.tasks.run.useMutation()
	const stopMutation = trpc.tasks.stop.useMutation()

	// Reconnect to tasks that are already running (e.g. after re-mount)
	const { data: alreadyRunning } = trpc.tasks.listRunning.useQuery(
		{ workspaceId },
		{ staleTime: 5_000 },
	)

	useEffect(() => {
		if (!alreadyRunning || alreadyRunning.length === 0) return
		setRunningTasks((prev) => {
			const next = new Map(prev)
			for (const t of alreadyRunning) {
				if (!next.has(t.scriptName)) {
					next.set(t.scriptName, {
						taskId: t.taskId,
						scriptName: t.scriptName,
						status: "running",
						logs: t.logBuffer ?? [],
					})
				}
			}
			return next
		})
	}, [alreadyRunning])

	const handleRun = useCallback(
		(scriptName: string, command: string) => {
			runMutation.mutate(
				{ worktreePath, workspaceId, scriptName, command },
				{
					onSuccess: ({ taskId }) => {
						setRunningTasks((prev) => {
							const next = new Map(prev)
							next.set(scriptName, {
								taskId,
								scriptName,
								status: "running",
								logs: [],
							})
							return next
						})
						setExpandedScript(scriptName)
					},
				},
			)
		},
		[worktreePath, workspaceId, runMutation],
	)

	const handleStop = useCallback(
		(scriptName: string) => {
			const task = runningTasks.get(scriptName)
			if (task) {
				stopMutation.mutate({ taskId: task.taskId })
				setRunningTasks((prev) => {
					const next = new Map(prev)
					const t = next.get(scriptName)
					if (t) next.set(scriptName, { ...t, status: "stopped" })
					return next
				})
			}
		},
		[runningTasks, stopMutation],
	)

	const handleStreamData = useCallback((taskId: string, data: string) => {
		setRunningTasks((prev) => {
			const next = new Map(prev)
			for (const [key, task] of next) {
				if (task.taskId === taskId) {
					const newLogs = [...task.logs, data]
					// Cap at 500 entries
					if (newLogs.length > 500) newLogs.splice(0, newLogs.length - 500)
					next.set(key, { ...task, logs: newLogs })
					break
				}
			}
			return next
		})
	}, [])

	const handleStreamExit = useCallback(
		(taskId: string, exitCode: number | null) => {
			setRunningTasks((prev) => {
				const next = new Map(prev)
				for (const [key, task] of next) {
					if (task.taskId === taskId) {
						next.set(key, {
							...task,
							status: exitCode === 0 ? "success" : "error",
							exitCode,
						})
						break
					}
				}
				return next
			})
		},
		[],
	)

	// Auto-scroll log area when expanded script gets new data
	useEffect(() => {
		logEndRef.current?.scrollIntoView({ behavior: "smooth" })
	}, [
		expandedScript,
		runningTasks.get(expandedScript ?? "")?.logs.length,
	])

	const scripts = scriptData?.scripts ?? []

	if (scripts.length === 0) {
		return (
			<div className="px-2 py-2">
				<div className="text-xs text-muted-foreground">
					{scriptData ? "No scripts in package.json" : "Loading scripts..."}
				</div>
			</div>
		)
	}

	// Render invisible subscription components for all running tasks
	const activeSubscriptions = Array.from(runningTasks.values()).filter(
		(t) => t.status === "running",
	)

	return (
		<div className="px-2 py-1.5 flex flex-col gap-0.5">
			{/* Invisible subscription components */}
			{activeSubscriptions.map((task) => (
				<TaskOutputStream
					key={task.taskId}
					taskId={task.taskId}
					onData={handleStreamData}
					onExit={handleStreamExit}
				/>
			))}

			{scripts.map(({ name, command }) => {
				const task = runningTasks.get(name)
				const isRunning = task?.status === "running"
				const isExpanded = expandedScript === name && !!task

				return (
					<div key={name}>
						{/* Script row */}
						<div className="flex items-center gap-1.5 min-h-[28px] rounded px-1.5 py-0.5 -ml-0.5 hover:bg-accent group">
							<TaskStatusIcon status={task?.status} />

							<button
								type="button"
								className="text-xs text-foreground truncate flex-1 text-left"
								onClick={() =>
									setExpandedScript(expandedScript === name ? null : name)
								}
								title={command}
							>
								{name}
							</button>

							{/* Show chevron if task has logs */}
							{task && (
								<ChevronDown
									className={cn(
										"h-3 w-3 text-muted-foreground/50 shrink-0 transition-transform duration-150",
										!isExpanded && "-rotate-90",
									)}
								/>
							)}

							{/* Run / Stop button */}
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										variant="ghost"
										size="icon"
										className="h-5 w-5 p-0 hover:bg-foreground/10 text-muted-foreground hover:text-foreground rounded-md opacity-0 group-hover:opacity-100 transition-[background-color,opacity] duration-150 ease-out flex-shrink-0"
										onClick={(e) => {
											e.stopPropagation()
											isRunning
												? handleStop(name)
												: handleRun(name, command)
										}}
									>
										{isRunning ? (
											<Square className="h-3 w-3" />
										) : (
											<Play className="h-3 w-3" />
										)}
									</Button>
								</TooltipTrigger>
								<TooltipContent side="left">
									{isRunning ? "Stop" : `Run "${name}"`}
								</TooltipContent>
							</Tooltip>
						</div>

						{/* Inline log preview */}
						{isExpanded && task && (
							<div className="ml-[18px] mt-0.5 mb-1 rounded bg-muted/50 border border-border/30 max-h-[150px] overflow-y-auto">
								<pre className="text-[10px] leading-[1.4] text-muted-foreground font-mono whitespace-pre-wrap p-2">
									{task.logs.length > 0
										? stripAnsi(task.logs.slice(-30).join(""))
										: "Waiting for output..."}
								</pre>
								<div ref={logEndRef} />
							</div>
						)}
					</div>
				)
			})}
		</div>
	)
})

function TaskStatusIcon({ status }: { status?: string }) {
	switch (status) {
		case "running":
			return (
				<Loader2 className="h-3 w-3 text-blue-500 animate-spin flex-shrink-0" />
			)
		case "success":
			return (
				<CheckCircle2 className="h-3 w-3 text-green-500 flex-shrink-0" />
			)
		case "error":
			return <XCircle className="h-3 w-3 text-red-500 flex-shrink-0" />
		case "stopped":
			return (
				<Square className="h-3 w-3 text-muted-foreground flex-shrink-0" />
			)
		default:
			return <div className="w-3 h-3 flex-shrink-0" />
	}
}

// Exported for use in expanded sidebar view
export { stripAnsi }
export type { RunningTaskState }
