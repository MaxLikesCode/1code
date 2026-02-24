/**
 * Stack Process Manager — spawns, tracks, and stops service processes.
 * Uses the existing terminalManager for PTY sessions.
 */

import { EventEmitter } from "node:events"
import net from "node:net"
import { exec } from "node:child_process"
import path from "node:path"
import { terminalManager } from "../terminal/manager"
import {
	topologicalSort,
	getStartWaves,
	getStopOrder,
	CircularDependencyError,
	type ServiceNode,
} from "./orchestrator"

// ─── Types ───────────────────────────────────────────────────────────────────

export type ServiceStatus =
	| "stopped"
	| "starting"
	| "running"
	| "error"
	| "stopping"
	| "port_conflict"

export interface ServiceRuntime {
	serviceId: string
	name: string
	command: string
	cwd: string
	dependsOn: string[]
	healthCheck?: string
	port?: number
	status: ServiceStatus
	paneId: string
	error?: string
	logs: string[]
}

export interface StatusChangeEvent {
	serviceId: string
	name: string
	status: ServiceStatus
	error?: string
	port?: number
}

export interface LogEvent {
	serviceId: string
	line: string
	timestamp: number
}

const MAX_LOG_LINES = 5000
const HEALTH_CHECK_INTERVAL_MS = 2000
const HEALTH_CHECK_TIMEOUT_MS = 60000
const DEFAULT_START_DELAY_MS = 2000
const SIGINT_TIMEOUT_MS = 5000
const SIGTERM_TIMEOUT_MS = 3000

// ─── Stack Process Manager ───────────────────────────────────────────────────

export class StackProcessManager extends EventEmitter {
	/** projectId → Map<serviceId, ServiceRuntime> */
	private stacks = new Map<string, Map<string, ServiceRuntime>>()
	/** paneId → data listener cleanup */
	private dataListeners = new Map<string, () => void>()
	/** serviceId → health check timer */
	private healthTimers = new Map<string, NodeJS.Timeout>()

	// ─── Service Registration ──────────────────────────────────────────────

	/**
	 * Register services for a project (does not start them).
	 */
	registerServices(
		projectId: string,
		services: Array<{
			id: string
			name: string
			command: string
			cwd: string
			dependsOn: string[]
			healthCheck?: string
			port?: number
		}>,
	) {
		const map = new Map<string, ServiceRuntime>()
		for (const svc of services) {
			const paneId = `stack:${projectId}:${svc.id}`

			map.set(svc.id, {
				serviceId: svc.id,
				name: svc.name,
				command: svc.command,
				cwd: svc.cwd,
				dependsOn: svc.dependsOn,
				healthCheck: svc.healthCheck,
				port: svc.port,
				status: "stopped",
				paneId,
				logs: [],
			})
		}
		this.stacks.set(projectId, map)
	}

	/**
	 * Get runtime status for all services of a project.
	 */
	getStatus(projectId: string): StatusChangeEvent[] {
		const map = this.stacks.get(projectId)
		if (!map) return []

		return Array.from(map.values()).map((rt) => ({
			serviceId: rt.serviceId,
			name: rt.name,
			status: rt.status,
			error: rt.error,
			port: rt.port,
		}))
	}

	/**
	 * Get buffered log lines for a service.
	 */
	getLogs(projectId: string, serviceId: string): string[] {
		return this.stacks.get(projectId)?.get(serviceId)?.logs ?? []
	}

	// ─── Start / Stop ──────────────────────────────────────────────────────

	/**
	 * Start all services in dependency order.
	 */
	async startAll(projectId: string, projectPath: string) {
		const map = this.stacks.get(projectId)
		if (!map) return

		const services = Array.from(map.values())
		const nodes: ServiceNode[] = services.map((s) => ({
			name: s.name,
			dependsOn: s.dependsOn,
		}))

		let waves: string[][]
		try {
			waves = getStartWaves(nodes)
		} catch (err) {
			if (err instanceof CircularDependencyError) {
				// Mark all cycle services as error
				for (const name of err.cycle) {
					const svc = services.find((s) => s.name === name)
					if (svc) this.setStatus(projectId, svc.serviceId, "error", "Circular dependency")
				}
				return
			}
			throw err
		}

		// Start wave by wave
		for (const wave of waves) {
			const waveServices = wave
				.map((name) => services.find((s) => s.name === name))
				.filter(Boolean) as ServiceRuntime[]

			// Start all services in this wave in parallel
			await Promise.all(
				waveServices.map((svc) =>
					this.startService(projectId, svc.serviceId, projectPath),
				),
			)

			// Wait for all services in this wave to be ready before next wave
			await Promise.all(
				waveServices.map((svc) => this.waitForReady(svc)),
			)
		}
	}

