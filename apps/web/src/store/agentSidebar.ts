import {
  agentToolPayloadSchema,
  groupId,
  proximityGroups,
  type AgentMessage,
  type AgentStreamEvent,
  type AgentThread,
  type CanvasObject,
  type DesignProgress,
  type LinearIssueSummary,
} from '@moodboard/shared'
import { create } from 'zustand'
import {
  createAgentThread,
  deleteAgentThread,
  getAgentThread,
  listAgentThreads,
  streamAgentMessage,
} from '@/lib/agentApi'
import { pushServerObjects } from '@/lib/boardSync'
import { useCanvasStore } from '@/store/canvas'
import { useGroupPanelStore, type SlotState } from '@/store/groupPanels'

// The left agent sidebar: open/closed (per viewer), the board's threads,
// the active thread's messages, and the in-flight run. Board and group
// changes the agent makes are pushed into the canvas stores as they stream.

export const AGENT_SIDEBAR_WIDTH = 360
const OPEN_KEY = 'moodboard:agent-sidebar'

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== '0'
  } catch {
    return true
  }
}

function writeOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, open ? '1' : '0')
  } catch {
    // Storage unavailable — the sidebar just reopens next time.
  }
}

export type SidebarView =
  | { kind: 'chat' }
  | { kind: 'group'; groupKey: string }
  | { kind: 'linear' }

type Run = { threadId: string; controller: AbortController; streamingText: string }

type AgentSidebarState = {
  open: boolean
  view: SidebarView
  boardId: string | null
  threads: AgentThread[]
  threadsLoaded: boolean
  activeThreadId: string | null
  messages: AgentMessage[]
  loadingThread: boolean
  run: Run | null
  // A send that never reached the server (network, 409, rate limit).
  sendError: string | null
  // Live progress of long tools (design_output), by tool_use id, then by
  // variant. Streamed only; the finished result is the tool's own card.
  toolProgress: Record<string, Record<number, DesignProgress>>

  setOpen: (open: boolean) => void
  openGroup: (groupKey: string) => void
  openLinear: () => void
  showChat: () => void
  enterBoard: (boardId: string) => Promise<void>
  leaveBoard: () => void
  selectThread: (threadId: string) => Promise<void>
  newThread: () => void
  deleteThread: (threadId: string) => Promise<void>
  send: (
    boardId: string,
    text: string,
    selection?: string[],
    options?: { linearIssue?: string },
  ) => Promise<void>
  // Picking a Linear issue is the manual trigger: a fresh thread whose
  // first message carries the issue as the brief.
  startFromLinearIssue: (boardId: string, issue: LinearIssueSummary) => Promise<void>
  stop: () => void
}

// Panel slots the agent put into "loading" while analyze_group runs, so a
// failed run can put the previous read back.
const pendingAnalyses = new Map<string, { groupKey: string; previous: SlotState | undefined }>()

function markAnalysesStarted(message: AgentMessage): void {
  for (const block of message.content) {
    if (block.type !== 'tool_use' || block.name !== 'analyze_group') continue
    const ids = block.input.objectIds
    if (!Array.isArray(ids) || typeof ids[0] !== 'string') continue
    const groupKey = groupKeyContaining(ids[0])
    if (!groupKey) continue
    const panels = useGroupPanelStore.getState()
    pendingAnalyses.set(block.id, { groupKey, previous: panels.display[groupKey] })
    panels.setDisplay((d) => ({ ...d, [groupKey]: { kind: 'loading' } }))
  }
}

function restoreAnalysis(toolUseId: string): void {
  const pending = pendingAnalyses.get(toolUseId)
  if (!pending) return
  pendingAnalyses.delete(toolUseId)
  const { groupKey, previous } = pending
  useGroupPanelStore.getState().setDisplay((d) => {
    if (d[groupKey]?.kind !== 'loading') return d
    const next = { ...d }
    if (previous) next[groupKey] = previous
    else delete next[groupKey]
    return next
  })
}

function settleAnalyses(message: AgentMessage): void {
  for (const block of message.content) {
    if (block.type !== 'tool_result') continue
    if (block.is_error) restoreAnalysis(block.tool_use_id)
    else pendingAnalyses.delete(block.tool_use_id)
  }
}

function groupKeyContaining(id: string): string | null {
  const ids = proximityGroups(useCanvasStore.getState().objects).find((g) => g.includes(id))
  return ids ? groupId(ids) : null
}

