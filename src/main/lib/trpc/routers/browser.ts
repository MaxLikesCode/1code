import { z } from "zod"
import { router, publicProcedure } from "../index"
import { getDatabase, browserProfiles, browserTabs, browserExtensions } from "../../db"
import { eq, asc } from "drizzle-orm"
import { dialog, BrowserWindow, session } from "electron"
import { existsSync } from "node:fs"
import { basename } from "node:path"

/**
 * Load all enabled extensions into a specific browser session partition.
 * Called when a webview with a new partition is about to be created.
 */
async function loadExtensionsIntoSession(partitionName: string) {
  const ses = session.fromPartition(partitionName)
  const db = getDatabase()
  const extensions = db.select().from(browserExtensions).all()
    .filter(ext => ext.enabled)

  const alreadyLoaded = ses.getAllExtensions().map(e => e.path)

  for (const ext of extensions) {
    if (!existsSync(ext.path)) continue
    if (alreadyLoaded.includes(ext.path)) continue
    try {
      await ses.loadExtension(ext.path)
      console.log(`[Browser] Loaded extension "${ext.name}" into ${partitionName}`)
    } catch (err) {
      console.error(`[Browser] Failed to load extension "${ext.name}":`, err)
    }
  }
}

/**
 * Load extensions into all active browser profile sessions.
 */
async function loadExtensionsIntoAllSessions() {
  const db = getDatabase()
  const profiles = db.select().from(browserProfiles).all()
  for (const profile of profiles) {
    await loadExtensionsIntoSession(`persist:browser-${profile.id}`)
  }
}

