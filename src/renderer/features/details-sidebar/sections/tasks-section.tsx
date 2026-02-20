"use client"

import { memo, useCallback, useEffect, useRef, useState } from "react"
import {
	Play,
	Square,
	Loader2,
	CheckCircle2,
	XCircle,
	Trash2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { trpc } from "@/lib/trpc"
import { stripAnsi, type RunningTaskState } from "./tasks-widget"

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

interface TasksSectionProps {
	worktreePath: string
	workspaceId: string
	isExpanded?: boolean
}

export const TasksSection = memo(function TasksSection({
	worktreePath,
	workspaceId,
}: TasksSectionProps) {
	const { data: scriptData } = trpc.tasks.getScripts.useQuery(
		{ worktreePath },
		{ staleTime: 30_000 },
	)

	const [runningTasks, setRunningTasks] = useState<
		Map<string, RunningTaskState>
	>(new Map())
	const [selectedScript, setSelectedScript] = useState<string | null>(null)

	const logContainerRef = useRef<HTMLDivElement>(null)

	const runMutation = trpc.tasks.run.useMutation()
	const stopMutation = trpc.tasks.stop.useMutation()

	// Reconnect to already-running tasks
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
						setSelectedScript(scriptName)
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

	const handleClearLogs = useCallback(() => {
		if (!selectedScript) return
		setRunningTasks((prev) => {
			const next = new Map(prev)
			const task = next.get(selectedScript)
			if (task && task.status !== "running") {
				next.delete(selectedScript)
			} else if (task) {
				next.set(selectedScript, { ...task, logs: [] })
			}
			return next
		})
	}, [selectedScript])

	const handleStreamData = useCallback((taskId: string, data: string) => {
		setRunningTasks((prev) => {
			const next = new Map(prev)
			for (const [key, task] of next) {
				if (task.taskId === taskId) {
					const newLogs = [...task.logs, data]
					if (newLogs.length > 1000) newLogs.splice(0, newLogs.length - 1000)
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

	// Auto-scroll log container
	useEffect(() => {
		const container = logContainerRef.current
		if (container) {
			container.scrollTop = container.scrollHeight
		}
	}, [selectedScript, runningTasks.get(selectedScript ?? "")?.logs.length])

	const scripts = scriptData?.scripts ?? []
	const selectedTask = selectedScript
		? runningTasks.get(selectedScript)
		: null

	const activeSubscriptions = Array.from(runningTasks.values()).filter(
		(t) => t.status === "running",
	)

	return (
		<div className="flex flex-col h-full">
			{/* Invisible subscription components */}
			{activeSubscriptions.map((task) => (
				<TaskOutputStream
					key={task.taskId}
					taskId={task.taskId}
					onData={handleStreamData}
					onExit={handleStreamExit}
				/>
			))}

			{/* Script list */}
			<div className="flex-shrink-0 border-b border-border/50 overflow-y-auto max-h-[40%]">
				<div className="px-3 py-2">
					{scripts.length === 0 ? (
						<div className="text-xs text-muted-foreground py-2">
							{scriptData
								? "No scripts in package.json"
								: "Loading scripts..."}
						</div>
					) : (
						<div className="flex flex-col gap-0.5">
							{scripts.map(({ name, command }) => {
								const task = runningTasks.get(name)
								const isRunning = task?.status === "running"
								const isSelected = selectedScript === name

								return (
									<button
										key={name}
										type="button"
										onClick={() => setSelectedScript(name)}
										className={cn(
											"flex items-center gap-2 min-h-[32px] rounded px-2 py-1 text-left group transition-colors",
											isSelected
												? "bg-accent"
												: "hover:bg-accent/50",
										)}
									>
										<TaskStatusIcon status={task?.status} />
										<div className="flex-1 min-w-0">
											<div className="text-xs font-medium text-foreground truncate">
												{name}
											</div>
											<div className="text-[10px] text-muted-foreground truncate">
												{command}
											</div>
										</div>
										<Tooltip>
											<TooltipTrigger asChild>
												<Button
													variant="ghost"
													size="icon"
													className="h-6 w-6 p-0 hover:bg-foreground/10 text-muted-foreground hover:text-foreground rounded-md opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
													onClick={(e) => {
														e.stopPropagation()
														isRunning
															? handleStop(name)
															: handleRun(name, command)
													}}
												>
													{isRunning ? (
														<Square className="h-3.5 w-3.5" />
													) : (
														<Play className="h-3.5 w-3.5" />
													)}
												</Button>
											</TooltipTrigger>
											<TooltipContent side="left">
												{isRunning ? "Stop" : `Run "${name}"`}
											</TooltipContent>
										</Tooltip>
									</button>
								)
							})}
						</div>
					)}
				</div>
			</div>

			{/* Log output area */}
			<div className="flex-1 flex flex-col min-h-0">
				{selectedTask ? (
					<>
						<div className="flex items-center justify-between px-3 py-1.5 border-b border-border/50 flex-shrink-0">
							<div className="flex items-center gap-1.5">
								<TaskStatusIcon status={selectedTask.status} />
								<span className="text-xs font-medium text-foreground">
									{selectedTask.scriptName}
								</span>
								{selectedTask.exitCode !== undefined &&
									selectedTask.exitCode !== null && (
										<span
											className={cn(
												"text-[10px] px-1 py-0.5 rounded",
												selectedTask.exitCode === 0
													? "bg-green-500/10 text-green-500"
													: "bg-red-500/10 text-red-500",
											)}
										>
											exit {selectedTask.exitCode}
										</span>
									)}
							</div>
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										variant="ghost"
										size="icon"
										className="h-5 w-5 p-0 text-muted-foreground hover:text-foreground"
										onClick={handleClearLogs}
									>
										<Trash2 className="h-3 w-3" />
									</Button>
								</TooltipTrigger>
								<TooltipContent side="left">Clear logs</TooltipContent>
							</Tooltip>
						</div>
						<div
							ref={logContainerRef}
							className="flex-1 overflow-y-auto bg-muted/20"
						>
							<pre className="text-[11px] leading-[1.5] text-muted-foreground font-mono whitespace-pre-wrap p-3">
								{selectedTask.logs.length > 0
									? stripAnsi(selectedTask.logs.join(""))
									: "Waiting for output..."}
							</pre>
						</div>
					</>
				) : (
					<div className="flex-1 flex items-center justify-center">
						<span className="text-xs text-muted-foreground">
							{scripts.length > 0
								? "Select a script to view output"
								: "No scripts available"}
						</span>
					</div>
				)}
			</div>
		</div>
	)
})

function TaskStatusIcon({ status }: { status?: string }) {
	switch (status) {
		case "running":
			return (
				<Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin flex-shrink-0" />
			)
		case "success":
			return (
				<CheckCircle2 className="h-3.5 w-3.5 text-green-500 flex-shrink-0" />
			)
		case "error":
			return <XCircle className="h-3.5 w-3.5 text-red-500 flex-shrink-0" />
		case "stopped":
			return (
				<Square className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
			)
		default:
			return <div className="w-3.5 h-3.5 flex-shrink-0" />
	}
}
