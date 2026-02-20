import { EventEmitter } from "node:events"
import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

export interface TaskEvent {
	type: "stdout" | "stderr" | "exit"
	data?: string
	exitCode?: number | null
	signal?: string | null
}

interface RunningTask {
	taskId: string
	scriptName: string
	command: string
	workspaceId: string
	worktreePath: string
	process: ChildProcess
	startedAt: number
	isAlive: boolean
	logBuffer: string[]
}

const MAX_LOG_LINES = 500

function detectPackageManager(worktreePath: string): string {
	if (
		fs.existsSync(path.join(worktreePath, "bun.lockb")) ||
		fs.existsSync(path.join(worktreePath, "bun.lock"))
	)
		return "bun"
	if (fs.existsSync(path.join(worktreePath, "pnpm-lock.yaml"))) return "pnpm"
	if (fs.existsSync(path.join(worktreePath, "yarn.lock"))) return "yarn"
	return "npm"
}

export class TaskRunner extends EventEmitter {
	private tasks = new Map<string, RunningTask>()

	run(params: {
		taskId: string
		scriptName: string
		command: string
		worktreePath: string
		workspaceId: string
	}): void {
		const { taskId, scriptName, command, worktreePath, workspaceId } = params

		const pm = detectPackageManager(worktreePath)
		const child = spawn(pm, ["run", scriptName], {
			cwd: worktreePath,
			env: { ...process.env, FORCE_COLOR: "1" },
			shell: true,
			stdio: ["ignore", "pipe", "pipe"],
		})

		const task: RunningTask = {
			taskId,
			scriptName,
			command,
			workspaceId,
			worktreePath,
			process: child,
			startedAt: Date.now(),
			isAlive: true,
			logBuffer: [],
		}
		this.tasks.set(taskId, task)

		const appendLog = (line: string) => {
			task.logBuffer.push(line)
			if (task.logBuffer.length > MAX_LOG_LINES) {
				task.logBuffer.splice(0, task.logBuffer.length - MAX_LOG_LINES)
			}
		}

		child.stdout?.on("data", (data: Buffer) => {
			const str = data.toString()
			appendLog(str)
			this.emit(`data:${taskId}`, { type: "stdout", data: str } satisfies TaskEvent)
		})

		child.stderr?.on("data", (data: Buffer) => {
			const str = data.toString()
			appendLog(str)
			this.emit(`data:${taskId}`, { type: "stderr", data: str } satisfies TaskEvent)
		})

		child.on("exit", (exitCode, signal) => {
			task.isAlive = false
			this.emit(`exit:${taskId}`, {
				type: "exit",
				exitCode,
				signal: signal ?? null,
			} satisfies TaskEvent)
		})

		child.on("error", (err) => {
			task.isAlive = false
			const errMsg = err.message
			appendLog(errMsg)
			this.emit(`data:${taskId}`, { type: "stderr", data: errMsg } satisfies TaskEvent)
			this.emit(`exit:${taskId}`, {
				type: "exit",
				exitCode: 1,
				signal: null,
			} satisfies TaskEvent)
		})
	}

	stop(taskId: string): void {
		const task = this.tasks.get(taskId)
		if (!task || !task.isAlive) return

		task.process.kill("SIGTERM")
		// Escalate to SIGKILL after 3 seconds
		setTimeout(() => {
			if (task.isAlive) {
				task.process.kill("SIGKILL")
			}
		}, 3000)
	}

	getRunningTasks(
		workspaceId: string,
	): Array<{
		taskId: string
		scriptName: string
		startedAt: number
		logBuffer: string[]
	}> {
		return Array.from(this.tasks.values())
			.filter((t) => t.workspaceId === workspaceId && t.isAlive)
			.map(({ taskId, scriptName, startedAt, logBuffer }) => ({
				taskId,
				scriptName,
				startedAt,
				logBuffer: logBuffer.slice(),
			}))
	}

	getTaskLogs(taskId: string): string[] {
		return this.tasks.get(taskId)?.logBuffer.slice() ?? []
	}

	cleanup(): void {
		for (const [, task] of this.tasks) {
			if (task.isAlive) task.process.kill("SIGKILL")
		}
		this.tasks.clear()
	}
}

export const taskRunner = new TaskRunner()