	/**
	 * Stop all services in reverse dependency order.
	 */
	async stopAll(projectId: string) {
		const map = this.stacks.get(projectId)
		if (!map) return

		const services = Array.from(map.values())
		const nodes: ServiceNode[] = services.map((s) => ({
			name: s.name,
			dependsOn: s.dependsOn,
		}))

		let stopOrder: string[]
		try {
			stopOrder = getStopOrder(nodes)
		} catch {
			// If cycle, just stop all in any order
			stopOrder = services.map((s) => s.name)
		}

		for (const name of stopOrder) {
			const svc = services.find((s) => s.name === name)
			if (svc && (svc.status === "running" || svc.status === "starting")) {
				await this.stopService(projectId, svc.serviceId)
			}
		}
	}

	/**
	 * Start a single service.
	 */
	async startService(
		projectId: string,
		serviceId: string,
		projectPath: string,
	) {
		const svc = this.stacks.get(projectId)?.get(serviceId)
		if (!svc) return

		// Port conflict check
		if (svc.port) {
			const isFree = await isPortFree(svc.port)
			if (!isFree) {
				this.setStatus(projectId, serviceId, "port_conflict", `Port ${svc.port} is already in use`)
				return
			}
		}

		this.setStatus(projectId, serviceId, "starting")
		svc.logs = []

		// Resolve working directory
		const cwd = svc.cwd.startsWith("/")
			? svc.cwd
			: path.resolve(projectPath, svc.cwd)

		// Create terminal session that runs the command
		const paneId = svc.paneId
		try {
			await terminalManager.createOrAttach({
				paneId,
				workspaceId: projectId,
				cols: 120,
				rows: 40,
				cwd,
				initialCommands: [svc.command],
			})
		} catch (err) {
			this.setStatus(
				projectId,
				serviceId,
				"error",
				err instanceof Error ? err.message : "Failed to start",
			)
			return
		}

		// Listen for output
		this.attachLogListener(projectId, serviceId, paneId)

		// Listen for exit
		const onExit = () => {
			if (svc.status === "stopping") {
				this.setStatus(projectId, serviceId, "stopped")
			} else if (svc.status === "starting" || svc.status === "running") {
				this.setStatus(projectId, serviceId, "error", "Process exited unexpectedly")
			}
			this.detachLogListener(paneId)
			terminalManager.off(`exit:${paneId}`, onExit)
		}
		terminalManager.on(`exit:${paneId}`, onExit)

		// If no health check, transition to running after a short delay
		if (!svc.healthCheck) {
			setTimeout(() => {
				if (svc.status === "starting") {
					this.setStatus(projectId, serviceId, "running")
				}
			}, DEFAULT_START_DELAY_MS)
		} else {
			this.startHealthCheck(projectId, serviceId, svc.healthCheck)
		}
	}

	/**
	 * Stop a single service with graceful shutdown.
	 */
	async stopService(projectId: string, serviceId: string) {
		const svc = this.stacks.get(projectId)?.get(serviceId)
		if (!svc) return
		if (svc.status === "stopped" || svc.status === "stopping") return

		this.stopHealthCheck(serviceId)
		this.setStatus(projectId, serviceId, "stopping")

		// SIGINT first
		terminalManager.signal({ paneId: svc.paneId, signal: "SIGINT" })

		const stopped = await this.waitForExit(svc.paneId, SIGINT_TIMEOUT_MS)
		if (stopped) {
			this.setStatus(projectId, serviceId, "stopped")
			this.detachLogListener(svc.paneId)
			return
		}

		// SIGTERM
		terminalManager.signal({ paneId: svc.paneId, signal: "SIGTERM" })

		const stopped2 = await this.waitForExit(svc.paneId, SIGTERM_TIMEOUT_MS)
		if (stopped2) {
			this.setStatus(projectId, serviceId, "stopped")
			this.detachLogListener(svc.paneId)
			return
		}

		// Force kill
		await terminalManager.kill({ paneId: svc.paneId })
		this.setStatus(projectId, serviceId, "stopped")
		this.detachLogListener(svc.paneId)
	}

	/**
	 * Restart a single service.
	 */
	async restartService(
		projectId: string,
		serviceId: string,
		projectPath: string,
	) {
		await this.stopService(projectId, serviceId)
		await this.startService(projectId, serviceId, projectPath)
	}

	// ─── Cleanup ───────────────────────────────────────────────────────────

	/**
	 * Stop all services and clean up all state for a project.
	 */
	async cleanup(projectId: string) {
		await this.stopAll(projectId)
		this.stacks.delete(projectId)
	}

	// ─── Internal Helpers ──────────────────────────────────────────────────

