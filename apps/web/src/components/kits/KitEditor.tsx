import { KIT_FONT_SLOTS, type KitFont, type KitFontSlot, type KitTokens } from '@moodboard/shared'
import { uploadFile } from '@/lib/api'
import { inputClass, selectClass } from '@/components/ui'
import {
  AddButton,
  FieldLabel,
  HexField,
  LinesField,
  RemoveButton,
  SectionCard,
  UploadButton,
} from './fields'

const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900]

const SLOT_COPY: Record<KitFontSlot, { title: string; hint: string }> = {
  display: { title: 'Display', hint: 'Headlines and big moments' },
  body: { title: 'Body', hint: 'Running text' },
  mono: { title: 'Mono', hint: 'Labels, captions, code' },
}

// Edits a full set of kit tokens. Pure controlled component: every change
// hands a new KitTokens to `onChange`. `resetKey` changes when a different
// version is loaded so the multi-line fields re-read their value.
export function KitEditor({
  tokens,
  onChange,
  resetKey,
  disabled,
}: {
  tokens: KitTokens
  onChange: (next: KitTokens) => void
  resetKey: string | number
  disabled: boolean
}) {
  const set = (patch: Partial<KitTokens>) => onChange({ ...tokens, ...patch })

  const setFont = (slot: KitFontSlot, font: KitFont | null) =>
    set({ fonts: { ...tokens.fonts, [slot]: font } })

  return (
    <div className="flex flex-col gap-4">
      <SectionCard title="Summary" hint="One line on what the brand is.">
        <input
          value={tokens.summary}
          disabled={disabled}
          maxLength={400}
          onChange={(e) => set({ summary: e.target.value })}
          placeholder="Quiet utility, loud colour."
          className={inputClass}
          aria-label="Summary"
        />
      </SectionCard>

      <SectionCard
        title="Palette"
        hint="Named roles. Roles called background, surface, text, primary or accent also fill the fixed --kit-color-* slots templates rely on."
        action={
          <AddButton
            disabled={disabled || tokens.palette.length >= 24}
            onClick={() =>
              set({
                palette: [...tokens.palette, { role: 'new colour', hex: '#7B5CFF', usage: '' }],
              })
            }
          >
            Add colour
          </AddButton>
        }
      >
        {tokens.palette.length === 0 && (
          <p className="text-sm text-[var(--text-mute)]">No colours yet.</p>
        )}
        <ul className="flex flex-col gap-2">
          {tokens.palette.map((color, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2">
              <HexField
                value={color.hex}
                disabled={disabled}
                onCommit={(hex) =>
                  set({ palette: tokens.palette.map((c, j) => (j === i ? { ...c, hex } : c)) })
                }
              />
              <input
                value={color.role}
                disabled={disabled}
                maxLength={40}
                onChange={(e) =>
                  set({
                    palette: tokens.palette.map((c, j) =>
                      j === i ? { ...c, role: e.target.value } : c,
                    ),
                  })
                }
                aria-label="Role"
                placeholder="Role"
                className={`${inputClass} !w-36`}
              />
              <input
                value={color.usage}
                disabled={disabled}
                maxLength={300}
                onChange={(e) =>
                  set({
                    palette: tokens.palette.map((c, j) =>
                      j === i ? { ...c, usage: e.target.value } : c,
                    ),
                  })
                }
                aria-label="Usage"
                placeholder="Where it's used"
                className={`${inputClass} min-w-[160px] flex-1`}
              />
              <RemoveButton
                label={`Remove ${color.role}`}
                disabled={disabled}
                onClick={() => set({ palette: tokens.palette.filter((_, j) => j !== i) })}
              />
            </li>
          ))}
        </ul>
      </SectionCard>

      <SectionCard
        title="Fonts"
        hint="Upload a font file and templates load it through @font-face; otherwise the family must already be available."
      >
        <div className="flex flex-col gap-4">
          {KIT_FONT_SLOTS.map((slot) => (
            <FontSlot
              key={slot}
              slot={slot}
              font={tokens.fonts[slot]}
              disabled={disabled}
              onChange={(font) => setFont(slot, font)}
            />
          ))}
          <label className="block">
            <FieldLabel>Typographic feel</FieldLabel>
            <input
              value={tokens.fonts.feel}
              disabled={disabled}
              maxLength={400}
              onChange={(e) => set({ fonts: { ...tokens.fonts, feel: e.target.value } })}
              placeholder="Grotesk headlines, generous tracking; mono for small labels."
              className={inputClass}
            />
          </label>
        </div>
      </SectionCard>

      <SectionCard
        title="Logos"
        hint="Variants a template can place. The first is --kit-logo."
        action={
          <AddButton
            disabled={disabled || tokens.logos.length >= 12}
            onClick={() =>
              set({
                logos: [
                  ...tokens.logos,
                  { name: `Logo ${tokens.logos.length + 1}`, url: '', usage: '' },
                ],
              })
            }
          >
            Add logo
          </AddButton>
        }
      >
        {tokens.logos.length === 0 && (
          <p className="text-sm text-[var(--text-mute)]">No logos yet.</p>
        )}
        <ul className="flex flex-col gap-2">
          {tokens.logos.map((logo, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2">
              <div
                className="flex h-10 w-14 shrink-0 items-center justify-center bg-[var(--bg-muted)]"
                style={{ borderRadius: 'var(--radius)' }}
              >
                {logo.url && (
                  <img src={logo.url} alt="" className="max-h-9 max-w-[52px] object-contain" />
                )}
              </div>
              <input
                value={logo.name}
                disabled={disabled}
                maxLength={60}
                onChange={(e) =>
                  set({
                    logos: tokens.logos.map((l, j) =>
                      j === i ? { ...l, name: e.target.value } : l,
                    ),
                  })
                }
                aria-label="Logo name"
                placeholder="Name"
                className={`${inputClass} !w-36`}
              />
              <input
                value={logo.url}
                disabled={disabled}
                onChange={(e) =>
                  set({
                    logos: tokens.logos.map((l, j) =>
                      j === i ? { ...l, url: e.target.value } : l,
                    ),
                  })
                }
                aria-label="Logo URL"
                placeholder="/api/files/… or https://…"
                className={`${inputClass} min-w-[160px] flex-1 font-mono text-xs`}
              />
              <UploadButton
                accept="image/png,image/jpeg,image/webp,image/gif"
                label="Upload"
                disabled={disabled}
                onFile={async (file) => {
                  const up = await uploadFile(file, file.name)
                  set({ logos: tokens.logos.map((l, j) => (j === i ? { ...l, url: up.url } : l)) })
                }}
              />
              <input
                value={logo.usage}
                disabled={disabled}
                maxLength={300}
                onChange={(e) =>
                  set({
                    logos: tokens.logos.map((l, j) =>
                      j === i ? { ...l, usage: e.target.value } : l,
                    ),
                  })
                }
                aria-label="Logo usage"
                placeholder="When to use it"
                className={`${inputClass} basis-full`}
              />
              <RemoveButton
                label={`Remove ${logo.name}`}
                disabled={disabled}
                onClick={() => set({ logos: tokens.logos.filter((_, j) => j !== i) })}
              />
            </li>
          ))}
        </ul>
      </SectionCard>

      <SectionCard title="Voice" hint="One item per line.">
        <div className="grid gap-3 sm:grid-cols-2">
          <LinesField
            label="Tone"
            value={tokens.voice.tone}
            resetKey={resetKey}
            disabled={disabled}
            onChange={(tone) => set({ voice: { ...tokens.voice, tone } })}
          />
          <LinesField
            label="Example lines"
            value={tokens.voice.examples}
            resetKey={resetKey}
            disabled={disabled}
            onChange={(examples) => set({ voice: { ...tokens.voice, examples } })}
          />
          <LinesField
            label="Do"
            value={tokens.voice.dos}
            resetKey={resetKey}
            disabled={disabled}
            onChange={(dos) => set({ voice: { ...tokens.voice, dos } })}
          />
          <LinesField
            label="Don't"
            value={tokens.voice.donts}
            resetKey={resetKey}
            disabled={disabled}
            onChange={(donts) => set({ voice: { ...tokens.voice, donts } })}
          />
        </div>
      </SectionCard>

      <SectionCard title="Imagery" hint="One item per line.">
        <div className="grid gap-3 sm:grid-cols-2">
          <LinesField
            label="Rules"
            hint="e.g. Natural light, never stock handshakes."
            value={tokens.imagery.rules}
            resetKey={resetKey}
            disabled={disabled}
            onChange={(rules) => set({ imagery: { ...tokens.imagery, rules } })}
          />
          <LinesField
            label="References"
            value={tokens.imagery.references}
            resetKey={resetKey}
            disabled={disabled}
            onChange={(references) => set({ imagery: { ...tokens.imagery, references } })}
          />
        </div>
      </SectionCard>

      <SectionCard title="Notes" hint="Anything else an art director should know. One per line.">
        <LinesField
          label="Notes"
          value={tokens.notes}
          resetKey={resetKey}
          disabled={disabled}
          rows={4}
          onChange={(notes) => set({ notes })}
        />
      </SectionCard>
    </div>
  )
}

