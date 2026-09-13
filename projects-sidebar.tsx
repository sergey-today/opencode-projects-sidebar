/** @jsxImportSource @opentui/solid */
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js"
import type { RGBA } from "@opentui/core"
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiTheme,
} from "@opencode-ai/plugin/tui"
import type {
  GlobalSession,
  ProjectSummary,
  SessionStatus,
} from "@opencode-ai/sdk/v2"

const SPIN = ["◐", "◓", "◑", "◒"]

type Cfg = {
  width: number
  limit: number
  keybind: string
}

function parseOptions(raw: Record<string, unknown> | undefined): Cfg {
  const width = typeof raw?.width === "number" ? Math.max(20, Math.min(60, raw.width)) : 36
  const limit = typeof raw?.limit === "number" ? raw.limit : 50
  const keybind = typeof raw?.keybind === "string" ? raw.keybind : "ctrl+shift+s"
  return { width, limit, keybind }
}

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (s < 60) return "now"
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d`
  return `${Math.floor(d / 30)}mo`
}

function truncate(text: string, max: number): string {
  if (max <= 0) return ""
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

function baseName(worktree: string): string {
  const parts = worktree.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? worktree
}

function Spinner(props: { fg: RGBA }) {
  const [i, setI] = createSignal(0)
  createEffect(() => {
    const h = setInterval(() => setI((n) => (n + 1) % SPIN.length), 90)
    onCleanup(() => clearInterval(h))
  })
  return <text fg={props.fg}>{SPIN[i()]}</text>
}

function BlinkingDot(props: { fg: RGBA }) {
  const [visible, setVisible] = createSignal(true)
  createEffect(() => {
    const h = setInterval(() => setVisible((value) => !value), 500)
    onCleanup(() => clearInterval(h))
  })
  return <text fg={props.fg}>{visible() ? "●" : " "}</text>
}

function Clickable(props: { fg: RGBA; label: string; run: () => void }) {
  const [hov, setHov] = createSignal(false)
  return (
    <box
      flexDirection="row"
      alignItems="center"
      justifyContent="center"
      width={3}
      height={1}
      flexShrink={0}
      backgroundColor={hov() ? props.fg : undefined}
      onMouseUp={(e: { stopPropagation(): void }) => {
        e.stopPropagation()
        props.run()
      }}
      onMouseOver={() => setHov(true)}
      onMouseOut={() => setHov(false)}
    >
      <text fg={hov() ? "black" : props.fg}>{props.label}</text>
    </box>
  )
}

export const id = "projects-sidebar"

export const tui: TuiPlugin = async (api, rawOptions) => {
  const cfg = parseOptions(rawOptions as Record<string, unknown> | undefined)

  // ---- state ----
  const [sessions, setSessions] = createSignal<GlobalSession[]>([])
  const [statuses, setStatuses] = createSignal<Record<string, SessionStatus>>({})
  const [awaiting, setAwaiting] = createSignal<Record<string, boolean>>({})
  const [completed, setCompleted] = createSignal<Record<string, boolean>>({})
  const [error, setError] = createSignal<string | undefined>()

  const savedOpen = api.kv.get<boolean | undefined>("projects_sb.open")
  const [open, setOpen] = createSignal(savedOpen ?? false)
  let lastW = 0
  let decided = false
  const decide = (w: number) => {
    if (decided || api.kv.get("projects_sb.open") !== undefined) return
    decided = true
    const wide = w >= cfg.width + 92
    api.kv.set("projects_sb.open", wide)
    if (wide) setOpen(true)
  }
  const autoTimer = setInterval(() => {
    const w = (api.renderer.width ?? 0) as number
    if (w > 0 && w === lastW) {
      clearInterval(autoTimer)
      decide(w)
    } else {
      lastW = w
    }
  }, 400)
  const fallbackTimer = setTimeout(() => {
    if (!decided) {
      clearInterval(autoTimer)
      decide((api.renderer.width ?? 0) as number)
    }
  }, 6_000)
  api.lifecycle.onDispose(() => { clearInterval(autoTimer); clearTimeout(fallbackTimer) })
  const [folded, setFolded] = createSignal<Record<string, boolean>>(
    api.kv.get<Record<string, boolean>>("projects_sb.folded") ?? {},
  )

  const toggle = () => {
    setOpen((v) => {
      const next = !v
      api.kv.set("projects_sb.open", next)
      return next
    })
  }
  const toggleFold = (projectId: string) => {
    setFolded((prev) => {
      const next = { ...prev, [projectId]: !prev[projectId] }
      api.kv.set("projects_sb.folded", next)
      return next
    })
  }

  // ---- data loading ----
  const refreshAll = async () => {
    try {
      const [sessRes, statRes] = await Promise.all([
        api.client.experimental.session.list({ limit: cfg.limit }),
        api.client.session.status(),
      ])
      if (sessRes.error) {
        setError("Failed to load sessions")
        return
      }
      const next: GlobalSession[] = Array.isArray(sessRes.data) ? sessRes.data : []
      const stats = statRes.data && !statRes.error ? statRes.data : {}
      setSessions(next)
      setStatuses((prev) => ({ ...prev, ...stats }))
      setError(undefined)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Load failed")
    }
  }
  await refreshAll()

  // ---- events ----
  const unsubs: Array<() => void> = []

  const clearAwaiting = (sessionID: string) =>
    setAwaiting((prev) => {
      if (!prev[sessionID]) return prev
      const next = { ...prev }
      delete next[sessionID]
      return next
    })

  const clearCompleted = (sessionID: string) =>
    setCompleted((prev) => {
      if (!prev[sessionID]) return prev
      const next = { ...prev }
      delete next[sessionID]
      return next
    })

  const markCompleted = (sessionID: string) => {
    const route = api.route.current
    if (route.name === "session" && route.params?.sessionID === sessionID) return
    setCompleted((prev) => ({ ...prev, [sessionID]: true }))
  }

  unsubs.push(
    api.event.on("session.status", (evt) => {
      const { sessionID, status } = evt.properties
      const previous = statuses()[sessionID]
      setStatuses((prev) => ({ ...prev, [sessionID]: status }))
      if (status.type === "busy") {
        clearAwaiting(sessionID)
        clearCompleted(sessionID)
      } else if (
        status.type === "idle" &&
        (previous?.type === "busy" || previous?.type === "retry")
      ) {
        markCompleted(sessionID)
      }
    }),
  )

  unsubs.push(
    api.event.on("session.idle", (evt) => {
      const sessionID = evt.properties.sessionID
      const previous = statuses()[sessionID]
      setStatuses((prev) => ({
        ...prev,
        [sessionID]: { type: "idle" },
      }))
      if (previous?.type === "busy" || previous?.type === "retry") {
        markCompleted(sessionID)
      }
    }),
  )

  unsubs.push(
    api.event.on("session.updated", (evt) => {
      const info = evt.properties.info
      setSessions((prev) =>
        prev.map((s) =>
          s.id === info.id ? { ...s, title: info.title, time: info.time } : s,
        ),
      )
    }),
  )

  unsubs.push(api.event.on("session.created", () => void refreshAll()))
  unsubs.push(api.event.on("session.deleted", () => void refreshAll()))
  unsubs.push(api.event.on("project.updated", () => void refreshAll()))

  unsubs.push(
    api.event.on("question.asked", (evt) =>
      setAwaiting((prev) => ({ ...prev, [evt.properties.sessionID]: true })),
    ),
  )
  unsubs.push(
    api.event.on("permission.asked", (evt) =>
      setAwaiting((prev) => ({ ...prev, [evt.properties.sessionID]: true })),
    ),
  )
  unsubs.push(
    api.event.on("question.replied", (evt) => clearAwaiting(evt.properties.sessionID)),
  )
  unsubs.push(
    api.event.on("question.rejected", (evt) => clearAwaiting(evt.properties.sessionID)),
  )
  unsubs.push(
    api.event.on("permission.replied", (evt) => clearAwaiting(evt.properties.sessionID)),
  )
  unsubs.push(
    api.event.on("permission.v2.replied", (evt) => clearAwaiting(evt.properties.sessionID)),
  )

  for (const unsub of unsubs) api.lifecycle.onDispose(unsub)

  // ---- keymap ----
  api.keymap.registerLayer({
    commands: [
      {
        name: "projects-sidebar.toggle",
        title: "Toggle projects sidebar",
        category: "UI",
        namespace: "palette",
        run: () => toggle(),
      },
      {
        name: "projects-sidebar.refresh",
        title: "Refresh projects sidebar",
        category: "UI",
        run: () => void refreshAll(),
      },
    ],
    bindings: [
      { key: cfg.keybind, cmd: "projects-sidebar.toggle" },
      { key: "ctrl+s", cmd: "projects-sidebar.toggle" },
    ],
  })

  // Render inside opencode's native session sidebar. The app slot is outside
  // the main layout and cannot be used as a flex sidebar without reflowing it.
  api.slots.register({
    slots: {
      sidebar_content(ctx) {
        return (
          <Show when={open()}>
            <SidebarPanel
              api={api}
              theme={ctx.theme}
              cfg={cfg}
              toggle={toggle}
              toggleFold={toggleFold}
              folded={folded}
              sessions={sessions}
              statuses={statuses}
              awaiting={awaiting}
              completed={completed}
              clearCompleted={clearCompleted}
              error={error}
              refresh={refreshAll}
            />
          </Show>
        )
      },
    },
  })
}

// ---------------------------------------------------------------------------

type PanelProps = {
  api: TuiPluginApi
  theme: TuiTheme
  cfg: Cfg
  toggle: () => void
  toggleFold: (projectId: string) => void
  folded: () => Record<string, boolean>
  sessions: () => GlobalSession[]
  statuses: () => Record<string, SessionStatus>
  awaiting: () => Record<string, boolean>
  completed: () => Record<string, boolean>
  clearCompleted: (sessionID: string) => void
  error: () => string | undefined
  refresh: () => Promise<void>
}

type ProjectGroup = {
  project: ProjectSummary
  sessions: GlobalSession[]
}

function SidebarPanel(props: PanelProps) {
  const t = () => props.theme.current
  const cfg = props.cfg

  const [hoverSession, setHoverSession] = createSignal<string | undefined>()
  const [now, setNow] = createSignal(Date.now())

  createEffect(() => {
    const h = setInterval(() => setNow(Date.now()), 60_000)
    onCleanup(() => clearInterval(h))
  })

  const currentID = createMemo(() => {
    const route = props.api.route.current
    if (route.name !== "session") return undefined
    return route.params?.sessionID
  })

  createEffect(() => {
    const id = currentID()
    if (typeof id === "string") props.clearCompleted(id)
  })

  const list = createMemo<ProjectGroup[]>(() => {
    void now()
    const map = new Map<string, ProjectGroup>()
    for (const session of props.sessions()) {
      if (session.parentID !== undefined) continue
      const key = session.project?.id ?? session.projectID
      let group = map.get(key)
      if (!group) {
        const project = session.project
        group = {
          project: {
            id: key,
            worktree: project?.worktree ?? session.directory,
            name: project?.name,
          },
          sessions: [],
        }
        map.set(key, group)
      }
      group.sessions.push(session)
    }
    const groups = [...map.values()]
    for (const group of groups) {
      group.sessions.sort(
        (a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0),
      )
    }
    groups.sort(
      (a, b) =>
        (b.sessions[0]?.time?.updated ?? 0) - (a.sessions[0]?.time?.updated ?? 0),
    )
    return groups
  })

  const totalSessions = createMemo(() =>
    list().reduce((acc, group) => acc + group.sessions.length, 0),
  )

  const colors = t()

  return (
    <box
      flexDirection="column"
      width={cfg.width}
      flexShrink={0}
      backgroundColor={colors.backgroundPanel}
    >
      {/* Header */}
      <box
        flexDirection="row"
        alignItems="center"
        paddingLeft={2}
        paddingRight={1}
        gap={1}
        flexShrink={0}
      >
        <box flexGrow={1} paddingY={1}>
          <text fg={colors.text}><b>Projects</b></text>
          <text fg={colors.textMuted}> {totalSessions()} sessions</text>
        </box>
        <Clickable fg={colors.textMuted} label="↻" run={() => void props.refresh()} />
        <Clickable fg={colors.textMuted} label=" ✕" run={props.toggle} />
      </box>

      {/* Error banner */}
      <Show when={props.error()}>
        <box paddingLeft={2} paddingTop={1} paddingBottom={1} flexShrink={0}>
          <text fg={colors.error}>⚠ {props.error()}</text>
        </box>
      </Show>

      {/* Body */}
      <scrollbox
        flexGrow={1}
        minHeight={0}
        verticalScrollbarOptions={{
          trackOptions: {
            backgroundColor: colors.backgroundPanel,
            foregroundColor: colors.backgroundElement,
          },
        }}
      >
        <For each={list()}>
          {(group) => {
            const expanded = () => !props.folded()[group.project.id]
            const projectName =
              group.project.name || baseName(group.project.worktree)
            const displayName = truncate(projectName, cfg.width - 8)

            return (
              <>
                {/* Project header */}
                <box
                  flexDirection="row"
                  alignItems="center"
                  paddingLeft={1}
                  paddingRight={1}
                  paddingTop={1}
                  gap={1}
                  flexShrink={0}
                  onMouseUp={(e: { stopPropagation(): void }) => {
                    e.stopPropagation()
                    props.toggleFold(group.project.id)
                  }}
                >
                  <text fg={colors.textMuted}>{expanded() ? "▾" : "▸"}</text>
                  <text fg={colors.text}><b>{displayName}</b></text>
                  <box flexGrow={1} />
                  <text fg={colors.textMuted}>{group.sessions.length}</text>
                </box>

                {/* Sessions */}
                <Show when={expanded()}>
                  <For each={group.sessions}>
                    {(session) => {
                      const active = () => currentID() === session.id
                      const hover = () => hoverSession() === session.id
                      const status = () => props.statuses()[session.id]
                      const isAwaiting = () => !!props.awaiting()[session.id]
                      const isCompleted = () =>
                        !active() && !!props.completed()[session.id]
                      const title = truncate(
                        session.title || "Untitled",
                        cfg.width - 10,
                      )
                      const icon = () => {
                        const st = status()
                        if (isAwaiting()) return "awaiting"
                        if (st?.type === "busy") return "busy"
                        if (st?.type === "retry") return "retry"
                        if (isCompleted()) return "completed"
                        return "idle"
                      }

                      return (
                        <box
                          flexDirection="row"
                          alignItems="center"
                          paddingLeft={3}
                          paddingRight={1}
                          height={1}
                          flexShrink={0}
                          backgroundColor={
                            active() || hover()
                              ? colors.backgroundElement
                              : undefined
                          }
                          onMouseUp={(e: { stopPropagation(): void }) => {
                            e.stopPropagation()
                            props.api.route.navigate("session", {
                              sessionID: session.id,
                            })
                          }}
                          onMouseOver={() => setHoverSession(session.id)}
                          onMouseOut={() => setHoverSession(undefined)}
                        >
                          <Show
                            when={icon() === "awaiting"}
                            fallback={
                              <Show
                                when={icon() === "busy"}
                                fallback={
                                  <Show
                                    when={icon() === "completed"}
                                    fallback={
                                      <Show
                                        when={icon() === "retry"}
                                        fallback={
                                          <text fg={colors.textMuted}>·</text>
                                        }
                                      >
                                        <text fg={colors.error}>!</text>
                                      </Show>
                                    }
                                  >
                                    <text fg={colors.success}>●</text>
                                  </Show>
                                }
                              >
                                <Spinner fg={colors.warning} />
                              </Show>
                            }
                          >
                            <BlinkingDot fg={colors.warning} />
                          </Show>

                          <text> </text>

                          <text
                            fg={
                              active() || hover()
                                ? colors.text
                                : colors.textMuted
                            }
                          >
                            {title}
                          </text>

                          <box flexGrow={1} />

                          <text fg={colors.textMuted}>
                            {timeAgo(
                              session.time?.updated ??
                                session.time?.created ??
                                Date.now(),
                            )}
                          </text>
                        </box>
                      )
                    }}
                  </For>
                </Show>
              </>
            )
          }}
        </For>

        <Show when={list().length === 0 && !props.error()}>
          <box paddingLeft={2} paddingTop={1}>
            <text fg={colors.textMuted}>No sessions yet</text>
          </box>
        </Show>
      </scrollbox>

      {/* Footer */}
      <box flexShrink={0} paddingLeft={2} paddingRight={1} paddingY={1}>
        <text fg={colors.textMuted}>
          {truncate(`ctrl+s toggle · click row to open`, cfg.width - 4)}
        </text>
      </box>
    </box>
  )
}

export default { id, tui }
