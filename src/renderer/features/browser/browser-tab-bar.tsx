import { useCallback } from "react"
import { Plus, X } from "lucide-react"
import { cn } from "../../lib/utils"
import type { BrowserTabState } from "./atoms"
import type { BrowserProfile } from "../../../main/lib/db/schema"

interface BrowserTabBarProps {
  tabs: BrowserTabState[]
  activeTabId: string | null
  profiles: BrowserProfile[]
  onSelectTab: (tabId: string) => void
  onCloseTab: (tabId: string) => void
  onNewTab: () => void
}

export function BrowserTabBar({
  tabs,
  activeTabId,
  profiles,
  onSelectTab,
  onCloseTab,
  onNewTab,
}: BrowserTabBarProps) {
  const getProfile = useCallback((profileId: string) => {
    return profiles.find(p => p.id === profileId)
  }, [profiles])

  const getDisplayTitle = useCallback((tab: BrowserTabState) => {
    if (tab.title && tab.title !== tab.url) return tab.title
    try {
      const url = new URL(tab.url)
      return url.hostname + (url.pathname !== "/" ? url.pathname : "")
    } catch {
      return tab.url
    }
  }, [])

  return (
    <div className="flex items-center bg-muted/30 border-b border-border flex-shrink-0 overflow-x-auto scrollbar-none">
      {tabs.map((tab) => {
        const profile = getProfile(tab.profileId)
        const isActive = tab.id === activeTabId
        return (
          <div
            key={tab.id}
            className={cn(
              "group flex items-center gap-1.5 min-w-0 max-w-[200px] px-3 py-1.5 text-xs cursor-pointer border-r border-border transition-colors",
              isActive
                ? "bg-background text-foreground"
                : "text-muted-foreground hover:bg-background/50 hover:text-foreground",
            )}
            onClick={() => onSelectTab(tab.id)}
          >
            {/* Profile color dot */}
            {profile && (
              <div
                className="h-2 w-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: profile.color }}
                title={profile.name}
              />
            )}

            {/* Loading indicator */}
            {tab.isLoading && (
              <div className="h-2 w-2 flex-shrink-0">
                <div className="h-2 w-2 rounded-full border border-muted-foreground/50 border-t-transparent animate-spin" />
              </div>
            )}

            {/* Tab title */}
            <span className="truncate flex-1 select-none">
              {getDisplayTitle(tab)}
            </span>

            {/* Close button */}
            <button
              type="button"
              className={cn(
                "h-4 w-4 flex items-center justify-center rounded-sm flex-shrink-0 transition-opacity",
                isActive ? "opacity-60 hover:opacity-100" : "opacity-0 group-hover:opacity-60 hover:!opacity-100",
              )}
              onClick={(e) => {
                e.stopPropagation()
                onCloseTab(tab.id)
              }}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )
      })}

      {/* New tab button */}
      <button
        type="button"
        className="flex items-center justify-center h-full px-2 py-1.5 text-muted-foreground hover:text-foreground hover:bg-background/50 transition-colors flex-shrink-0"
        onClick={onNewTab}
        title="New tab"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