	private setStatus(
		projectId: string,
		serviceId: string,
		status: ServiceStatus,
		error?: string,
	) {
		const svc = this.stacks.get(projectId)?.get(serviceId)
		if (!svc) return

		svc.status = status
		svc.error = error

		const event: StatusChangeEvent = {
			serviceId,
			name: svc.name,
			status,
			error,
			port: svc.port,
		}

		this.emit(`status:${projectId}`, event)
	}

	private attachLogListener(
		projectId: string,
		serviceId: string,
		paneId: string,
	) {
		// Remove existing listener if any
		this.detachLogListener(paneId)

		const onData = (data: string) => {
			const svc = this.stacks.get(projectId)?.get(serviceId)
			if (!svc) return

			// Append to ring buffer
			const lines = data.split("\n")
			svc.logs.push(...lines)
			if (svc.logs.length > MAX_LOG_LINES) {
				svc.logs.splice(0, svc.logs.length - MAX_LOG_LINES)
			}

			// Emit log event
			const event: LogEvent = {
				serviceId,
				line: data,
				timestamp: Date.now(),
			}
			this.emit(`log:${projectId}`, event)
		}

		terminalManager.on(`data:${paneId}`, onData)
		this.dataListeners.set(paneId, () => {
			terminalManager.off(`data:${paneId}`, onData)
		})
	}

	private detachLogListener(paneId: string) {
		const cleanup = this.dataListeners.get(paneId)
		if (cleanup) {
			cleanup()
			this.dataListeners.delete(paneId)
		}
	}

	private startHealthCheck(
		projectId: string,
		serviceId: string,
		command: string,
	) {
		const startTime = Date.now()

		const check = () => {
			const svc = this.stacks.get(projectId)?.get(serviceId)
			if (!svc || svc.status !== "starting") {
				this.stopHealthCheck(serviceId)
				return
			}

			// Timeout
			if (Date.now() - startTime > HEALTH_CHECK_TIMEOUT_MS) {
				this.setStatus(projectId, serviceId, "error", "Health check timeout")
				this.stopHealthCheck(serviceId)
				return
			}

			exec(command, { timeout: 5000 }, (error) => {
				if (!error) {
					this.setStatus(projectId, serviceId, "running")
					this.stopHealthCheck(serviceId)
				}
				// If error, just wait for next check
			})
		}

		const timer = setInterval(check, HEALTH_CHECK_INTERVAL_MS)
		this.healthTimers.set(serviceId, timer)

		// Also run immediately
		check()
	}

	private stopHealthCheck(serviceId: string) {
		const timer = this.healthTimers.get(serviceId)
		if (timer) {
			clearInterval(timer)
			this.healthTimers.delete(serviceId)
		}
	}

	private waitForReady(svc: ServiceRuntime): Promise<void> {
		if (svc.status === "running" || svc.status === "error" || svc.status === "port_conflict") {
			return Promise.resolve()
		}

		return new Promise((resolve) => {
			const onStatus = (event: StatusChangeEvent) => {
				if (
					event.serviceId === svc.serviceId &&
					(event.status === "running" ||
						event.status === "error" ||
						event.status === "port_conflict")
				) {
					this.off(`status:${svc.paneId}`, onStatus)
					resolve()
				}
			}

			// Listen on the correct project event
			// We need the projectId, which we can extract from the paneId
			const projectId = svc.paneId.split(":")[1]
			const handler = (event: StatusChangeEvent) => {
				if (
					event.serviceId === svc.serviceId &&
					(event.status === "running" ||
						event.status === "error" ||
						event.status === "port_conflict" ||
						event.status === "stopped")
				) {
					this.off(`status:${projectId}`, handler)
					resolve()
				}
			}
			this.on(`status:${projectId}`, handler)

			// Safety timeout — don't wait forever
			setTimeout(() => {
				this.off(`status:${projectId}`, handler)
				resolve()
			}, HEALTH_CHECK_TIMEOUT_MS + 5000)
		})
	}

	private waitForExit(paneId: string, timeoutMs: number): Promise<boolean> {
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				terminalManager.off(`exit:${paneId}`, onExit)
				resolve(false)
			}, timeoutMs)

			const onExit = () => {
				clearTimeout(timer)
				terminalManager.off(`exit:${paneId}`, onExit)
				resolve(true)
			}

			// Check if already dead
			const session = terminalManager.getSession(paneId)
			if (!session || !session.isAlive) {
				clearTimeout(timer)
				resolve(true)
				return
			}

			terminalManager.on(`exit:${paneId}`, onExit)
		})
	}
}

// ─── Port Check Utility ──────────────────────────────────────────────────────

function isPortFree(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = net.createServer()
		server.once("error", () => resolve(false))
		server.once("listening", () => {
			server.close(() => resolve(true))
		})
		server.listen(port, "127.0.0.1")
	})
}

// ─── Singleton ───────────────────────────────────────────────────────────────

export const stackProcessManager = new StackProcessManager()
