import { useState, useCallback, useRef, useEffect } from "react"
import { ArrowLeft, ArrowRight, RotateCw, X, Globe, Code2 } from "lucide-react"
import { Button } from "../../components/ui/button"
import { ProfileBadge } from "./profile-badge"
import type { BrowserTabState } from "./atoms"
import type { BrowserProfile } from "../../../main/lib/db/schema"
import { cn } from "../../lib/utils"

interface BrowserToolbarProps {
  activeTab: BrowserTabState | null
  profiles: BrowserProfile[]
  onBack: () => void
  onForward: () => void
  onRefresh: () => void
  onNavigate: (url: string) => void
  onToggleDevTools: () => void
  onClose: () => void
  onChangeProfile: (profileId: string) => void
  onManageProfiles: () => void
}

export function BrowserToolbar({
  activeTab,
  profiles,
  onBack,
  onForward,
  onRefresh,
  onNavigate,
  onToggleDevTools,
  onClose,
  onChangeProfile,
  onManageProfiles,
}: BrowserToolbarProps) {
  const [urlInput, setUrlInput] = useState(activeTab?.url ?? "")
  const [isFocused, setIsFocused] = useState(false)
  const [showProfileDropdown, setShowProfileDropdown] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Sync URL input with active tab URL when not focused
  useEffect(() => {
    if (!isFocused && activeTab) {
      setUrlInput(activeTab.url)
    }
  }, [activeTab?.url, isFocused, activeTab])

  // Close dropdown on outside click
  useEffect(() => {
    if (!showProfileDropdown) return
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowProfileDropdown(false)
      }
    }
    document.addEventListener("mousedown", handleClick)
    return () => document.removeEventListener("mousedown", handleClick)
  }, [showProfileDropdown])

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault()
    let url = urlInput.trim()
    if (!url) return
    // Auto-add protocol if missing
    if (!/^https?:\/\//i.test(url) && !url.startsWith("file://")) {
      // If it looks like a domain (has a dot), add https://
      if (url.includes(".") || url.startsWith("localhost")) {
        url = `https://${url}`
      } else {
        // Otherwise treat as search (optional: could use a search engine)
        url = `https://${url}`
      }
    }
    onNavigate(url)
    inputRef.current?.blur()
  }, [urlInput, onNavigate])

  const activeProfile = profiles.find(p => p.id === activeTab?.profileId)

  return (
    <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border bg-background flex-shrink-0">
      {/* Navigation buttons */}
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={onBack}
        disabled={!activeTab?.canGoBack}
      >
        <ArrowLeft className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={onForward}
        disabled={!activeTab?.canGoForward}
      >
        <ArrowRight className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={onRefresh}
        disabled={!activeTab}
      >
        <RotateCw className={cn("h-3.5 w-3.5", activeTab?.isLoading && "animate-spin")} />
      </Button>

      {/* URL bar */}
      <form onSubmit={handleSubmit} className="flex-1 mx-1">
        <div className={cn(
          "flex items-center gap-1.5 px-2.5 py-1 rounded-md text-sm transition-colors",
          "bg-muted/50 border border-transparent",
          isFocused && "border-border bg-background ring-1 ring-ring/20",
        )}>
          <Globe className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onFocus={() => {
              setIsFocused(true)
              // Select all text on focus for easy replacement
              setTimeout(() => inputRef.current?.select(), 0)
            }}
            onBlur={() => setIsFocused(false)}
            placeholder="Enter URL..."
            className="flex-1 bg-transparent outline-none text-foreground placeholder:text-muted-foreground text-xs"
            disabled={!activeTab}
          />
        </div>
      </form>

      {/* Profile selector */}
      <div className="relative" ref={dropdownRef}>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={() => setShowProfileDropdown(!showProfileDropdown)}
          disabled={!activeTab}
        >
          {activeProfile ? (
            <ProfileBadge name={activeProfile.name} color={activeProfile.color} size="sm" />
          ) : (
            <span className="text-muted-foreground">No profile</span>
          )}
        </Button>

        {showProfileDropdown && (
          <div className="absolute right-0 top-full mt-1 z-50 min-w-[160px] rounded-md border border-border bg-popover p-1 shadow-md">
            {profiles.map((profile) => (
              <button
                key={profile.id}
                type="button"
                className={cn(
                  "flex items-center gap-2 w-full px-2 py-1.5 rounded-sm text-xs transition-colors",
                  profile.id === activeTab?.profileId
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-accent hover:text-accent-foreground",
                )}
                onClick={() => {
                  onChangeProfile(profile.id)
                  setShowProfileDropdown(false)
                }}
              >
                <ProfileBadge name={profile.name} color={profile.color} size="sm" />
              </button>
            ))}
            <div className="border-t border-border my-1" />
            <button
              type="button"
              className="flex items-center gap-2 w-full px-2 py-1.5 rounded-sm text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
              onClick={() => {
                onManageProfiles()
                setShowProfileDropdown(false)
              }}
            >
              Manage Profiles...
            </button>
          </div>
        )}
      </div>

      {/* DevTools */}
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={onToggleDevTools}
        disabled={!activeTab}
        title="Toggle DevTools"
      >
        <Code2 className="h-3.5 w-3.5" />
      </Button>

      {/* Close browser view */}
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        onClick={onClose}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}
