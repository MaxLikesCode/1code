import { z } from "zod"
import { router, publicProcedure } from "../index"
import { getDatabase, browserProfiles, browserTabs } from "../../db"
import { eq, asc } from "drizzle-orm"

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
})
