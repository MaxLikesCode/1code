import path from "node:path"
import { z } from "zod"
import { eq } from "drizzle-orm"
import { router, publicProcedure } from "../index"
import { observable } from "@trpc/server/observable"
import { getDatabase, stackServices, projects } from "../../db"
import { createId } from "../../db/utils"
import { autoDetectServices, detectPackageManager } from "../../stack/auto-detect"
import {
	stackProcessManager,
	type StatusChangeEvent,
	type LogEvent,
} from "../../stack/process-manager"

function resolveServiceCwd(projectPath: string, cwd?: string | null): string {
	if (!cwd || cwd === ".") return projectPath
	if (cwd.startsWith("/")) return cwd
	return path.resolve(projectPath, cwd)
}

function getProjectPath(projectId: string): string | null {
	const db = getDatabase()
	const project = db
		.select({ path: projects.path })
		.from(projects)
		.where(eq(projects.id, projectId))
		.get()
	return project?.path ?? null
}

/**
 * Register services from DB into the process manager for a project.
 */
function syncServicesToProcessManager(projectId: string) {
	const db = getDatabase()
	const projectPath = getProjectPath(projectId)
	if (!projectPath) return

	const services = db
		.select()
		.from(stackServices)
		.where(eq(stackServices.projectId, projectId))
		.all()

	stackProcessManager.registerServices(
		projectId,
		services.map((s) => ({
			id: s.id,
			name: s.name,
			command: s.command,
			cwd: resolveServiceCwd(projectPath, s.cwd),
			dependsOn: s.dependsOn ? JSON.parse(s.dependsOn) : [],
			healthCheck: s.healthCheck ?? undefined,
			port: s.port ?? undefined,
		})),
	)
}

