"use client"

import { memo, useCallback, useMemo, useState } from "react"
import { Play, Square } from "lucide-react"
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

interface TaskTerminal {
	scriptName: string
	paneId: string
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

	const [taskTerminals, setTaskTerminals] = useState<
		Map<string, TaskTerminal>
	>(new Map())
	const [selectedScript, setSelectedScript] = useState<string | null>(null)

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

			const existing = taskTerminals.get(scriptName)
			if (existing) {
				killMutation.mutate({ paneId: existing.paneId })
			}

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
			setSelectedScript(scriptName)
		},
		[
			workspaceId,
			worktreePath,
			pm,
			taskTerminals,
			createOrAttachMutation,
			killMutation,
		],
	)

	const handleStop = useCallback(
		(scriptName: string) => {
			const task = taskTerminals.get(scriptName)
			if (task) {
				signalMutation.mutate({ paneId: task.paneId, signal: "SIGINT" })
			}
		},
		[taskTerminals, signalMutation],
	)

	const scripts = scriptData?.scripts ?? []
	const selectedTerminal = selectedScript
		? taskTerminals.get(selectedScript)
		: null

	return (
		<div className="flex flex-col h-full">
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
								const task = taskTerminals.get(name)
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
														task
															? handleStop(name)
															: handleRun(name)
													}}
												>
													{task ? (
														<Square className="h-3.5 w-3.5" />
													) : (
														<Play className="h-3.5 w-3.5" />
													)}
												</Button>
											</TooltipTrigger>
											<TooltipContent side="left">
												{task
													? "Stop"
													: `Run "${name}"`}
											</TooltipContent>
										</Tooltip>
									</button>
								)
							})}
						</div>
					)}
				</div>
			</div>

			{/* Terminal output area */}
			<div className="flex-1 min-h-0">
				{selectedTerminal ? (
					<div
						className="h-full"
						style={{ backgroundColor: terminalBg }}
					>
						<Terminal
							key={selectedTerminal.paneId}
							paneId={selectedTerminal.paneId}
							cwd={worktreePath}
							workspaceId={workspaceId}
							initialCwd={worktreePath}
						/>
					</div>
				) : (
					<div className="flex-1 flex items-center justify-center h-full">
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
