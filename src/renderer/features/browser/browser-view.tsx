import { useCallback, useEffect, useRef } from "react"
import { useAtom, useSetAtom } from "jotai"
import { Globe } from "lucide-react"
import { browserActiveTabIdAtom, browserTabsAtom, profileManagerOpenAtom, type BrowserTabState } from "./atoms"
import { BrowserTabBar } from "./browser-tab-bar"
import { BrowserToolbar } from "./browser-toolbar"
import { BrowserWebview, getWebviewForTab } from "./browser-webview"
import { ProfileManager } from "./profile-manager"
import { Button } from "../../components/ui/button"
import { ProfileBadge } from "./profile-badge"
import { trpc } from "../../lib/trpc"
import { desktopViewAtom } from "../agents/atoms"

function createTabId() {
  return `tab-${Date.now().toString(36)}${Math.random().toString(36).substring(2, 8)}`
}

export function BrowserView() {
  const [tabs, setTabs] = useAtom(browserTabsAtom)
  const [activeTabId, setActiveTabId] = useAtom(browserActiveTabIdAtom)
  const setDesktopView = useSetAtom(desktopViewAtom)
  const setProfileManagerOpen = useSetAtom(profileManagerOpenAtom)
  const initializedRef = useRef(false)

  const { data: profiles = [] } = trpc.browser.listProfiles.useQuery()
  const { data: savedTabs = [] } = trpc.browser.listTabs.useQuery()
  const saveTab = trpc.browser.saveTab.useMutation()
  const deleteTabMutation = trpc.browser.deleteTab.useMutation()

  const activeTab = tabs.find(t => t.id === activeTabId) ?? null

  // Restore tabs from DB on first mount
  useEffect(() => {
    if (initializedRef.current || !savedTabs.length || !profiles.length) return
    initializedRef.current = true

    const restored: BrowserTabState[] = savedTabs.map((st) => ({
      id: st.id,
      profileId: st.profileId,
      url: st.url,
      title: st.title ?? st.url,
      canGoBack: false,
      canGoForward: false,
      isLoading: false,
    }))
    setTabs(restored)
    setActiveTabId(restored[0]?.id ?? null)
  }, [savedTabs, profiles, setTabs, setActiveTabId])

  // Save tab state to DB (debounced via effect)
  const saveTabToDb = useCallback((tab: BrowserTabState) => {
    saveTab.mutate({
      id: tab.id,
      profileId: tab.profileId,
      url: tab.url,
      title: tab.title,
      sortOrder: tabs.findIndex(t => t.id === tab.id),
    })
  }, [saveTab, tabs])

  const handleNewTab = useCallback((profileId?: string) => {
    const pid = profileId ?? profiles[0]?.id
    if (!pid) {
      // No profiles - open profile manager
      setProfileManagerOpen(true)
      return
    }
    const id = createTabId()
    const newTab: BrowserTabState = {
      id,
      profileId: pid,
      url: "about:blank",
      title: "New Tab",
      canGoBack: false,
      canGoForward: false,
      isLoading: false,
    }
    setTabs(prev => [...prev, newTab])
    setActiveTabId(id)
    saveTab.mutate({
      id,
      profileId: pid,
      url: "about:blank",
      title: "New Tab",
      sortOrder: tabs.length,
    })
  }, [profiles, setTabs, setActiveTabId, saveTab, tabs.length, setProfileManagerOpen])

  const handleCloseTab = useCallback((tabId: string) => {
    setTabs(prev => {
      const filtered = prev.filter(t => t.id !== tabId)
      // If we closed the active tab, select the previous one
      if (activeTabId === tabId && filtered.length > 0) {
        const closedIndex = prev.findIndex(t => t.id === tabId)
        const newIndex = Math.min(closedIndex, filtered.length - 1)
        setActiveTabId(filtered[newIndex]!.id)
      } else if (filtered.length === 0) {
        setActiveTabId(null)
      }
      return filtered
    })
    deleteTabMutation.mutate({ id: tabId })
  }, [activeTabId, setTabs, setActiveTabId, deleteTabMutation])

  const handleTitleChange = useCallback((tabId: string, title: string) => {
    setTabs(prev => prev.map(t =>
      t.id === tabId ? { ...t, title } : t
    ))
  }, [setTabs])

  const handleUrlChange = useCallback((tabId: string, url: string) => {
    setTabs(prev => {
      const updated = prev.map(t =>
        t.id === tabId ? { ...t, url } : t
      )
      // Save to DB
      const tab = updated.find(t => t.id === tabId)
      if (tab) {
        saveTab.mutate({
          id: tab.id,
          profileId: tab.profileId,
          url: tab.url,
          title: tab.title,
        })
      }
      return updated
    })
  }, [setTabs, saveTab])

  const handleNavigationStateChange = useCallback((tabId: string, canGoBack: boolean, canGoForward: boolean) => {
    setTabs(prev => prev.map(t =>
      t.id === tabId ? { ...t, canGoBack, canGoForward } : t
    ))
  }, [setTabs])

  const handleLoadingChange = useCallback((tabId: string, isLoading: boolean) => {
    setTabs(prev => prev.map(t =>
      t.id === tabId ? { ...t, isLoading } : t
    ))
  }, [setTabs])

  const handleNavigate = useCallback((url: string) => {
    if (!activeTabId) return
    const webview = getWebviewForTab(activeTabId)
    if (webview) {
      webview.loadURL(url)
    }
  }, [activeTabId])

  const handleBack = useCallback(() => {
    if (!activeTabId) return
    const webview = getWebviewForTab(activeTabId)
    if (webview?.canGoBack()) webview.goBack()
  }, [activeTabId])

  const handleForward = useCallback(() => {
    if (!activeTabId) return
    const webview = getWebviewForTab(activeTabId)
    if (webview?.canGoForward()) webview.goForward()
  }, [activeTabId])

  const handleRefresh = useCallback(() => {
    if (!activeTabId) return
    const webview = getWebviewForTab(activeTabId)
    webview?.reload()
  }, [activeTabId])

  const handleToggleDevTools = useCallback(() => {
    if (!activeTabId) return
    const webview = getWebviewForTab(activeTabId)
    if (!webview) return
    if (webview.isDevToolsOpened()) {
      webview.closeDevTools()
    } else {
      webview.openDevTools()
    }
  }, [activeTabId])

  const handleChangeProfile = useCallback((profileId: string) => {
    if (!activeTabId) return
    // Changing profile means we need to recreate the webview with a new partition.
    // We do this by updating the tab's profileId and forcing a remount via key change.
    setTabs(prev => prev.map(t =>
      t.id === activeTabId ? { ...t, profileId } : t
    ))
    const tab = tabs.find(t => t.id === activeTabId)
    if (tab) {
      saveTab.mutate({
        id: tab.id,
        profileId,
        url: tab.url,
        title: tab.title,
      })
    }
  }, [activeTabId, tabs, setTabs, saveTab])

  const handleClose = useCallback(() => {
    setDesktopView(null)
  }, [setDesktopView])

  // Empty state - no tabs open
  if (tabs.length === 0 && profiles.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 text-center p-8">
        <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center">
          <Globe className="h-6 w-6 text-muted-foreground" />
        </div>
        <div>
          <h3 className="text-sm font-medium mb-1">Multi-Profile Browser</h3>
          <p className="text-xs text-muted-foreground max-w-[280px]">
            Create browser profiles with isolated sessions to test the same URL as different users simultaneously.
          </p>
        </div>
        <Button size="sm" onClick={() => setProfileManagerOpen(true)}>
          Create First Profile
        </Button>
        <ProfileManager />
      </div>
    )
  }

  if (tabs.length === 0 && profiles.length > 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 text-center p-8">
        <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center">
          <Globe className="h-6 w-6 text-muted-foreground" />
        </div>
        <div>
          <h3 className="text-sm font-medium mb-1">Open a Browser Tab</h3>
          <p className="text-xs text-muted-foreground max-w-[280px] mb-3">
            Select a profile to open a new browser tab with isolated cookies and sessions.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 justify-center">
          {profiles.map((profile) => (
            <Button
              key={profile.id}
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => handleNewTab(profile.id)}
            >
              <ProfileBadge name={profile.name} color={profile.color} size="sm" />
            </Button>
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="text-xs text-muted-foreground"
          onClick={() => setProfileManagerOpen(true)}
        >
          Manage Profiles...
        </Button>
        <ProfileManager />
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Tab bar */}
      <BrowserTabBar
        tabs={tabs}
        activeTabId={activeTabId}
        profiles={profiles}
        onSelectTab={setActiveTabId}
        onCloseTab={handleCloseTab}
        onNewTab={() => handleNewTab()}
      />

      {/* Toolbar */}
      <BrowserToolbar
        activeTab={activeTab}
        profiles={profiles}
        onBack={handleBack}
        onForward={handleForward}
        onRefresh={handleRefresh}
        onNavigate={handleNavigate}
        onToggleDevTools={handleToggleDevTools}
        onClose={handleClose}
        onChangeProfile={handleChangeProfile}
        onManageProfiles={() => setProfileManagerOpen(true)}
      />

      {/* Webview area */}
      <div className="flex-1 min-h-0 relative">
        {tabs.map((tab) => (
          <div
            key={`${tab.id}-${tab.profileId}`}
            data-browser-tab={tab.id}
            className="absolute inset-0"
            style={{ display: tab.id === activeTabId ? "block" : "none" }}
          >
            <BrowserWebview
              tab={tab}
              isActive={tab.id === activeTabId}
              onTitleChange={handleTitleChange}
              onUrlChange={handleUrlChange}
              onNavigationStateChange={handleNavigationStateChange}
              onLoadingChange={handleLoadingChange}
            />
          </div>
        ))}
      </div>

      {/* Profile manager dialog */}
      <ProfileManager />
    </div>
  )
}
