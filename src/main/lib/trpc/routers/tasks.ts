import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import { router, publicProcedure } from "../index"
import { observable } from "@trpc/server/observable"
import { taskRunner, type TaskEvent } from "../../tasks/task-runner"

export const tasksRouter = router({
	/** Read scripts from package.json in the worktree */
	getScripts: publicProcedure
		.input(z.object({ worktreePath: z.string() }))
		.query(({ input }) => {
			const pkgPath = path.join(input.worktreePath, "package.json")
			if (!fs.existsSync(pkgPath)) {
				return { scripts: [] as { name: string; command: string }[] }
			}

			try {
				const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"))
				const scripts = Object.entries(pkg.scripts || {}).map(
					([name, command]) => ({ name, command: command as string }),
				)
				return { scripts }
			} catch {
				return { scripts: [] as { name: string; command: string }[] }
			}
		}),

	/** Run a package.json script */
	run: publicProcedure
		.input(
			z.object({
				worktreePath: z.string(),
				workspaceId: z.string(),
				scriptName: z.string(),
				command: z.string(),
			}),
		)
		.mutation(({ input }) => {
			const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
			taskRunner.run({
				taskId,
				scriptName: input.scriptName,
				command: input.command,
				worktreePath: input.worktreePath,
				workspaceId: input.workspaceId,
			})
			return { taskId }
		}),

	/** Stop a running task */
	stop: publicProcedure
		.input(z.object({ taskId: z.string() }))
		.mutation(({ input }) => {
			taskRunner.stop(input.taskId)
		}),

	/** List running tasks for a workspace (with buffered logs for reconnection) */
	listRunning: publicProcedure
		.input(z.object({ workspaceId: z.string() }))
		.query(({ input }) => {
			return taskRunner.getRunningTasks(input.workspaceId)
		}),

	/** Stream task output (stdout, stderr, exit) */
	stream: publicProcedure
		.input(z.string())
		.subscription(({ input: taskId }) => {
			return observable<TaskEvent>((emit) => {
				const onData = (event: TaskEvent) => {
					emit.next(event)
				}

				const onExit = (event: TaskEvent) => {
					emit.next(event)
					emit.complete()
				}

				taskRunner.on(`data:${taskId}`, onData)
				taskRunner.on(`exit:${taskId}`, onExit)

				return () => {
					taskRunner.off(`data:${taskId}`, onData)
					taskRunner.off(`exit:${taskId}`, onExit)
				}
			})
		}),
})