export const browserRouter = router({
  // ============ PROFILES ============

  listProfiles: publicProcedure.query(() => {
    const db = getDatabase()
    return db.select().from(browserProfiles).orderBy(asc(browserProfiles.createdAt)).all()
  }),

  createProfile: publicProcedure
    .input(z.object({
      name: z.string().min(1),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    }))
    .mutation(({ input }) => {
      const db = getDatabase()
      return db.insert(browserProfiles).values({
        name: input.name,
        color: input.color,
      }).returning().get()
    }),

  updateProfile: publicProcedure
    .input(z.object({
      id: z.string(),
      name: z.string().min(1).optional(),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    }))
    .mutation(({ input }) => {
      const { id, ...updates } = input
      const db = getDatabase()
      return db.update(browserProfiles)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(browserProfiles.id, id))
        .returning()
        .get()
    }),

  deleteProfile: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ input }) => {
      const db = getDatabase()
      db.delete(browserProfiles).where(eq(browserProfiles.id, input.id)).run()
      return { ok: true }
    }),

  // ============ TABS ============

  listTabs: publicProcedure.query(() => {
    const db = getDatabase()
    return db.select().from(browserTabs).orderBy(asc(browserTabs.sortOrder)).all()
  }),

  saveTab: publicProcedure
    .input(z.object({
      id: z.string(),
      profileId: z.string(),
      url: z.string(),
      title: z.string().nullable().optional(),
      sortOrder: z.number().optional(),
    }))
    .mutation(({ input }) => {
      const db = getDatabase()
      const existing = db.select().from(browserTabs).where(eq(browserTabs.id, input.id)).get()
      if (existing) {
        return db.update(browserTabs)
          .set({
            url: input.url,
            title: input.title ?? existing.title,
            profileId: input.profileId,
            sortOrder: input.sortOrder ?? existing.sortOrder,
            updatedAt: new Date(),
          })
          .where(eq(browserTabs.id, input.id))
          .returning()
          .get()
      }
      return db.insert(browserTabs).values({
        id: input.id,
        profileId: input.profileId,
        url: input.url,
        title: input.title,
        sortOrder: input.sortOrder ?? 0,
      }).returning().get()
    }),

  deleteTab: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ input }) => {
      const db = getDatabase()
      db.delete(browserTabs).where(eq(browserTabs.id, input.id)).run()
      return { ok: true }
    }),

  deleteAllTabs: publicProcedure.mutation(() => {
    const db = getDatabase()
    db.delete(browserTabs).run()
    return { ok: true }
  }),

  // ============ EXTENSIONS ============

  listExtensions: publicProcedure.query(() => {
    const db = getDatabase()
    return db.select().from(browserExtensions).orderBy(asc(browserExtensions.createdAt)).all()
  }),

  addExtension: publicProcedure.mutation(async ({ ctx }) => {
    const window = ctx.getWindow?.() ?? BrowserWindow.getFocusedWindow()
    if (!window) return null

    const result = await dialog.showOpenDialog(window, {
      properties: ["openDirectory"],
      title: "Select Unpacked Chrome Extension Folder",
      buttonLabel: "Add Extension",
    })

    if (result.canceled || result.filePaths.length === 0) return null

    const extPath = result.filePaths[0]!

    // Verify it looks like a Chrome extension (has manifest.json)
    const manifestPath = `${extPath}/manifest.json`
    if (!existsSync(manifestPath)) {
      throw new Error("Selected folder is not a valid Chrome extension (no manifest.json found)")
    }

    // Read extension name from manifest
    let extName = basename(extPath)
    try {
      const manifest = JSON.parse(require("node:fs").readFileSync(manifestPath, "utf-8"))
      if (manifest.name) extName = manifest.name
    } catch {
      // Use folder name as fallback
    }

    const db = getDatabase()

    // Check if already added
    const existing = db.select().from(browserExtensions).where(eq(browserExtensions.path, extPath)).get()
    if (existing) return existing

    const ext = db.insert(browserExtensions).values({
      name: extName,
      path: extPath,
      enabled: true,
    }).returning().get()

    // Load into all active browser sessions
    await loadExtensionsIntoAllSessions()

    return ext
  }),

  removeExtension: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const db = getDatabase()
      const ext = db.select().from(browserExtensions).where(eq(browserExtensions.id, input.id)).get()
      if (ext) {
        // Unload from all browser sessions
        const profiles = db.select().from(browserProfiles).all()
        for (const profile of profiles) {
          const ses = session.fromPartition(`persist:browser-${profile.id}`)
          const loaded = ses.getAllExtensions().find(e => e.path === ext.path)
          if (loaded) {
            ses.removeExtension(loaded.id)
          }
        }
      }
      db.delete(browserExtensions).where(eq(browserExtensions.id, input.id)).run()
      return { ok: true }
    }),

  toggleExtension: publicProcedure
    .input(z.object({ id: z.string(), enabled: z.boolean() }))
    .mutation(async ({ input }) => {
      const db = getDatabase()
      const ext = db.update(browserExtensions)
        .set({ enabled: input.enabled })
        .where(eq(browserExtensions.id, input.id))
        .returning()
        .get()

      if (!ext) return null

      const profiles = db.select().from(browserProfiles).all()
      for (const profile of profiles) {
        const ses = session.fromPartition(`persist:browser-${profile.id}`)
        if (input.enabled) {
          // Load extension
          if (existsSync(ext.path)) {
            const alreadyLoaded = ses.getAllExtensions().find(e => e.path === ext.path)
            if (!alreadyLoaded) {
              try {
                await ses.loadExtension(ext.path)
              } catch (err) {
                console.error(`[Browser] Failed to load extension:`, err)
              }
            }
          }
        } else {
          // Unload extension
          const loaded = ses.getAllExtensions().find(e => e.path === ext.path)
          if (loaded) {
            ses.removeExtension(loaded.id)
          }
        }
      }

      return ext
    }),

  // Called from renderer before a webview mounts to ensure extensions are loaded
  ensureExtensions: publicProcedure
    .input(z.object({ profileId: z.string() }))
    .mutation(async ({ input }) => {
      await loadExtensionsIntoSession(`persist:browser-${input.profileId}`)
      return { ok: true }
    }),
})
