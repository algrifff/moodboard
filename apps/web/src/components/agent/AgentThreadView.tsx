import {
  parseLinearIssueBlock,
  parseSelectionBlock,
  type AgentMessage,
  type AgentToolResultBlock,
  type AgentToolUseBlock,
} from '@moodboard/shared'
import { ArrowUp, Info, SelectionAll, Stop, X } from '@phosphor-icons/react'
import { motion } from 'framer-motion'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { LinearLogo } from '@/components/canvas/sourceLogos'
import { focusObjects } from '@/lib/canvasCamera'
import { EASE_OUT_STANDARD } from '@/lib/motion'
import { useAgentSidebarStore } from '@/store/agentSidebar'
import { useCanvasStore } from '@/store/canvas'
import { AgentToolCard, foldToolCalls, type ToolCall } from './AgentToolCard'

const SUGGESTIONS = [
  'Pull the selected items into a group and give me a brief',
  'Thumbnail for our launch video — punchy, dark',
  'Which style kits do we have?',
]

export function AgentThreadView({ boardId }: { boardId: string }) {
  const messages = useAgentSidebarStore((s) => s.messages)
  const run = useAgentSidebarStore((s) => s.run)
  const activeThreadId = useAgentSidebarStore((s) => s.activeThreadId)
  const loadingThread = useAgentSidebarStore((s) => s.loadingThread)
  const sendError = useAgentSidebarStore((s) => s.sendError)
  const runningHere = run !== null && run.threadId === activeThreadId

  const results = useMemo(() => {
    const map = new Map<string, AgentToolResultBlock>()
    for (const m of messages) {
      for (const b of m.content) if (b.type === 'tool_result') map.set(b.tool_use_id, b)
    }
    return map
  }, [messages])

  // Stick to the bottom while new content streams in, unless the reader
  // has scrolled up.
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [messages, run?.streamingText, sendError])
  useEffect(() => {
    pinnedRef.current = true
  }, [activeThreadId])

  const empty = messages.length === 0 && !runningHere && !loadingThread
  const last = messages.at(-1)
  // Between turns: the user just sent, or tool results just went back.
  const waiting = runningHere && !run.streamingText && (!last || last.role === 'user')

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget
          pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
        className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-3"
      >
        {empty ? (
          <EmptyThread boardId={boardId} />
        ) : (
          <div className="flex flex-col gap-3.5">
            {messages.map((m) => (
              <MessageRow key={m.id} message={m} results={results} running={runningHere} />
            ))}
            {runningHere && run.streamingText && (
              <AssistantText text={run.streamingText} streaming />
            )}
            {waiting && <span className="text-shimmer text-[12.5px]">Thinking…</span>}
          </div>
        )}
        {sendError && (
          <div className="mt-3 flex items-start gap-2 text-[12.5px] text-[var(--danger)]">
            <Info size={14} className="mt-[1px] shrink-0" />
            <span>{sendError}</span>
          </div>
        )}
      </div>
      <Composer boardId={boardId} running={runningHere} />
    </div>
  )
}

function MessageRow({
  message,
  results,
  running,
}: {
  message: AgentMessage
  results: Map<string, AgentToolResultBlock>
  running: boolean
}) {
  if (message.isError) {
    const text = message.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n')
    return (
      <div className="flex items-start gap-2 text-[12.5px] text-[var(--text-mute)]">
        <Info size={14} className="mt-[2px] shrink-0 text-[var(--warning)]" />
        <span>{text}</span>
      </div>
    )
  }

  if (message.role === 'user') {
    // Tool results render inside the assistant's cards, not as a turn.
    const texts = message.content.filter((b) => b.type === 'text')
    if (texts.length === 0) return null
    const selection = texts.flatMap((b) => parseSelectionBlock(b) ?? [])
    const issues = texts.flatMap((b) => parseLinearIssueBlock(b) ?? [])
    const body = texts
      .filter((b) => parseSelectionBlock(b) === null && parseLinearIssueBlock(b) === null)
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n')
    return (
      <div className="flex flex-col items-end gap-1">
        <div
          className="max-w-[88%] whitespace-pre-wrap break-words px-3 py-2 text-[13px] leading-relaxed text-foreground"
          style={{ borderRadius: 'var(--radius-lg)', backgroundColor: 'var(--bg-elevated)' }}
        >
          {body}
        </div>
        {issues.map((issue) => (
          <span
            key={issue.identifier}
            className="inline-flex max-w-full items-center gap-1.5 text-[11px] text-[var(--text-mute)]"
            title="The Linear issue the agent was given as the brief"
          >
            <LinearLogo size={12} />
            <span className="font-mono">{issue.identifier}</span>
            <span className="truncate">{issue.title}</span>
          </span>
        ))}
        {selection.length > 0 && (
          <button
            type="button"
            onClick={() => focusObjects(selection)}
            className="inline-flex items-center gap-1 text-[11px] text-[var(--text-mute)] hover:text-foreground transition-colors"
            title="Show on canvas"
          >
            <SelectionAll size={12} />
            {selection.length} selected item{selection.length === 1 ? '' : 's'}
          </button>
        )}
      </div>
    )
  }

  // Assistant: text and tool calls in order, adjacent tool calls folded.
  const parts: ({ kind: 'text'; text: string } | { kind: 'tools'; calls: ToolCall[] })[] = []
  for (const block of message.content) {
    if (block.type === 'text') parts.push({ kind: 'text', text: block.text })
    if (block.type === 'tool_use') {
      const call = { use: block as AgentToolUseBlock, result: results.get(block.id) }
      const prev = parts.at(-1)
      if (prev?.kind === 'tools') prev.calls.push(call)
      else parts.push({ kind: 'tools', calls: [call] })
    }
  }
  return (
    <div className="flex flex-col gap-2">
      {parts.map((p, i) =>
        p.kind === 'text' ? (
          <AssistantText key={i} text={p.text} />
        ) : (
          <div key={i} className="flex flex-col gap-1.5">
            {foldToolCalls(p.calls).map((calls) => (
              <AgentToolCard key={calls[0]!.use.id} calls={calls} running={running} />
            ))}
          </div>
        ),
      )}
    </div>
  )
}

