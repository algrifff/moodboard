import { createContext, useContext, type ReactNode } from 'react'

// True inside the public Share viewer — flips EditableText into a plain
// render mode (no hover affordances, no click-to-edit). Lifting this
// into a context dodges threading a `readOnly` prop through every
// brief block in AIAnalysisPanel.
const ReadOnlyContext = createContext(false)

export function ReadOnlyProvider({
  value,
  children,
}: {
  value: boolean
  children: ReactNode
}) {
  return <ReadOnlyContext.Provider value={value}>{children}</ReadOnlyContext.Provider>
}

export function useReadOnly(): boolean {
  return useContext(ReadOnlyContext)
}
