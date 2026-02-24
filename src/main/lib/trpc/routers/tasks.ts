import fs from "node:fs"
import path from "node:path"
import { z } from "zod"
import { router, publicProcedure } from "../index"

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

export const tasksRouter = router({
	/** Read scripts from package.json in the worktree, with detected package manager */
	getScripts: publicProcedure
		.input(z.object({ worktreePath: z.string() }))
		.query(({ input }) => {
			const pkgPath = path.join(input.worktreePath, "package.json")
			const pm = detectPackageManager(input.worktreePath)

			if (!fs.existsSync(pkgPath)) {
				return { scripts: [] as { name: string; command: string }[], packageManager: pm }
			}

			try {
				const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"))
				const scripts = Object.entries(pkg.scripts || {}).map(
					([name, command]) => ({ name, command: command as string }),
				)
				return { scripts, packageManager: pm }
			} catch {
				return { scripts: [] as { name: string; command: string }[], packageManager: pm }
			}
		}),
})
