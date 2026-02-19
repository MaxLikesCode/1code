import { atom } from "jotai"

export interface BrowserTabState {
  id: string
  profileId: string
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  isLoading: boolean
}

// Currently active tab ID
export const browserActiveTabIdAtom = atom<string | null>(null)

// Runtime tab state (synced to DB on changes)
export const browserTabsAtom = atom<BrowserTabState[]>([])

// Profile manager dialog open state
export const profileManagerOpenAtom = atom(false)

// New tab dialog open state
export const newTabDialogOpenAtom = atom(false)
