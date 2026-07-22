# Multi-Host Remote Access - Implementation Plan

## Overview

Enable storing multiple SRP sessions and switching between hosts (desktop, pi, laptop, etc.) with URL-based routing for relay mode.

## Completed (Phases 1-7)

### Phase 1: Storage Layer
- Added `SAVED_HOSTS_KEY` to `packages/client/src/lib/storageKeys.ts`
- Created `packages/client/src/lib/hostStorage.ts` with:
  - `SavedHost` interface
  - `loadSavedHosts()`, `saveHost()`, `updateHostSession()`, `removeHost()`
  - `getHostByRelayUsername()`, `getHostById()`
  - `createRelayHost()`, `createDirectHost()` helpers

### Phase 2: Host Picker Page
- Created `packages/client/src/pages/HostPickerPage.tsx`
- Shows saved hosts with online/offline status indicators
- Quick connect to saved hosts (session resumption)
- Delete hosts from the list
- "Add Host" section with relay/direct buttons
- Updated `remote-main.tsx` to use `HostPickerPage` at `/login`
- Modified `RelayLoginPage` and `DirectLoginPage` to save hosts after login
- Added CSS styles for host picker

### Phase 3: URL-Based Routing
- Renamed routes: `/relay` → `/login/relay`, `/direct` → `/login/direct`
- Added legacy redirects for old paths
- Created `packages/client/src/pages/RelayHostRoutes.tsx`:
  - Extracts `relayUsername` from URL params
  - Looks up saved host by username
  - Handles auto-connect with session resumption
  - Contains nested routes for all app pages (projects, sessions, etc.)
  - Shows `HostOfflineModal` on connection errors with retry
- Created `packages/client/src/hooks/useRemoteBasePath.ts`:
  - `useRemoteBasePath()` returns `/remote/{username}` base path
  - `useRelayUsername()` extracts username from URL
- Updated `packages/client/src/RemoteApp.tsx`:
  - Added `SELF_MANAGED_ROUTES` for `/remote/*` paths
  - `ConnectionGate` lets self-managed routes handle their own auth
- Updated `packages/client/src/remote-main.tsx`:
  - Added `/remote/:relayUsername/*` route to `RelayHostRoutes`

### Phase 4: Connection Context Updates (Minimal)
- Added `currentHostId` and `setCurrentHostId` to `RemoteConnectionContext`
- Updated `RelayHostRoutes` to call `setCurrentHostId(host.id)` on successful connect
- Note: `connectToHost()`/`connectToRelayUsername()` methods not needed - `RelayHostRoutes` handles connection directly

---

### Phase 5: Link Updates ✓

- All navigation links now include username prefix via `useRemoteBasePath()` hook
- Updated components:
  - `Sidebar.tsx` - passes basePath to all nav items
  - `SidebarNavItem.tsx` - accepts basePath prop, prefixes all links
  - `SessionListItem.tsx` - uses basePath for session links
  - `FloatingActionButton.tsx` - uses basePath for new session/projects
  - `SessionPage.tsx` - uses basePath for breadcrumbs and navigation
  - `ProjectsPage.tsx` - passes basePath to ProjectCard
  - `ProjectCard.tsx` - uses basePath for session links
  - `GlobalSessionsPage.tsx` - passes basePath to SessionListItem
  - `InboxContent.tsx` - uses basePath for inbox items
  - `AgentsNavItem.tsx` - passes basePath to SidebarNavItem
  - `RecentSessionsDropdown.tsx` - uses basePath for session links

---

### Phase 6: Settings "Switch Host" Link ✓

- Updated `packages/client/src/pages/settings/RemoteAccessSettings.tsx`:
  - Added "Current Host" display showing host displayName (from hostStorage) or storedUsername fallback
  - Added "Switch Host" link navigating to `/login` (host picker)
  - Renamed "Connected to" label to "Current Host" for consistency

---

### Phase 7: Session Sync Between Storages ✓

- Updated `packages/client/src/contexts/RemoteConnectionContext.tsx`:
  - Imported `updateHostSession` from hostStorage
  - Added `currentHostIdRef` to track host ID in a ref (so callback always has latest value)
  - Wrapped `setCurrentHostId` to update both state and ref
  - Updated `handleSessionEstablished` to dual-write:
    - Saves to old storage (`updateStoredSession`) for backwards compatibility
    - Also saves to hostStorage (`updateHostSession`) when `currentHostIdRef.current` is set
  - This ensures session refreshes are persisted to both storages during migration

---

## Testing Checklist

- [ ] Fresh install: Login page shows empty, can add relay host
- [ ] Add host: After relay login, host appears in saved list
- [ ] Quick connect: Click saved host, auto-resumes if session valid
- [ ] Session expired: Redirects to login form pre-filled
- [ ] Delete host: Removes from list
- [ ] URL routing: `/remote/desktop/projects` connects to "desktop"
- [ ] Multi-tab: Two tabs open to different hosts work independently
- [ ] Bookmarks: Saved URL auto-connects to correct host
- [ ] Switch host: Settings link goes to host picker
- [ ] Status indicators: Shows online/offline for relay hosts

---

## Migration Notes

- No migration needed for existing users - they just re-login
- Old `REMOTE_CREDENTIALS_KEY` storage continues to work during transition
- New `SAVED_HOSTS_KEY` storage is additive
- Eventually can deprecate old storage in future release
