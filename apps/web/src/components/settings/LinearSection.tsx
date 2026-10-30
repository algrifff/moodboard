import type { LinearMapping, LinearTeam } from '@moodboard/shared'
import { useCallback, useEffect, useState } from 'react'
import { LinearLogo } from '@/components/canvas/sourceLogos'
import { ClientSelect } from '@/components/clients/ClientSelect'
import { ConnectPrompt } from '@/components/linear/LinearIssuePicker'
import { ghostButton } from '@/components/ui'
import { getLinearMappings, putLinearMapping } from '@/lib/linearApi'
import { useClients } from '@/store/clients'
import { useLinearStore } from '@/store/linear'

// Settings → Linear: the connection, and which client each Linear team or
// project belongs to, so an issue resolves to a client automatically. The
// connection is yours; the mapping is shared by the whole team.
export function LinearSection() {
  const status = useLinearStore((s) => s.status)
  const statusError = useLinearStore((s) => s.statusError)
  const load = useLinearStore((s) => s.load)
  const disconnect = useLinearStore((s) => s.disconnect)

  useEffect(() => {
    void load()
  }, [load])

  return (
    <section>
      <div className="flex items-center gap-2">
        <LinearLogo size={16} />
        <h2 className="text-lg font-semibold text-foreground">Linear</h2>
      </div>
      <p className="mt-1 text-sm text-[var(--text-soft)]">
        Pick a Linear issue in the agent sidebar and it becomes the brief for a new thread.
        Read-only.
      </p>

      <div className="mt-4">
        {statusError ? (
          <p className="text-sm text-destructive">{statusError}</p>
        ) : !status ? (
          <p className="text-sm text-muted-foreground">Checking Linear…</p>
        ) : !status.configured ? (
          <div
            className="bg-card p-4 text-sm leading-relaxed text-[var(--text-soft)]"
            style={{ borderRadius: 'var(--radius-lg)' }}
          >
            <p className="font-medium text-foreground">Linear isn’t configured on this server.</p>
            <p className="mt-1">
              Create an OAuth app in Linear (Settings → API → OAuth applications) with the redirect
              URI <code className="font-mono">…/api/connections/linear/callback</code>, then set{' '}
              <code className="font-mono">LINEAR_CLIENT_ID</code>,{' '}
              <code className="font-mono">LINEAR_CLIENT_SECRET</code> and{' '}
              <code className="font-mono">LINEAR_REDIRECT_URI</code> on the API and restart it.
            </p>
          </div>
        ) : !status.connection ? (
          <div className="max-w-sm">
            <ConnectPrompt />
          </div>
        ) : (
          <>
            <div
              className="flex items-center gap-3 bg-card px-4 py-3"
              style={{ borderRadius: 'var(--radius-lg)' }}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm text-foreground">
                  {status.connection.accountEmail}
                </div>
                <div className="text-xs text-[var(--text-mute)]">
                  {status.connection.workspaceName ?? 'Linear workspace'}
                </div>
              </div>
              <button
                type="button"
                className={ghostButton}
                onClick={() => {
                  if (confirm('Disconnect Linear? Saved client mappings are kept.'))
                    void disconnect()
                }}
              >
                Disconnect
              </button>
            </div>
            <Mappings />
          </>
        )}
      </div>
    </section>
  )
}

function Mappings() {
  const { clients } = useClients()
  const [mappings, setMappings] = useState<LinearMapping[]>([])
  const [teams, setTeams] = useState<LinearTeam[] | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await getLinearMappings()
      setMappings(res.mappings)
      setTeams(res.teams)
      setLoaded(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const clientFor = (kind: LinearMapping['kind'], linearId: string) =>
    mappings.find((m) => m.kind === kind && m.linearId === linearId)?.clientId ?? null

  const assign = async (
    kind: LinearMapping['kind'],
    linearId: string,
    linearName: string,
    clientId: string | null,
  ) => {
    try {
      setMappings(await putLinearMapping({ kind, linearId, linearName, clientId }))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="mt-6">
      <h3 className="text-base font-semibold text-foreground">Teams and projects → clients</h3>
      <p className="mt-0.5 text-sm text-[var(--text-soft)]">
        A project’s client wins over its team’s. Issues in unmapped teams have no client until the
        agent is told one.
      </p>
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
      {clients.length === 0 && (
        <p className="mt-3 text-sm text-muted-foreground">
          Add a client from the Boards page first, then map Linear to it here.
        </p>
      )}
      {!loaded && !error && <p className="mt-3 text-sm text-muted-foreground">Loading teams…</p>}
      {loaded && teams === null && (
        <p className="mt-3 text-sm text-muted-foreground">
          Couldn’t load your Linear teams right now. {mappings.length} saved mapping
          {mappings.length === 1 ? '' : 's'} still apply.
        </p>
      )}
      {teams && (
        <ul
          className="mt-3 divide-y divide-[var(--border-soft)] bg-card"
          style={{ borderRadius: 'var(--radius-lg)' }}
        >
          {teams.map((team) => (
            <li key={team.id} className="px-4 py-3">
              <MappingRow
                title={team.name}
                subtitle={team.key}
                clients={clients}
                value={clientFor('team', team.id)}
                onChange={(id) => void assign('team', team.id, team.name, id)}
              />
              {team.projects.length > 0 && (
                <ul className="mt-2 flex flex-col gap-2 border-l border-[var(--border-soft)] pl-4">
                  {team.projects.map((project) => (
                    <li key={project.id}>
                      <MappingRow
                        title={project.name}
                        subtitle="project"
                        clients={clients}
                        value={clientFor('project', project.id)}
                        onChange={(id) => void assign('project', project.id, project.name, id)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function MappingRow({
  title,
  subtitle,
  clients,
  value,
  onChange,
}: {
  title: string
  subtitle: string
  clients: ReturnType<typeof useClients>['clients']
  value: string | null
  onChange: (clientId: string | null) => void
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-foreground">{title}</div>
        <div className="text-micro uppercase tracking-[0.1em] text-[var(--text-faint)]">
          {subtitle}
        </div>
      </div>
      <ClientSelect
        clients={clients}
        value={value}
        onChange={onChange}
        noneLabel="No client"
        label={`Client for ${title}`}
        className="w-48"
      />
    </div>
  )
}
