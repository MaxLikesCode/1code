import { useState, useCallback } from "react"
import { useAtom } from "jotai"
import { Trash2, Pencil, Plus } from "lucide-react"
import { Button } from "../../components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog"
import { Input } from "../../components/ui/input"
import { Label } from "../../components/ui/label"
import { ProfileBadge } from "./profile-badge"
import { profileManagerOpenAtom } from "./atoms"
import { trpc } from "../../lib/trpc"
import { cn } from "../../lib/utils"

const PRESET_COLORS = [
  "#ef4444", // red
  "#f97316", // orange
  "#eab308", // yellow
  "#22c55e", // green
  "#06b6d4", // cyan
  "#3b82f6", // blue
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#6b7280", // gray
  "#78716c", // stone
]

export function ProfileManager() {
  const [open, setOpen] = useAtom(profileManagerOpenAtom)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState("")
  const [color, setColor] = useState(PRESET_COLORS[5]!)
  const [isCreating, setIsCreating] = useState(false)

  const utils = trpc.useUtils()
  const { data: profiles = [] } = trpc.browser.listProfiles.useQuery()
  const createProfile = trpc.browser.createProfile.useMutation({
    onSuccess: () => utils.browser.listProfiles.invalidate(),
  })
  const updateProfile = trpc.browser.updateProfile.useMutation({
    onSuccess: () => utils.browser.listProfiles.invalidate(),
  })
  const deleteProfile = trpc.browser.deleteProfile.useMutation({
    onSuccess: () => utils.browser.listProfiles.invalidate(),
  })

  const resetForm = useCallback(() => {
    setName("")
    setColor(PRESET_COLORS[5]!)
    setEditingId(null)
    setIsCreating(false)
  }, [])

  const handleSave = useCallback(() => {
    if (!name.trim()) return
    if (editingId) {
      updateProfile.mutate({ id: editingId, name: name.trim(), color })
    } else {
      createProfile.mutate({ name: name.trim(), color })
    }
    resetForm()
  }, [name, color, editingId, createProfile, updateProfile, resetForm])

  const handleEdit = useCallback((profile: { id: string; name: string; color: string }) => {
    setEditingId(profile.id)
    setName(profile.name)
    setColor(profile.color)
    setIsCreating(true)
  }, [])

  const handleDelete = useCallback((id: string) => {
    deleteProfile.mutate({ id })
    if (editingId === id) resetForm()
  }, [deleteProfile, editingId, resetForm])

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) resetForm() }}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>Browser Profiles</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {/* Profile list */}
          {profiles.length > 0 ? (
            <div className="space-y-1">
              {profiles.map((profile) => (
                <div
                  key={profile.id}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted/50 group"
                >
                  <ProfileBadge name={profile.name} color={profile.color} size="md" className="flex-1 min-w-0" />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={() => handleEdit(profile)}
                  >
                    <Pencil className="h-3 w-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity text-destructive"
                    onClick={() => handleDelete(profile.id)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-4">
              No profiles yet. Create one to get started.
            </p>
          )}

          {/* Create/Edit form */}
          {isCreating ? (
            <div className="space-y-3 border-t border-border pt-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Name</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Admin, User, Guest"
                  className="h-8 text-sm"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSave()
                    if (e.key === "Escape") resetForm()
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Color</Label>
                <div className="flex gap-1.5 flex-wrap">
                  {PRESET_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={cn(
                        "h-6 w-6 rounded-full transition-all",
                        color === c ? "ring-2 ring-ring ring-offset-2 ring-offset-background scale-110" : "hover:scale-110",
                      )}
                      style={{ backgroundColor: c }}
                      onClick={() => setColor(c)}
                    />
                  ))}
                </div>
              </div>
              <div className="flex gap-2 justify-end">
                <Button variant="ghost" size="sm" onClick={resetForm}>Cancel</Button>
                <Button size="sm" onClick={handleSave} disabled={!name.trim()}>
                  {editingId ? "Save" : "Create"}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => setIsCreating(true)}
            >
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              New Profile
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