export const stackRouter = router({
	// ─── Queries ──────────────────────────────────────────────────────────

	/** Get all services for a project */
	getServices: publicProcedure
		.input(z.object({ projectId: z.string() }))
		.query(({ input }) => {
			const db = getDatabase()
			const services = db
				.select()
				.from(stackServices)
				.where(eq(stackServices.projectId, input.projectId))
				.all()

			return services.map((s) => ({
				...s,
				dependsOn: s.dependsOn ? JSON.parse(s.dependsOn) as string[] : [],
				env: s.env ? JSON.parse(s.env) as Record<string, string> : {},
			}))
		}),

	/** Get runtime status for all services */
	getStatus: publicProcedure
		.input(z.object({ projectId: z.string() }))
		.query(({ input }) => {
			return stackProcessManager.getStatus(input.projectId)
		}),

	/** Auto-detect services from project files */
	autoDetect: publicProcedure
		.input(z.object({ projectPath: z.string() }))
		.query(({ input }) => {
			const detected = autoDetectServices(input.projectPath)
			const pm = detectPackageManager(input.projectPath)
			return { services: detected, packageManager: pm }
		}),

	/** Get buffered logs for a service */
	getLogs: publicProcedure
		.input(z.object({ projectId: z.string(), serviceId: z.string() }))
		.query(({ input }) => {
			return stackProcessManager.getLogs(input.projectId, input.serviceId)
		}),

	// ─── Mutations ────────────────────────────────────────────────────────

	/** Save services for a project (replace all auto-detected, keep manual) */
	saveServices: publicProcedure
		.input(
			z.object({
				projectId: z.string(),
				services: z.array(
					z.object({
						id: z.string().optional(),
						name: z.string(),
						command: z.string(),
						cwd: z.string().optional(),
						env: z.record(z.string()).optional(),
						dependsOn: z.array(z.string()).optional(),
						healthCheck: z.string().optional(),
						port: z.number().optional(),
						sortOrder: z.number().optional(),
						source: z.enum(["auto", "manual"]).optional(),
						autoSource: z.string().optional(),
					}),
				),
			}),
		)
		.mutation(({ input }) => {
			const db = getDatabase()
			const now = new Date()

			// Delete existing auto-detected services
			const existing = db
				.select()
				.from(stackServices)
				.where(eq(stackServices.projectId, input.projectId))
				.all()

			for (const svc of existing) {
				if (svc.source === "auto") {
					db.delete(stackServices).where(eq(stackServices.id, svc.id)).run()
				}
			}

			// Insert new services
			for (let i = 0; i < input.services.length; i++) {
				const svc = input.services[i]
				db.insert(stackServices)
					.values({
						id: svc.id || createId(),
						projectId: input.projectId,
						name: svc.name,
						command: svc.command,
						cwd: svc.cwd || ".",
						env: svc.env ? JSON.stringify(svc.env) : null,
						dependsOn: svc.dependsOn?.length
							? JSON.stringify(svc.dependsOn)
							: null,
						healthCheck: svc.healthCheck || null,
						port: svc.port || null,
						sortOrder: svc.sortOrder ?? i,
						source: svc.source || "auto",
						autoSource: svc.autoSource || null,
						createdAt: now,
						updatedAt: now,
					})
					.run()
			}

			// Re-sync process manager
			syncServicesToProcessManager(input.projectId)

			return { success: true }
		}),

	/** Add a single manual service */
	addService: publicProcedure
		.input(
			z.object({
				projectId: z.string(),
				name: z.string(),
				command: z.string(),
				cwd: z.string().optional(),
				dependsOn: z.array(z.string()).optional(),
				healthCheck: z.string().optional(),
				port: z.number().optional(),
			}),
		)
		.mutation(({ input }) => {
			const db = getDatabase()
			const now = new Date()

			// Get max sort order
			const existing = db
				.select()
				.from(stackServices)
				.where(eq(stackServices.projectId, input.projectId))
				.all()
			const maxOrder = Math.max(0, ...existing.map((s) => s.sortOrder ?? 0))

			const id = createId()
			db.insert(stackServices)
				.values({
					id,
					projectId: input.projectId,
					name: input.name,
					command: input.command,
					cwd: input.cwd || ".",
					dependsOn: input.dependsOn?.length
						? JSON.stringify(input.dependsOn)
						: null,
					healthCheck: input.healthCheck || null,
					port: input.port || null,
					sortOrder: maxOrder + 1,
					source: "manual",
					createdAt: now,
					updatedAt: now,
				})
				.run()

			syncServicesToProcessManager(input.projectId)
			return { id }
		}),

	/** Remove a service */
	removeService: publicProcedure
		.input(z.object({ serviceId: z.string(), projectId: z.string() }))
		.mutation(async ({ input }) => {
			const db = getDatabase()

			// Stop if running
			await stackProcessManager.stopService(input.projectId, input.serviceId)

			db.delete(stackServices)
				.where(eq(stackServices.id, input.serviceId))
				.run()

			syncServicesToProcessManager(input.projectId)
			return { success: true }
		}),

	/** Start all services */
	startAll: publicProcedure
		.input(z.object({ projectId: z.string() }))
		.mutation(async ({ input }) => {
			const projectPath = getProjectPath(input.projectId)
			if (!projectPath) return { success: false, error: "Project not found" }

			syncServicesToProcessManager(input.projectId)
			await stackProcessManager.startAll(input.projectId, projectPath)
			return { success: true }
		}),

	/** Stop all services */
	stopAll: publicProcedure
		.input(z.object({ projectId: z.string() }))
		.mutation(async ({ input }) => {
			await stackProcessManager.stopAll(input.projectId)
			return { success: true }
		}),

	/** Start a single service */
	startService: publicProcedure
		.input(z.object({ projectId: z.string(), serviceId: z.string() }))
		.mutation(async ({ input }) => {
			const projectPath = getProjectPath(input.projectId)
			if (!projectPath) return { success: false, error: "Project not found" }

			syncServicesToProcessManager(input.projectId)
			await stackProcessManager.startService(
				input.projectId,
				input.serviceId,
				projectPath,
			)
			return { success: true }
		}),

	/** Stop a single service */
	stopService: publicProcedure
		.input(z.object({ projectId: z.string(), serviceId: z.string() }))
		.mutation(async ({ input }) => {
			await stackProcessManager.stopService(input.projectId, input.serviceId)
			return { success: true }
		}),

	/** Restart a single service */
	restartService: publicProcedure
		.input(z.object({ projectId: z.string(), serviceId: z.string() }))
		.mutation(async ({ input }) => {
			const projectPath = getProjectPath(input.projectId)
			if (!projectPath) return { success: false, error: "Project not found" }

			syncServicesToProcessManager(input.projectId)
			await stackProcessManager.restartService(
				input.projectId,
				input.serviceId,
				projectPath,
			)
			return { success: true }
		}),

	/** Detect and save services for a project (auto-detect + merge with existing manual) */
	detectAndSave: publicProcedure
		.input(z.object({ projectId: z.string(), projectPath: z.string() }))
		.mutation(({ input }) => {
			const detected = autoDetectServices(input.projectPath)
			const db = getDatabase()
			const now = new Date()

			// Remove old auto-detected services
			const existing = db
				.select()
				.from(stackServices)
				.where(eq(stackServices.projectId, input.projectId))
				.all()

			for (const svc of existing) {
				if (svc.source === "auto") {
					db.delete(stackServices).where(eq(stackServices.id, svc.id)).run()
				}
			}

			// Get manual services for sort order offset
			const manualCount = existing.filter((s) => s.source === "manual").length

			// Insert detected services
			for (let i = 0; i < detected.length; i++) {
				const svc = detected[i]
				db.insert(stackServices)
					.values({
						id: createId(),
						projectId: input.projectId,
						name: svc.name,
						command: svc.command,
						cwd: svc.cwd || ".",
						dependsOn: svc.dependsOn?.length
							? JSON.stringify(svc.dependsOn)
							: null,
						port: svc.port || null,
						sortOrder: manualCount + i,
						source: "auto",
						autoSource: svc.autoSource,
						createdAt: now,
						updatedAt: now,
					})
					.run()
			}

			syncServicesToProcessManager(input.projectId)

			return { detectedCount: detected.length }
		}),

	// ─── Subscriptions ────────────────────────────────────────────────────

	/** Subscribe to status changes for a project's services */
	onStatusChange: publicProcedure
		.input(z.object({ projectId: z.string() }))
		.subscription(({ input }) => {
			return observable<StatusChangeEvent>((emit) => {
				const handler = (event: StatusChangeEvent) => {
					emit.next(event)
				}
				stackProcessManager.on(`status:${input.projectId}`, handler)
				return () => {
					stackProcessManager.off(`status:${input.projectId}`, handler)
				}
			})
		}),

	/** Subscribe to log output for a project's services */
	onLog: publicProcedure
		.input(z.object({ projectId: z.string() }))
		.subscription(({ input }) => {
			return observable<LogEvent>((emit) => {
				const handler = (event: LogEvent) => {
					emit.next(event)
				}
				stackProcessManager.on(`log:${input.projectId}`, handler)
				return () => {
					stackProcessManager.off(`log:${input.projectId}`, handler)
				}
			})
		}),
})