function AssistantText({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div
      className={`agent-md text-[13px] leading-relaxed text-foreground ${streaming ? 'agent-md-streaming' : ''}`}
    >
      <ReactMarkdown>{text}</ReactMarkdown>
    </div>
  )
}

function EmptyThread({ boardId }: { boardId: string }) {
  const send = useAgentSidebarStore((s) => s.send)
  const openLinear = useAgentSidebarStore((s) => s.openLinear)
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: EASE_OUT_STANDARD }}
      className="flex flex-col gap-4 pt-6"
    >
      <div>
        <div className="text-[15px] font-medium text-foreground">
          What should we make of this board?
        </div>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--text-mute)]">
          The agent can read the board, pull items into groups and run the specialists for a brief,
          and design thumbnails, decks and pages in the client’s kit. Select items on the canvas to
          point at them.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => void send(boardId, s, useCanvasStore.getState().selectedIds)}
            className="px-3 py-2 text-left text-[12.5px] text-[var(--text-soft)] hover:text-foreground hover:bg-[var(--bg-elevated)] transition-colors"
            style={{ borderRadius: 'var(--radius-lg)', boxShadow: '0 0 0 1px var(--border-soft)' }}
          >
            {s}
          </button>
        ))}
        <button
          type="button"
          onClick={openLinear}
          className="inline-flex items-center gap-2 px-3 py-2 text-left text-[12.5px] text-[var(--text-soft)] hover:text-foreground hover:bg-[var(--bg-elevated)] transition-colors"
          style={{ borderRadius: 'var(--radius-lg)', boxShadow: '0 0 0 1px var(--border-soft)' }}
        >
          <LinearLogo size={14} />
          Start from a Linear issue
        </button>
      </div>
    </motion.div>
  )
}

const COMPOSER_MAX_HEIGHT = 168

function Composer({ boardId, running }: { boardId: string; running: boolean }) {
  const [text, setText] = useState('')
  const send = useAgentSidebarStore((s) => s.send)
  const stop = useAgentSidebarStore((s) => s.stop)
  const busy = useAgentSidebarStore((s) => s.run !== null)
  const selectedCount = useCanvasStore((s) => s.selectedIds.length)
  const ref = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(COMPOSER_MAX_HEIGHT, el.scrollHeight)}px`
  }, [text])

  const submit = () => {
    if (!text.trim() || busy) return
    void send(boardId, text, useCanvasStore.getState().selectedIds)
    setText('')
  }

  return (
    <div className="px-3 pb-3">
      <div
        className="flex flex-col gap-1.5 px-3 pb-2 pt-2.5 focus-within:shadow-[0_0_0_1px_var(--accent)]"
        style={{
          borderRadius: 'var(--radius-lg)',
          backgroundColor: 'var(--bg)',
          boxShadow: '0 0 0 1px var(--border)',
        }}
      >
        <textarea
          ref={ref}
          value={text}
          rows={1}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder="Ask the agent…"
          aria-label="Message the agent"
          className="w-full resize-none bg-transparent text-[13px] leading-relaxed text-foreground outline-none placeholder:text-[var(--text-faint)]"
          style={{ maxHeight: COMPOSER_MAX_HEIGHT }}
        />
        <div className="flex items-center gap-2">
          {selectedCount > 0 ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-[var(--text-mute)]">
              <SelectionAll size={12} />
              {selectedCount} selected
              <button
                type="button"
                onClick={() => useCanvasStore.getState().clearSelection()}
                className="ml-0.5 text-[var(--text-faint)] hover:text-foreground"
                aria-label="Clear selection"
                title="Don’t send the selection"
              >
                <X size={10} weight="bold" />
              </button>
            </span>
          ) : (
            <span className="text-[11px] text-[var(--text-faint)]">⇧↵ new line</span>
          )}
          <div className="flex-1" />
          {running ? (
            <button
              type="button"
              onClick={stop}
              className="inline-flex h-7 w-7 items-center justify-center bg-[var(--bg-elevated)] text-foreground hover:bg-[var(--bg-muted)] transition-colors"
              style={{ borderRadius: 'var(--radius-lg)' }}
              aria-label="Stop"
              title="Stop"
            >
              <Stop size={13} weight="fill" />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!text.trim() || busy}
              className="inline-flex h-7 w-7 items-center justify-center bg-primary text-primary-foreground disabled:opacity-30 hover:brightness-110 transition-[filter,opacity]"
              style={{ borderRadius: 'var(--radius-lg)' }}
              aria-label="Send"
              title="Send (Enter)"
            >
              <ArrowUp size={14} weight="bold" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
