import { useCallback } from "react"
import { useAtom } from "jotai"
import { Trash2, Plus, Power, PowerOff } from "lucide-react"
import { Button } from "../../components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog"
import { extensionManagerOpenAtom } from "./atoms"
import { trpc } from "../../lib/trpc"
import { cn } from "../../lib/utils"

export function ExtensionManager() {
  const [open, setOpen] = useAtom(extensionManagerOpenAtom)

  const utils = trpc.useUtils()
  const { data: extensions = [] } = trpc.browser.listExtensions.useQuery()
  const addExtension = trpc.browser.addExtension.useMutation({
    onSuccess: () => utils.browser.listExtensions.invalidate(),
  })
  const removeExtension = trpc.browser.removeExtension.useMutation({
    onSuccess: () => utils.browser.listExtensions.invalidate(),
  })
  const toggleExtension = trpc.browser.toggleExtension.useMutation({
    onSuccess: () => utils.browser.listExtensions.invalidate(),
  })

  const handleAdd = useCallback(() => {
    addExtension.mutate()
  }, [addExtension])

  const handleRemove = useCallback((id: string) => {
    removeExtension.mutate({ id })
  }, [removeExtension])

  const handleToggle = useCallback((id: string, currentEnabled: boolean) => {
    toggleExtension.mutate({ id, enabled: !currentEnabled })
  }, [toggleExtension])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>Browser Extensions</DialogTitle>
        </DialogHeader>

        <p className="text-xs text-muted-foreground -mt-1">
          Add Chrome extensions (unpacked). Extensions are loaded into all browser profiles.
        </p>

        <div className="space-y-3">
          {extensions.length > 0 ? (
            <div className="space-y-1">
              {extensions.map((ext) => (
                <div
                  key={ext.id}
                  className="flex items-center gap-2 px-2 py-2 rounded-md hover:bg-muted/50 group"
                >
                  <div className="flex-1 min-w-0">
                    <div className={cn(
                      "text-sm truncate",
                      !ext.enabled && "text-muted-foreground",
                    )}>
                      {ext.name}
                    </div>
                    <div className="text-[10px] text-muted-foreground truncate">
                      {ext.path}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 flex-shrink-0"
                    onClick={() => handleToggle(ext.id, ext.enabled)}
                    title={ext.enabled ? "Disable" : "Enable"}
                  >
                    {ext.enabled ? (
                      <Power className="h-3 w-3 text-green-500" />
                    ) : (
                      <PowerOff className="h-3 w-3 text-muted-foreground" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-destructive"
                    onClick={() => handleRemove(ext.id)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-6">
              <p className="text-sm text-muted-foreground mb-1">No extensions installed</p>
              <p className="text-xs text-muted-foreground">
                Add an unpacked Chrome extension folder to enable it in browser tabs.
              </p>
            </div>
          )}

          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={handleAdd}
            disabled={addExtension.isPending}
          >
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            {addExtension.isPending ? "Selecting..." : "Add Extension Folder"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