export const useAgentSidebarStore = create<AgentSidebarState>()((set, get) => {
  const applyEvent = (boardId: string, threadId: string, event: AgentStreamEvent) => {
    switch (event.type) {
      case 'message': {
        const { message } = event
        if (message.role === 'assistant') markAnalysesStarted(message)
        else settleAnalyses(message)
        set((s) => ({
          messages:
            s.activeThreadId === threadId && !s.messages.some((m) => m.id === message.id)
              ? [...s.messages, message]
              : s.messages,
          run: s.run && message.role === 'assistant' ? { ...s.run, streamingText: '' } : s.run,
        }))
        break
      }
      case 'text':
        set((s) =>
          s.run ? { run: { ...s.run, streamingText: s.run.streamingText + event.delta } } : {},
        )
        break
      case 'thread':
        set((s) => ({
          threads: s.threads.map((t) => (t.id === event.thread.id ? event.thread : t)),
        }))
        break
      case 'board':
        pushServerObjects(
          boardId,
          event.objects.map((o) => ({ object: o.object as CanvasObject, version: o.version })),
        )
        break
      case 'groups':
        useGroupPanelStore.getState().applyServerGroups(event.groups)
        break
      case 'tool-progress':
        set((s) => ({
          toolProgress: {
            ...s.toolProgress,
            [event.toolUseId]: {
              ...s.toolProgress[event.toolUseId],
              [event.progress.variant]: event.progress,
            },
          },
        }))
        break
      case 'done':
        break
    }
  }

  return {
    open: readOpen(),
    view: { kind: 'chat' },
    boardId: null,
    threads: [],
    threadsLoaded: false,
    activeThreadId: null,
    messages: [],
    loadingThread: false,
    run: null,
    sendError: null,
    toolProgress: {},

    setOpen: (open) => {
      writeOpen(open)
      set({ open })
    },
    openGroup: (groupKey) => {
      writeOpen(true)
      set({ open: true, view: { kind: 'group', groupKey } })
    },
    openLinear: () => {
      writeOpen(true)
      set({ open: true, view: { kind: 'linear' } })
    },
    showChat: () => set({ view: { kind: 'chat' } }),

    enterBoard: async (boardId) => {
      get().run?.controller.abort()
      set({
        boardId,
        threads: [],
        threadsLoaded: false,
        activeThreadId: null,
        messages: [],
        run: null,
        sendError: null,
        view: { kind: 'chat' },
      })
      try {
        const threads = await listAgentThreads(boardId)
        if (get().boardId !== boardId) return
        set({ threads, threadsLoaded: true })
        // Resume where the team left off.
        if (threads[0]) await get().selectThread(threads[0].id)
      } catch (e) {
        console.error('loading agent threads failed', e)
        set({ threadsLoaded: true })
      }
    },
    leaveBoard: () => {
      get().run?.controller.abort()
      set({ boardId: null, threads: [], activeThreadId: null, messages: [], run: null })
    },

    selectThread: async (threadId) => {
      const boardId = get().boardId
      if (!boardId) return
      set({
        activeThreadId: threadId,
        messages: [],
        loadingThread: true,
        sendError: null,
        view: { kind: 'chat' },
      })
      try {
        const { thread, messages } = await getAgentThread(boardId, threadId)
        if (get().activeThreadId !== threadId) return
        set((s) => ({
          messages,
          loadingThread: false,
          threads: s.threads.map((t) => (t.id === thread.id ? thread : t)),
        }))
      } catch (e) {
        console.error('loading agent thread failed', e)
        set({ loadingThread: false })
      }
    },

    newThread: () =>
      set({ activeThreadId: null, messages: [], sendError: null, view: { kind: 'chat' } }),

    deleteThread: async (threadId) => {
      const boardId = get().boardId
      if (!boardId) return
      await deleteAgentThread(boardId, threadId)
      set((s) => ({
        threads: s.threads.filter((t) => t.id !== threadId),
        ...(s.activeThreadId === threadId ? { activeThreadId: null, messages: [] } : {}),
      }))
    },

    send: async (boardId, text, selection, options) => {
      const trimmed = text.trim()
      if (!trimmed || get().run) return
      writeOpen(true)
      set({ open: true, view: { kind: 'chat' }, sendError: null })
      let threadId = get().activeThreadId
      try {
        if (!threadId) {
          const thread = await createAgentThread(boardId)
          threadId = thread.id
          set((s) => ({ threads: [thread, ...s.threads], activeThreadId: thread.id, messages: [] }))
        }
      } catch (e) {
        set({ sendError: e instanceof Error ? e.message : String(e) })
        return
      }
      const controller = new AbortController()
      const id = threadId
      set({ run: { threadId: id, controller, streamingText: '' } })
      // Most recent first, like the list order the server returns.
      set((s) => {
        const thread = s.threads.find((t) => t.id === id)
        return thread
          ? {
              threads: [
                { ...thread, updatedAt: new Date().toISOString() },
                ...s.threads.filter((t) => t.id !== id),
              ],
            }
          : {}
      })
      try {
        await streamAgentMessage(
          boardId,
          id,
          {
            text: trimmed,
            ...(selection && selection.length > 0 ? { selection } : {}),
            ...(options?.linearIssue ? { linearIssue: options.linearIssue } : {}),
          },
          (event) => applyEvent(boardId, id, event),
          controller.signal,
        )
      } catch (e) {
        if (!controller.signal.aborted) {
          set({ sendError: e instanceof Error ? e.message : String(e) })
        }
      } finally {
        if (get().run?.controller === controller) set({ run: null })
        // A stopped or failed run never settles its analyses.
        for (const id of [...pendingAnalyses.keys()]) restoreAnalysis(id)
      }
      // A stopped run finishes persisting on the server after we hang up;
      // reload so the thread shows exactly what was kept.
      if (controller.signal.aborted && get().activeThreadId === id) {
        setTimeout(() => {
          if (get().activeThreadId === id && !get().run) void get().selectThread(id)
        }, 600)
      }
    },

    startFromLinearIssue: async (boardId, issue) => {
      if (get().run) return
      get().newThread()
      await get().send(
        boardId,
        `${issue.identifier} · ${issue.title}\nRead the brief, work out the client and its style kit, and tell me what you'd make.`,
        undefined,
        { linearIssue: issue.identifier },
      )
    },

    stop: () => get().run?.controller.abort(),
  }
})

// Parses a tool_result's JSON payload; null for errors / unparseable.
export function toolPayload(content: string) {
  try {
    const parsed = agentToolPayloadSchema.safeParse(JSON.parse(content))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
