import { useEffect, useRef, useCallback } from "react"
import type { BrowserTabState } from "./atoms"

interface BrowserWebviewProps {
  tab: BrowserTabState
  isActive: boolean
  onTitleChange: (tabId: string, title: string) => void
  onUrlChange: (tabId: string, url: string) => void
  onNavigationStateChange: (tabId: string, canGoBack: boolean, canGoForward: boolean) => void
  onLoadingChange: (tabId: string, isLoading: boolean) => void
}

export function BrowserWebview({
  tab,
  isActive,
  onTitleChange,
  onUrlChange,
  onNavigationStateChange,
  onLoadingChange,
}: BrowserWebviewProps) {
  const webviewRef = useRef<Electron.WebviewTag | null>(null)
  const initialUrlRef = useRef(tab.url)

  const setupWebviewEvents = useCallback((webview: Electron.WebviewTag) => {
    const handleTitleUpdate = () => {
      const title = webview.getTitle()
      if (title) onTitleChange(tab.id, title)
    }

    const handleNavigation = () => {
      try {
        const url = webview.getURL()
        if (url) onUrlChange(tab.id, url)
        onNavigationStateChange(tab.id, webview.canGoBack(), webview.canGoForward())
      } catch {
        // webview may not be ready
      }
    }

    const handleStartLoading = () => onLoadingChange(tab.id, true)
    const handleStopLoading = () => {
      onLoadingChange(tab.id, false)
      handleNavigation()
      handleTitleUpdate()
    }

    const handleNewWindow = (e: Electron.Event & { url: string }) => {
      // Navigate current webview to the new URL instead of opening a popup
      webview.loadURL(e.url)
    }

    webview.addEventListener("page-title-updated", handleTitleUpdate)
    webview.addEventListener("did-navigate", handleNavigation)
    webview.addEventListener("did-navigate-in-page", handleNavigation)
    webview.addEventListener("did-start-loading", handleStartLoading)
    webview.addEventListener("did-stop-loading", handleStopLoading)
    webview.addEventListener("new-window" as any, handleNewWindow)

    return () => {
      webview.removeEventListener("page-title-updated", handleTitleUpdate)
      webview.removeEventListener("did-navigate", handleNavigation)
      webview.removeEventListener("did-navigate-in-page", handleNavigation)
      webview.removeEventListener("did-start-loading", handleStartLoading)
      webview.removeEventListener("did-stop-loading", handleStopLoading)
      webview.removeEventListener("new-window" as any, handleNewWindow)
    }
  }, [tab.id, onTitleChange, onUrlChange, onNavigationStateChange, onLoadingChange])

  useEffect(() => {
    const webview = webviewRef.current
    if (!webview) return

    const handleDomReady = () => {
      const cleanup = setupWebviewEvents(webview)
      // Store cleanup on the webview element so we can call it later
      ;(webview as any).__cleanup = cleanup
    }

    webview.addEventListener("dom-ready", handleDomReady)

    return () => {
      webview.removeEventListener("dom-ready", handleDomReady)
      const cleanup = (webview as any).__cleanup
      if (cleanup) cleanup()
    }
  }, [setupWebviewEvents])

  return (
    <webview
      ref={webviewRef}
      src={initialUrlRef.current}
      partition={`persist:browser-${tab.profileId}`}
      style={{
        width: "100%",
        height: "100%",
        display: isActive ? "flex" : "none",
      }}
      // @ts-expect-error webview attributes not fully typed in React
      allowpopups="true"
    />
  )
}

// Imperative controls exposed via ref from parent
export function getWebviewForTab(tabId: string): Electron.WebviewTag | null {
  const container = document.querySelector(`[data-browser-tab="${tabId}"]`)
  return container?.querySelector("webview") as Electron.WebviewTag | null
}
