"use client"

import { memo, useCallback, useMemo, useState, useEffect } from "react"
import { Play, Square, ChevronDown } from "lucide-react"
import { useTheme } from "next-themes"
import { useAtomValue } from "jotai"
import { Button } from "@/components/ui/button"
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { trpc } from "@/lib/trpc"
import { Terminal } from "@/features/terminal/terminal"
import { getDefaultTerminalBg } from "@/features/terminal/helpers"
import { fullThemeDataAtom } from "@/lib/atoms"
import { motion } from "motion/react"

interface TaskTerminal {
	/** Script name this terminal is running */
	scriptName: string
	/** Unique paneId for the terminal session */
	paneId: string
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

	// Track active task terminals: scriptName -> paneId
	const [taskTerminals, setTaskTerminals] = useState<Map<string, TaskTerminal>>(
		new Map(),
	)
	// Which task's terminal is currently shown
	const [activeTask, setActiveTask] = useState<string | null>(null)

	const createOrAttachMutation = trpc.terminal.createOrAttach.useMutation()
	const killMutation = trpc.terminal.kill.useMutation()
	const signalMutation = trpc.terminal.signal.useMutation()

	// Theme for terminal background
	const { resolvedTheme } = useTheme()
	const isDark = resolvedTheme === "dark"
	const fullThemeData = useAtomValue(fullThemeDataAtom)

	const terminalBg = useMemo(() => {
		if (fullThemeData?.colors?.["terminal.background"]) {
			return fullThemeData.colors["terminal.background"]
		}
		if (fullThemeData?.colors?.["editor.background"]) {
			return fullThemeData.colors["editor.background"]
		}
		return getDefaultTerminalBg(isDark)
	}, [isDark, fullThemeData])

	const pm = scriptData?.packageManager ?? "npm"

	const handleRun = useCallback(
		(scriptName: string) => {
			const paneId = `${workspaceId}:task:${scriptName}:${Date.now()}`

			// Kill existing terminal for this script if any
			const existing = taskTerminals.get(scriptName)
			if (existing) {
				killMutation.mutate({ paneId: existing.paneId })
			}

			// Create a terminal session that runs the command
			createOrAttachMutation.mutate({
				paneId,
				workspaceId,
				cols: 80,
				rows: 24,
				cwd: worktreePath,
				initialCommands: [`${pm} run ${scriptName}`],
			})

			setTaskTerminals((prev) => {
				const next = new Map(prev)
				next.set(scriptName, { scriptName, paneId })
				return next
			})
			setActiveTask(scriptName)
		},
		[workspaceId, worktreePath, pm, taskTerminals, createOrAttachMutation, killMutation],
	)

	const handleStop = useCallback(
		(scriptName: string) => {
			const task = taskTerminals.get(scriptName)
			if (task) {
				// Send Ctrl+C (SIGINT) first
				signalMutation.mutate({ paneId: task.paneId, signal: "SIGINT" })
			}
		},
		[taskTerminals, signalMutation],
	)

	const handleClose = useCallback(
		(scriptName: string) => {
			const task = taskTerminals.get(scriptName)
			if (task) {
				killMutation.mutate({ paneId: task.paneId })
				setTaskTerminals((prev) => {
					const next = new Map(prev)
					next.delete(scriptName)
					return next
				})
				if (activeTask === scriptName) {
					setActiveTask(null)
				}
			}
		},
		[taskTerminals, activeTask, killMutation],
	)

	// Clean up all task terminals on unmount
	useEffect(() => {
		return () => {
			// We don't kill here — terminals survive for reattach
		}
	}, [])

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

	const activeTerminal = activeTask ? taskTerminals.get(activeTask) : null

	return (
		<div className="flex flex-col">
			{/* Script list */}
			<div className="px-2 py-1.5 flex flex-col gap-0.5">
				{scripts.map(({ name, command }) => {
					const task = taskTerminals.get(name)
					const isActive = activeTask === name

					return (
						<div
							key={name}
							className={cn(
								"flex items-center gap-1.5 min-h-[28px] rounded px-1.5 py-0.5 -ml-0.5 group transition-colors",
								isActive ? "bg-accent" : "hover:bg-accent",
							)}
						>
							{/* Script name — click to show/hide terminal */}
							<button
								type="button"
								className="text-xs text-foreground truncate flex-1 text-left"
								onClick={() => {
									if (task) {
										setActiveTask(isActive ? null : name)
									}
								}}
								title={command}
							>
								{name}
							</button>

							{/* Show chevron if task has a terminal */}
							{task && (
								<ChevronDown
									className={cn(
										"h-3 w-3 text-muted-foreground/50 shrink-0 transition-transform duration-150",
										!isActive && "-rotate-90",
									)}
								/>
							)}

							{/* Stop button (visible when task has a terminal) */}
							{task && (
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											variant="ghost"
											size="icon"
											className="h-5 w-5 p-0 hover:bg-foreground/10 text-muted-foreground hover:text-foreground rounded-md opacity-0 group-hover:opacity-100 transition-[background-color,opacity] duration-150 ease-out flex-shrink-0"
											onClick={(e) => {
												e.stopPropagation()
												handleStop(name)
											}}
										>
											<Square className="h-3 w-3" />
										</Button>
									</TooltipTrigger>
									<TooltipContent side="left">
										Stop
									</TooltipContent>
								</Tooltip>
							)}

							{/* Run button */}
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										variant="ghost"
										size="icon"
										className="h-5 w-5 p-0 hover:bg-foreground/10 text-muted-foreground hover:text-foreground rounded-md opacity-0 group-hover:opacity-100 transition-[background-color,opacity] duration-150 ease-out flex-shrink-0"
										onClick={(e) => {
											e.stopPropagation()
											handleRun(name)
										}}
									>
										<Play className="h-3 w-3" />
									</Button>
								</TooltipTrigger>
								<TooltipContent side="left">
									Run "{name}"
								</TooltipContent>
							</Tooltip>
						</div>
					)
				})}
			</div>

			{/* Embedded terminal for active task */}
			{activeTerminal && (
				<div
					className="min-h-0 overflow-hidden border-t border-border/30"
					style={{ backgroundColor: terminalBg, height: "200px" }}
				>
					<motion.div
						key={activeTerminal.paneId}
						className="h-full"
						initial={{ opacity: 0 }}
						animate={{ opacity: 1 }}
						transition={{ duration: 0 }}
					>
						<Terminal
							paneId={activeTerminal.paneId}
							cwd={worktreePath}
							workspaceId={workspaceId}
							initialCwd={worktreePath}
						/>
					</motion.div>
				</div>
			)}
		</div>
	)
})
