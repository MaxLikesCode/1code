"use client"

import { memo, useCallback, useMemo, useState, useEffect } from "react"
import {
	Play,
	Square,
	RotateCcw,
	ChevronDown,
	RefreshCw,
	AlertTriangle,
} from "lucide-react"
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

// ─── Types ───────────────────────────────────────────────────────────────────

type ServiceStatus =
	| "stopped"
	| "starting"
	| "running"
	| "error"
	| "stopping"
	| "port_conflict"

interface StackWidgetProps {
	projectId: string
	projectPath: string
	workspaceId: string
}

function statusColor(status: ServiceStatus): string {
	switch (status) {
		case "running":
			return "bg-emerald-500"
		case "starting":
			return "bg-yellow-500 animate-pulse"
		case "error":
			return "bg-red-500"
		case "stopping":
			return "bg-yellow-500"
		case "port_conflict":
			return "bg-orange-500"
		default:
			return "bg-muted-foreground/30"
	}
}

function statusLabel(status: ServiceStatus): string {
	switch (status) {
		case "running":
			return "Running"
		case "starting":
			return "Starting..."
		case "error":
			return "Error"
		case "stopping":
			return "Stopping..."
		case "port_conflict":
			return "Port conflict"
		default:
			return "Stopped"
	}
}

// ─── Component ───────────────────────────────────────────────────────────────