function FontSlot({
  slot,
  font,
  disabled,
  onChange,
}: {
  slot: KitFontSlot
  font: KitFont | null
  disabled: boolean
  onChange: (font: KitFont | null) => void
}) {
  const copy = SLOT_COPY[slot]
  const blank: KitFont = {
    family: '',
    category: slot === 'mono' ? 'mono' : 'sans',
    url: null,
    weights: [],
    usage: '',
  }
  const current = font ?? blank
  // Typing into an empty slot creates the font; clearing the family removes it.
  const update = (patch: Partial<KitFont>) => {
    const next = { ...current, ...patch }
    onChange(next.family.trim() === '' && !next.url ? null : next)
  }

  return (
    <div>
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-sm font-medium text-foreground">{copy.title}</span>
        <span className="text-xs text-[var(--text-mute)]">{copy.hint}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={current.family}
          disabled={disabled}
          maxLength={100}
          onChange={(e) => update({ family: e.target.value })}
          aria-label={`${copy.title} font family`}
          placeholder="Family name"
          className={`${inputClass} !w-48`}
        />
        <select
          value={current.category}
          disabled={disabled}
          onChange={(e) => update({ category: e.target.value as KitFont['category'] })}
          aria-label={`${copy.title} category`}
          className={`${selectClass} !w-24`}
        >
          <option value="sans">Sans</option>
          <option value="serif">Serif</option>
          <option value="mono">Mono</option>
        </select>
        <UploadButton
          accept=".woff2,.woff,.ttf,.otf"
          label={current.url ? 'Replace file' : 'Upload file'}
          disabled={disabled}
          onFile={async (file) => {
            const up = await uploadFile(file, file.name)
            update({ url: up.url, family: current.family || up.fontFamily || file.name })
          }}
        />
        {current.url && (
          <span className="flex items-center gap-1 text-micro text-[var(--text-mute)]">
            <span className="font-mono">{current.url.split('/').pop()}</span>
            <button
              type="button"
              disabled={disabled}
              onClick={() => update({ url: null })}
              className="text-[var(--text-faint)] hover:text-destructive"
              aria-label={`Remove ${copy.title} font file`}
            >
              remove
            </button>
          </span>
        )}
      </div>
      <div
        className="mt-2 flex flex-wrap items-center gap-1"
        role="group"
        aria-label={`${copy.title} weights`}
      >
        <span className="mr-1 text-micro text-[var(--text-mute)]">Weights</span>
        {WEIGHTS.map((w) => {
          const on = current.weights.includes(w)
          return (
            <button
              key={w}
              type="button"
              disabled={disabled}
              aria-pressed={on}
              onClick={() =>
                update({
                  weights: on
                    ? current.weights.filter((x) => x !== w)
                    : [...current.weights, w].sort((a, b) => a - b),
                })
              }
              className={`h-6 min-w-[34px] rounded-lg px-1.5 text-micro transition-colors disabled:opacity-50 ${
                on
                  ? 'bg-[var(--accent-soft)] text-foreground shadow-[inset_0_0_0_1px_var(--accent)]'
                  : 'bg-[var(--bg-elevated)] text-[var(--text-mute)] hover:text-foreground'
              }`}
            >
              {w}
            </button>
          )
        })}
      </div>
      <input
        value={current.usage}
        disabled={disabled}
        maxLength={300}
        onChange={(e) => update({ usage: e.target.value })}
        aria-label={`${copy.title} usage`}
        placeholder="Usage notes"
        className={`${inputClass} mt-2`}
      />
    </div>
  )
}
