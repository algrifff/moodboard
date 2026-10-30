import { Buildings } from '@phosphor-icons/react'
import { useClients } from '@/store/clients'

// The board's client, in the board header. A native select dressed as plain
// text so it sits quietly next to the board name.
export function BoardClientPicker({
  value,
  onChange,
}: {
  value: string | null
  onChange: (clientId: string | null) => void
}) {
  const { clients } = useClients()
  return (
    <label className="inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground transition-colors focus-within:text-foreground hover:text-foreground">
      <Buildings size={13} weight="regular" />
      <select
        aria-label="Client for this board"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        className="max-w-[140px] cursor-pointer appearance-none truncate bg-transparent font-medium outline-none"
      >
        <option value="">No client</option>
        {clients.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </label>
  )
}