export const StackWidget = memo(function StackWidget({
	projectId,
	projectPath,
	workspaceId,
}: StackWidgetProps) {
	// Fetch services from DB
	const { data: services, refetch: refetchServices } =
		trpc.stack.getServices.useQuery(
			{ projectId },
			{ staleTime: 10_000 },
		)

	// Runtime status
	const { data: statusList } = trpc.stack.getStatus.useQuery(
		{ projectId },
		{ refetchInterval: 2000 },
	)

	// Subscribe to status changes
	trpc.stack.onStatusChange.useSubscription(
		{ projectId },
		{
			onData(event) {
				setStatusMap((prev) => {
					const next = new Map(prev)
					next.set(event.serviceId, {
						status: event.status as ServiceStatus,
						error: event.error,
					})
					return next
				})
			},
		},
	)

	// Local status map (updated via subscription)
	const [statusMap, setStatusMap] = useState<
		Map<string, { status: ServiceStatus; error?: string }>
	>(new Map())

	// Sync initial status
	useEffect(() => {
		if (statusList) {
			const map = new Map<string, { status: ServiceStatus; error?: string }>()
			for (const s of statusList) {
				map.set(s.serviceId, {
					status: s.status as ServiceStatus,
					error: s.error,
				})
			}
			setStatusMap(map)
		}
	}, [statusList])

	// Active service (showing terminal)
	const [activeServiceId, setActiveServiceId] = useState<string | null>(null)

	// Mutations
	const startAllMut = trpc.stack.startAll.useMutation()
	const stopAllMut = trpc.stack.stopAll.useMutation()
	const startServiceMut = trpc.stack.startService.useMutation()
	const stopServiceMut = trpc.stack.stopService.useMutation()
	const restartServiceMut = trpc.stack.restartService.useMutation()
	const detectAndSaveMut = trpc.stack.detectAndSave.useMutation({
		onSuccess() {
			refetchServices()
		},
	})

	// Terminal theme
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

	// Auto-detect on first mount if no services
	useEffect(() => {
		if (services && services.length === 0 && projectPath) {
			detectAndSaveMut.mutate({ projectId, projectPath })
		}
	}, [services?.length === 0, projectId, projectPath]) // eslint-disable-line react-hooks/exhaustive-deps

	// ─── Handlers ──────────────────────────────────────────────────────────

	const handleStartAll = useCallback(() => {
		startAllMut.mutate({ projectId })
	}, [projectId, startAllMut])

	const handleStopAll = useCallback(() => {
		stopAllMut.mutate({ projectId })
	}, [projectId, stopAllMut])

	const handleStartService = useCallback(
		(serviceId: string) => {
			startServiceMut.mutate({ projectId, serviceId })
		},
		[projectId, startServiceMut],
	)

	const handleStopService = useCallback(
		(serviceId: string) => {
			stopServiceMut.mutate({ projectId, serviceId })
		},
		[projectId, stopServiceMut],
	)

	const handleRestartService = useCallback(
		(serviceId: string) => {
			restartServiceMut.mutate({ projectId, serviceId })
		},
		[projectId, restartServiceMut],
	)

	const handleReDetect = useCallback(() => {
		detectAndSaveMut.mutate({ projectId, projectPath })
	}, [projectId, projectPath, detectAndSaveMut])

	// ─── Computed ──────────────────────────────────────────────────────────

	const hasAnyRunning = useMemo(() => {
		for (const [, s] of statusMap) {
			if (s.status === "running" || s.status === "starting") return true
		}
		return false
	}, [statusMap])

	// ─── Render ────────────────────────────────────────────────────────────

	if (!services) {
		return (
			<div className="px-2 py-2">
				<div className="text-xs text-muted-foreground">Loading stack...</div>
			</div>
		)
	}

	if (services.length === 0) {
		return (
			<div className="px-2 py-2 flex flex-col gap-1.5">
				<div className="text-xs text-muted-foreground">
					{detectAndSaveMut.isPending
						? "Detecting services..."
						: "No services detected"}
				</div>
				{!detectAndSaveMut.isPending && (
					<Button
						variant="ghost"
						size="sm"
						className="h-6 text-xs w-fit px-2"
						onClick={handleReDetect}
					>
						<RefreshCw className="h-3 w-3 mr-1" />
						Re-detect
					</Button>
				)}
			</div>
		)
	}

	const activeService = activeServiceId
		? services.find((s) => s.id === activeServiceId)
		: null
	const activePaneId = activeServiceId
		? `stack:${projectId}:${activeServiceId}`
		: null

	return (
		<div className="flex flex-col">
			{/* Header actions */}
			<div className="flex items-center gap-1 px-2 py-1 border-b border-border/30">
				{hasAnyRunning ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="sm"
								className="h-6 text-xs px-2 text-red-500 hover:text-red-600"
								onClick={handleStopAll}
								disabled={stopAllMut.isPending}
							>
								<Square className="h-3 w-3 mr-1" />
								Stop All
							</Button>
						</TooltipTrigger>
						<TooltipContent side="bottom">Stop all services</TooltipContent>
					</Tooltip>
				) : (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								variant="ghost"
								size="sm"
								className="h-6 text-xs px-2 text-emerald-500 hover:text-emerald-600"
								onClick={handleStartAll}
								disabled={startAllMut.isPending}
							>
								<Play className="h-3 w-3 mr-1" />
								Start All
							</Button>
						</TooltipTrigger>
						<TooltipContent side="bottom">
							Start all services in dependency order
						</TooltipContent>
					</Tooltip>
				)}

				<div className="flex-1" />

				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="ghost"
							size="icon"
							className="h-5 w-5 p-0 text-muted-foreground hover:text-foreground"
							onClick={handleReDetect}
							disabled={detectAndSaveMut.isPending}
						>
							<RefreshCw
								className={cn(
									"h-3 w-3",
									detectAndSaveMut.isPending && "animate-spin",
								)}
							/>
						</Button>
					</TooltipTrigger>
					<TooltipContent side="bottom">Re-detect services</TooltipContent>
				</Tooltip>
			</div>

			{/* Service list */}
			<div className="px-2 py-1 flex flex-col gap-0.5">
				{services.map((svc) => {
					const runtime = statusMap.get(svc.id)
					const status: ServiceStatus = runtime?.status ?? "stopped"
					const isActive = activeServiceId === svc.id
					const isRunningLike =
						status === "running" ||
						status === "starting" ||
						status === "stopping"

					return (
						<div
							key={svc.id}
							className={cn(
								"flex items-center gap-1.5 min-h-[28px] rounded px-1.5 py-0.5 -ml-0.5 group transition-colors",
								isActive ? "bg-accent" : "hover:bg-accent",
							)}
						>
							{/* Status dot */}
							<div
								className={cn(
									"h-2 w-2 rounded-full shrink-0",
									statusColor(status),
								)}
								title={statusLabel(status)}
							/>

							{/* Service name — click to show/hide terminal */}
							<button
								type="button"
								className="text-xs text-foreground truncate flex-1 text-left"
								onClick={() => {
									if (isRunningLike) {
										setActiveServiceId(isActive ? null : svc.id)
									}
								}}
								title={svc.command}
							>
								{svc.name}
							</button>

							{/* Port badge */}
							{svc.port && (
								<span className="text-[10px] text-muted-foreground/60 tabular-nums">
									:{svc.port}
								</span>
							)}

							{/* Error indicator */}
							{status === "error" && runtime?.error && (
								<Tooltip>
									<TooltipTrigger asChild>
										<AlertTriangle className="h-3 w-3 text-red-500 shrink-0" />
									</TooltipTrigger>
									<TooltipContent side="left" className="max-w-[200px]">
										{runtime.error}
									</TooltipContent>
								</Tooltip>
							)}

							{/* Chevron if terminal available */}
							{isRunningLike && (
								<ChevronDown
									className={cn(
										"h-3 w-3 text-muted-foreground/50 shrink-0 transition-transform duration-150",
										!isActive && "-rotate-90",
									)}
								/>
							)}

							{/* Action buttons */}
							<div className="flex items-center gap-0 opacity-0 group-hover:opacity-100 transition-opacity">
								{isRunningLike ? (
									<>
										<Tooltip>
											<TooltipTrigger asChild>
												<Button
													variant="ghost"
													size="icon"
													className="h-5 w-5 p-0 hover:bg-foreground/10 text-muted-foreground hover:text-foreground rounded-md"
													onClick={(e) => {
														e.stopPropagation()
														handleRestartService(svc.id)
													}}
												>
													<RotateCcw className="h-3 w-3" />
												</Button>
											</TooltipTrigger>
											<TooltipContent side="left">Restart</TooltipContent>
										</Tooltip>
										<Tooltip>
											<TooltipTrigger asChild>
												<Button
													variant="ghost"
													size="icon"
													className="h-5 w-5 p-0 hover:bg-foreground/10 text-muted-foreground hover:text-foreground rounded-md"
													onClick={(e) => {
														e.stopPropagation()
														handleStopService(svc.id)
													}}
												>
													<Square className="h-3 w-3" />
												</Button>
											</TooltipTrigger>
											<TooltipContent side="left">Stop</TooltipContent>
										</Tooltip>
									</>
								) : (
									<Tooltip>
										<TooltipTrigger asChild>
											<Button
												variant="ghost"
												size="icon"
												className="h-5 w-5 p-0 hover:bg-foreground/10 text-muted-foreground hover:text-foreground rounded-md"
												onClick={(e) => {
													e.stopPropagation()
													handleStartService(svc.id)
												}}
											>
												<Play className="h-3 w-3" />
											</Button>
										</TooltipTrigger>
										<TooltipContent side="left">Start</TooltipContent>
									</Tooltip>
								)}
							</div>
						</div>
					)
				})}
			</div>

			{/* Embedded terminal for active service */}
			{activeService && activePaneId && (
				<div
					className="min-h-0 overflow-hidden border-t border-border/30"
					style={{ backgroundColor: terminalBg, height: "200px" }}
				>
					<Terminal
						paneId={activePaneId}
						cwd={projectPath}
						workspaceId={workspaceId}
						initialCwd={projectPath}
					/>
				</div>
			)}
		</div>
	)
})
