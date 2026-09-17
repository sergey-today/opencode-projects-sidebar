/** @jsxImportSource @opentui/solid */
import { mkdir, readdir, stat } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { homedir } from "node:os"
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import type {
  KeyEvent,
  RGBA,
  TextareaRenderable,
} from "@opentui/core"
import type {
  TuiPlugin,
  TuiPluginApi,
  TuiTheme,
} from "@opencode-ai/plugin/tui"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type {
  GlobalSession,
  Project,
  ProjectSummary,
  SessionStatus,
} from "@opencode-ai/sdk/v2"

const SPIN = ["◐", "◓", "◑", "◒"]
const COMPLETED_SESSIONS_KEY = "projects_sb.completed_sessions"
const PROJECT_NAMES_KEY = "projects_sb.project_names"

type Cfg = {
  width: number
  limit: number
}

function parseOptions(raw: Record<string, unknown> | undefined): Cfg {
  const width = typeof raw?.width === "number" ? Math.max(20, Math.min(60, raw.width)) : 36
  const limit = typeof raw?.limit === "number" ? raw.limit : 500
  return { width, limit }
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

function expandHome(path: string): string {
  if (path === "~") return homedir()
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return `${homedir()}${path.slice(1)}`
  }
  return path
}

function commonPrefix(values: string[]): string {
  const first = values[0] ?? ""
  let length = first.length
  for (const value of values.slice(1)) {
    while (length > 0 && !value.startsWith(first.slice(0, length))) length--
  }
  return first.slice(0, length)
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

type Indicator = "awaiting" | "busy" | "completed" | "retry" | "idle"

function StatusIndicator(props: {
  state: Indicator | undefined
  colors: TuiTheme["current"]
}) {
  return (
    <Show
      when={props.state === "awaiting"}
      fallback={
        <Show
          when={props.state === "busy"}
          fallback={
            <Show
              when={props.state === "completed"}
              fallback={
                <Show
                  when={props.state === "retry"}
                  fallback={
                    <Show when={props.state === "idle"} fallback={<></>}>
                      <text fg={props.colors.textMuted}>·</text>
                    </Show>
                  }
                >
                  <text fg={props.colors.error}>!</text>
                </Show>
              }
            >
              <text fg={props.colors.success}>●</text>
            </Show>
          }
        >
          <Spinner fg={props.colors.warning} />
        </Show>
      }
    >
      <BlinkingDot fg={props.colors.warning} />
    </Show>
  )
}

export const id = "projects-sidebar"

export const tui: TuiPlugin = async (api, rawOptions) => {
  const cfg = parseOptions(rawOptions as Record<string, unknown> | undefined)
  // The injected client scopes GET requests to the current session directory.
  const scopedClient = api.client.experimental.session as unknown as {
    client: {
      getConfig(): { baseUrl?: string; headers?: HeadersInit; fetch?: typeof fetch }
      setConfig(config: { headers?: HeadersInit }): unknown
    }
  }
  const clientConfig = scopedClient.client.getConfig()
  const headers = new Headers(clientConfig.headers)
  headers.delete("x-opencode-directory")
  headers.delete("x-opencode-workspace")
  const globalClient = createOpencodeClient({
    baseUrl: clientConfig.baseUrl,
    headers,
    fetch: clientConfig.fetch,
  })

  // ---- state ----
  const [sessions, setSessions] = createSignal<GlobalSession[]>([])
  const [projects, setProjects] = createSignal<Project[]>([])
  const [projectNames, setProjectNames] = createSignal<Record<string, string>>(
    api.kv.get<Record<string, string>>(PROJECT_NAMES_KEY) ?? {},
  )
  const [statuses, setStatuses] = createSignal<Record<string, SessionStatus>>({})
  const [awaiting, setAwaiting] = createSignal<Record<string, boolean>>({})
  const [completed, setCompleted] = createSignal<Record<string, boolean>>(
    api.kv.get<Record<string, boolean>>(COMPLETED_SESSIONS_KEY) ?? {},
  )
  const [error, setError] = createSignal<string | undefined>()

  const [folded, setFolded] = createSignal<Record<string, boolean>>(
    api.kv.get<Record<string, boolean>>("projects_sb.folded") ?? {},
  )
  const [showAllSessions, setShowAllSessions] = createSignal<Record<string, boolean>>(
    api.kv.get<Record<string, boolean>>("projects_sb.show_all_sessions") ?? {},
  )

  const toggleFold = (projectId: string) => {
    setFolded((prev) => {
      const next = { ...prev, [projectId]: !prev[projectId] }
      api.kv.set("projects_sb.folded", next)
      return next
    })
  }

  const showMoreSessions = (projectID: string) =>
    setShowAllSessions((prev) => {
      const next = { ...prev, [projectID]: true }
      api.kv.set("projects_sb.show_all_sessions", next)
      return next
    })

  const resetShownSessions = (projectID: string) =>
    setShowAllSessions((prev) => {
      if (!prev[projectID]) return prev
      const next = { ...prev }
      delete next[projectID]
      api.kv.set("projects_sb.show_all_sessions", next)
      return next
    })

  // ---- data loading ----
  const refreshAll = async () => {
    try {
      const [sessRes, projectRes, statRes] = await Promise.all([
        globalClient.experimental.session.list({ limit: cfg.limit }),
        globalClient.project.list(),
        api.client.session.status(),
      ])
      if (sessRes.error) {
        setError("Failed to load sessions")
        return
      }
      const next: GlobalSession[] = Array.isArray(sessRes.data) ? sessRes.data : []
      const nextProjects = Array.isArray(projectRes.data) ? projectRes.data : []
      const stats = statRes.data && !statRes.error ? statRes.data : {}
      setSessions(next)
      setProjects(nextProjects)
      setStatuses((prev) => ({ ...prev, ...stats }))
      setError(undefined)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Load failed")
    }
  }
  await refreshAll()
  const refreshTimer = setInterval(() => void refreshAll(), 5_000)
  api.lifecycle.onDispose(() => clearInterval(refreshTimer))

  const showActionError = (message: string) =>
    api.ui.toast({ variant: "error", message })

  // The TUI client is initialized for the directory OpenCode started in. Keep
  // it aligned with the session opened from the cross-project sidebar.
  const setSessionDirectory = (directory: string) => {
    const nextHeaders = new Headers(clientConfig.headers)
    nextHeaders.set("x-opencode-directory", encodeURIComponent(directory))
    scopedClient.client.setConfig({ headers: nextHeaders })
  }

  const openSession = (sessionID: string, directory: string) => {
    setSessionDirectory(directory)
    api.route.navigate("session", { sessionID })
  }

  const createSession = async (
    directory: string,
    fallbackDirectories: string[],
  ): Promise<boolean> => {
    try {
      let availableDirectory: string | undefined
      for (const candidate of new Set([directory, ...fallbackDirectories])) {
        try {
          if ((await stat(candidate)).isDirectory()) {
            availableDirectory = candidate
            break
          }
        } catch (err) {
          if (
            typeof err === "object" &&
            err !== null &&
            "code" in err &&
            err.code === "ENOENT"
          ) continue
          throw err
        }
      }
      if (!availableDirectory) {
        showActionError(`Project directory no longer exists: ${directory}`)
        return false
      }
      const result = await globalClient.v2.session.create({
        location: { directory: availableDirectory },
      })
      if (result.error || !result.data) {
        showActionError("Failed to create session")
        return false
      }
      await refreshAll()
      openSession(result.data.data.id, availableDirectory)
      return true
    } catch {
      showActionError("Failed to create session")
      return false
    }
  }

  const createProject = async (input: string): Promise<boolean> => {
    const directory = resolve(api.state.path.directory, expandHome(input))
    try {
      await mkdir(directory, { recursive: true })
    } catch {
      showActionError(`Failed to create project directory: ${directory}`)
      return false
    }
    return createSession(directory, [])
  }

  const renameSession = async (
    sessionID: string,
    directory: string,
    title: string,
  ): Promise<boolean> => {
    try {
      const result = await globalClient.session.update({
        sessionID,
        directory,
        title,
      })
      if (result.error) {
        showActionError("Failed to rename session")
        return false
      }
      await refreshAll()
      return true
    } catch {
      showActionError("Failed to rename session")
      return false
    }
  }

  const renameProject = async (
    projectID: string | undefined,
    directory: string,
    name: string,
  ): Promise<boolean> => {
    if (!projectID) {
      setProjectNames((prev) => {
        const next = { ...prev, [directory]: name }
        api.kv.set(PROJECT_NAMES_KEY, next)
        return next
      })
      return true
    }
    try {
      const result = await globalClient.project.update({
        projectID,
        directory,
        name,
      })
      if (result.error) {
        showActionError("Failed to rename project")
        return false
      }
      await refreshAll()
      return true
    } catch {
      showActionError("Failed to rename project")
      return false
    }
  }

  const openPrompt = (
    title: string,
    value: string,
    onConfirm: (value: string) => Promise<boolean>,
  ) => {
    const DialogPrompt = api.ui.DialogPrompt
    api.ui.dialog.replace(() => (
      <DialogPrompt
        title={title}
        value={value}
        onConfirm={(input) => {
          const next = input.trim()
          if (!next) return
          void onConfirm(next).then((success) => {
            if (success) api.ui.dialog.clear()
          })
        }}
        onCancel={() => api.ui.dialog.clear()}
      />
    ))
  }

  const suggestedProjectDirectory = () => {
    const roots = new Map<
      string,
      { projects: Set<string>; sessions: number }
    >()

    for (const session of sessions()) {
      const worktree = session.project?.worktree
      if (
        session.parentID !== undefined ||
        !session.project ||
        !worktree ||
        worktree === "/"
      ) {
        continue
      }
      const directory = dirname(worktree)
      const root = roots.get(directory) ?? {
        projects: new Set<string>(),
        sessions: 0,
      }
      root.projects.add(session.project.id)
      root.sessions++
      roots.set(directory, root)
    }

    let best: { directory: string; projects: number; sessions: number } | undefined
    for (const [directory, root] of roots) {
      const candidate = {
        directory,
        projects: root.projects.size,
        sessions: root.sessions,
      }
      if (
        !best ||
        candidate.projects > best.projects ||
        (candidate.projects === best.projects && candidate.sessions > best.sessions)
      ) {
        best = candidate
      }
    }
    return best?.directory ?? dirname(api.state.path.directory)
  }

  const openProjectDialog = () => {
    api.ui.dialog.setSize("medium")
    api.ui.dialog.replace(() => (
      <ProjectPathDialog
        baseDirectory={api.state.path.directory}
        colors={api.theme.current}
        initialValue={suggestedProjectDirectory()}
        onConfirm={createProject}
        onCancel={() => api.ui.dialog.clear()}
      />
    ))
  }

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
      api.kv.set(COMPLETED_SESSIONS_KEY, next)
      return next
    })

  const markCompleted = (sessionID: string) => {
    const route = api.route.current
    if (route.name === "session" && route.params?.sessionID === sessionID) return
    setCompleted((prev) => {
      if (prev[sessionID]) return prev
      const next = { ...prev, [sessionID]: true }
      api.kv.set(COMPLETED_SESSIONS_KEY, next)
      return next
    })
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

  // OpenCode orders native MCP and LSP content at 200 and 300 respectively.
  api.slots.register({
    order: 350,
    slots: {
      sidebar_content(ctx) {
        return (
          <SidebarPanel
            api={api}
            theme={ctx.theme}
            cfg={cfg}
            toggleFold={toggleFold}
            folded={folded}
            showAllSessions={showAllSessions}
            sessions={sessions}
            projects={projects}
            projectNames={projectNames}
            statuses={statuses}
            awaiting={awaiting}
            completed={completed}
            clearCompleted={clearCompleted}
            showMoreSessions={showMoreSessions}
            resetShownSessions={resetShownSessions}
            createSession={createSession}
            openProjectDialog={openProjectDialog}
            renameSession={renameSession}
            renameProject={renameProject}
            openPrompt={openPrompt}
            openSession={openSession}
            error={error}
          />
        )
      },
    },
  })
}

// ---------------------------------------------------------------------------

type ProjectPathDialogProps = {
  baseDirectory: string
  colors: TuiTheme["current"]
  initialValue: string
  onConfirm: (value: string) => Promise<boolean>
  onCancel: () => void
}

function ProjectPathDialog(props: ProjectPathDialogProps) {
  const [completion, setCompletion] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  let textarea: TextareaRenderable

  onMount(() => {
    setTimeout(() => textarea?.focus(), 1)
    textarea.gotoLineEnd()
  })

  const completePath = async (event: KeyEvent) => {
    if (event.name.toLowerCase() !== "tab") return
    event.preventDefault()
    event.stopPropagation()

    const current = textarea.plainText
    const separator = Math.max(current.lastIndexOf("/"), current.lastIndexOf("\\"))
    const directoryPart = separator >= 0 ? current.slice(0, separator + 1) : ""
    const prefix = current.slice(separator + 1)
    const lookupDirectory = resolve(
      props.baseDirectory,
      expandHome(directoryPart || "."),
    )

    try {
      const entries = await readdir(lookupDirectory, { withFileTypes: true })
      const matches = entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
        .map((entry) => entry.name)
        .sort()

      if (matches.length === 0) {
        setCompletion("No matching directories")
        return
      }

      const nextPart = commonPrefix(matches)
      if (nextPart.length === prefix.length && matches.length > 1) {
        setCompletion(`${matches.length} matching directories`)
        return
      }

      const next = `${directoryPart}${nextPart}${matches.length === 1 ? "/" : ""}`
      textarea.setText(next)
      textarea.gotoLineEnd()
      setCompletion(
        matches.length === 1
          ? "Directory completed"
          : `${matches.length} matching directories`,
      )
    } catch {
      setCompletion("Directory not found")
    }
  }

  const submit = () => {
    const next = textarea.plainText.trim()
    if (!next || busy()) return
    setBusy(true)
    textarea.blur()
    void props.onConfirm(next).then((success) => {
      if (success) {
        props.onCancel()
      } else {
        setBusy(false)
        textarea.focus()
      }
    }).catch(() => {
      setBusy(false)
      textarea.focus()
    })
  }

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={props.colors.text}><b>New project</b></text>
        <text fg={props.colors.textMuted} onMouseUp={props.onCancel}>esc</text>
      </box>
      <box gap={1}>
        <text fg={props.colors.textMuted}>
          Enter a directory path. Press Tab to complete directories.
        </text>
        <textarea
          height={3}
          ref={(value) => (textarea = value)}
          initialValue={props.initialValue}
          placeholder="~/projects/my-project"
          placeholderColor={props.colors.textMuted}
          textColor={busy() ? props.colors.textMuted : props.colors.text}
          focusedTextColor={busy() ? props.colors.textMuted : props.colors.text}
          cursorColor={busy() ? props.colors.backgroundElement : props.colors.text}
          onSubmit={submit}
          onKeyDown={completePath}
        />
        <Show when={completion()}>
          <text fg={props.colors.textMuted}>{completion()}</text>
        </Show>
        <Show when={busy()}>
          <text fg={props.colors.textMuted}>Creating project...</text>
        </Show>
      </box>
      <box paddingBottom={1} gap={1} flexDirection="row">
        <Show when={!busy()} fallback={<text fg={props.colors.textMuted}>processing...</text>}>
          <text fg={props.colors.text}>enter <span style={{ fg: props.colors.textMuted }}>submit</span></text>
        </Show>
      </box>
    </box>
  )
}

type PanelProps = {
  api: TuiPluginApi
  theme: TuiTheme
  cfg: Cfg
  toggleFold: (projectId: string) => void
  folded: () => Record<string, boolean>
  showAllSessions: () => Record<string, boolean>
  sessions: () => GlobalSession[]
  projects: () => Project[]
  projectNames: () => Record<string, string>
  statuses: () => Record<string, SessionStatus>
  awaiting: () => Record<string, boolean>
  completed: () => Record<string, boolean>
  clearCompleted: (sessionID: string) => void
  showMoreSessions: (projectID: string) => void
  resetShownSessions: (projectID: string) => void
  createSession: (directory: string, fallbackDirectories: string[]) => Promise<boolean>
  openProjectDialog: () => void
  renameSession: (sessionID: string, directory: string, title: string) => Promise<boolean>
  renameProject: (projectID: string | undefined, directory: string, name: string) => Promise<boolean>
  openPrompt: (
    title: string,
    value: string,
    onConfirm: (value: string) => Promise<boolean>,
  ) => void
  openSession: (sessionID: string, directory: string) => void
  error: () => string | undefined
}

type ProjectGroup = {
  project: ProjectSummary
  renameProjectID?: string
  sessions: GlobalSession[]
}

function SidebarPanel(props: PanelProps) {
  const t = () => props.theme.current
  const cfg = props.cfg

  const [hoverProject, setHoverProject] = createSignal<string | undefined>()
  const [hoverSession, setHoverSession] = createSignal<string | undefined>()
  let projectHoverTimer: ReturnType<typeof setTimeout> | undefined
  let sessionHoverTimer: ReturnType<typeof setTimeout> | undefined
  const [now, setNow] = createSignal(Date.now())

  createEffect(() => {
    const h = setInterval(() => setNow(Date.now()), 60_000)
    onCleanup(() => clearInterval(h))
  })

  const showProjectHover = (projectID: string) => {
    if (projectHoverTimer) clearTimeout(projectHoverTimer)
    projectHoverTimer = undefined
    setHoverProject(projectID)
  }

  const hideProjectHover = () => {
    if (projectHoverTimer) clearTimeout(projectHoverTimer)
    projectHoverTimer = setTimeout(() => {
      projectHoverTimer = undefined
      setHoverProject(undefined)
    }, 100)
  }

  const showSessionHover = (sessionID: string) => {
    if (sessionHoverTimer) clearTimeout(sessionHoverTimer)
    sessionHoverTimer = undefined
    setHoverSession(sessionID)
  }

  const hideSessionHover = () => {
    if (sessionHoverTimer) clearTimeout(sessionHoverTimer)
    sessionHoverTimer = setTimeout(() => {
      sessionHoverTimer = undefined
      setHoverSession(undefined)
    }, 100)
  }

  onCleanup(() => {
    if (projectHoverTimer) clearTimeout(projectHoverTimer)
    if (sessionHoverTimer) clearTimeout(sessionHoverTimer)
  })

  const currentID = createMemo(() => {
    const route = props.api.route.current
    if (route.name !== "session") return undefined
    return route.params?.sessionID
  })

  const sessionIsActive = (session: GlobalSession) =>
    !!props.awaiting()[session.id] ||
    props.statuses()[session.id]?.type === "busy" ||
    props.statuses()[session.id]?.type === "retry" ||
    !!props.completed()[session.id]

  const visibleSessions = (group: ProjectGroup) => {
    if (props.showAllSessions()[group.project.id]) return group.sessions

    const recent = group.sessions.slice(0, 1)
    const recentIDs = new Set(recent.map((session) => session.id))
    return [
      ...recent,
      ...group.sessions.filter(
        (session) => !recentIDs.has(session.id) && sessionIsActive(session),
      ),
    ]
  }

  createEffect(() => {
    const id = currentID()
    if (typeof id === "string") props.clearCompleted(id)
  })

  const list = createMemo<ProjectGroup[]>(() => {
    void now()
    const map = new Map<string, ProjectGroup>()
    const projectsByWorktree = new Map<string, ProjectSummary>()
    const projectsByID = new Map<string, ProjectSummary>()
    for (const project of props.projects()) {
      if (project.worktree === "/") continue
      projectsByWorktree.set(project.worktree, project)
      projectsByID.set(project.id, project)
    }
    for (const session of props.sessions()) {
      if (session.parentID !== undefined || !session.project || session.project.worktree === "/") continue
      projectsByWorktree.set(session.project.worktree, session.project)
      projectsByID.set(session.project.id, session.project)
    }

    for (const session of props.sessions()) {
      if (session.parentID !== undefined) continue
      const globalSession = !session.project || session.project.worktree === "/"
      // Global sessions retain their directory but share a synthetic project
      // record rooted at /. Reuse a known project for that directory when one
      // exists; otherwise keep the directory in its own sidebar group.
      const project = globalSession
        ? projectsByWorktree.get(session.directory) ?? projectsByID.get(session.projectID)
        : session.project
      const key = project?.id ?? `directory:${session.directory}`
      let group = map.get(key)
      if (!group) {
        group = {
          project: {
            id: key,
            worktree: project?.worktree ?? session.directory,
            name: project?.name ?? props.projectNames()[session.directory],
          },
          renameProjectID: project?.id,
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

  const projectCount = createMemo(() => list().length)
  const sessionCount = createMemo(() =>
    list().reduce((count, group) => count + group.sessions.length, 0),
  )

  const colors = t()

  return (
    <box
      flexDirection="column"
      flexShrink={0}
      marginLeft={-1}
    >
      {/* Error banner */}
      <Show when={props.error()}>
        <box paddingLeft={2} paddingTop={1} paddingBottom={1} flexShrink={0}>
          <text fg={colors.error}>⚠ {props.error()}</text>
        </box>
      </Show>

      <box
        flexDirection="row"
        alignItems="center"
        paddingLeft={1}
        paddingRight={1}
        height={1}
        flexShrink={0}
      >
        <text fg={colors.text}><b>Projects / Sessions</b></text>
        <box flexGrow={1} />
        <text fg={colors.textMuted}>{projectCount()} / {sessionCount()}</text>
        <text
          fg={colors.primary}
          onMouseUp={(e: { stopPropagation(): void }) => {
            e.stopPropagation()
            props.openProjectDialog()
          }}
        >
          +
        </text>
      </box>

      <box flexDirection="column" flexShrink={0}>
        <For each={list()}>
          {(group) => {
            const expanded = () => !props.folded()[group.project.id]
            const projectHover = () => hoverProject() === group.project.id
            const projectName =
              group.project.name || baseName(group.project.worktree)
            const displayName = truncate(projectName, cfg.width - 8)
            const groupIndicator = (): Indicator | undefined => {
              if (group.sessions.some((session) => props.awaiting()[session.id])) {
                return "awaiting"
              }
              if (
                group.sessions.some(
                  (session) => props.statuses()[session.id]?.type === "busy",
                )
              ) {
                return "busy"
              }
              if (
                group.sessions.some(
                  (session) => props.statuses()[session.id]?.type === "retry",
                )
              ) {
                return "retry"
              }
              if (
                group.sessions.some(
                  (session) =>
                    session.id !== currentID() && !!props.completed()[session.id],
                )
              ) {
                return "completed"
              }
              return undefined
            }

            return (
              <>
                {/* Project header */}
                <box
                  flexDirection="row"
                  alignItems="center"
                  paddingLeft={1}
                  paddingRight={1}
                  gap={1}
                  flexShrink={0}
                  backgroundColor={projectHover() ? colors.backgroundElement : undefined}
                  onMouseUp={(e: { stopPropagation(): void }) => {
                    e.stopPropagation()
                    if (expanded()) props.resetShownSessions(group.project.id)
                    props.toggleFold(group.project.id)
                  }}
                  onMouseOver={() => showProjectHover(group.project.id)}
                  onMouseOut={hideProjectHover}
                >
                  <text fg={colors.textMuted}>{expanded() ? "▾" : "▸"}</text>
                  <text fg={colors.text}><b>{displayName}</b></text>
                  <Show when={!expanded()}>
                    <StatusIndicator state={groupIndicator()} colors={colors} />
                  </Show>
                  <box flexGrow={1} />
                  <Show
                    when={projectHover()}
                    fallback={
                      <text fg={colors.textMuted}>{group.sessions.length}</text>
                    }
                  >
                    <text
                      fg={colors.primary}
                      onMouseUp={(e: { stopPropagation(): void }) => {
                        e.stopPropagation()
                        props.createSession(
                          group.project.worktree,
                          group.sessions.map((session) => session.directory),
                        )
                      }}
                    >
                      +
                    </text>
                    <text
                      fg={colors.primary}
                      onMouseUp={(e: { stopPropagation(): void }) => {
                        e.stopPropagation()
                        props.openPrompt(
                          "Rename project",
                          projectName,
                          (name) =>
                            props.renameProject(
                              group.renameProjectID,
                              group.project.worktree,
                              name,
                            ),
                        )
                      }}
                    >
                      ✎
                    </text>
                  </Show>
                </box>

                {/* Sessions */}
                <Show when={expanded()}>
                  <For each={visibleSessions(group)}>
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
                      const icon = (): Indicator => {
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
                            props.openSession(session.id, session.directory)
                          }}
                          onMouseOver={() => showSessionHover(session.id)}
                          onMouseOut={hideSessionHover}
                        >
                          <StatusIndicator state={icon()} colors={colors} />

                          <text> </text>

                          <text
                            fg={active() ? colors.warning : hover() ? colors.text : colors.textMuted}
                          >
                            {active() ? <b>{title}</b> : title}
                          </text>

                          <box flexGrow={1} />

                          <Show
                            when={hover()}
                            fallback={
                              <text fg={colors.textMuted}>
                                {timeAgo(
                                  session.time?.updated ??
                                    session.time?.created ??
                                    Date.now(),
                                )}
                              </text>
                            }
                          >
                            <text
                              fg={colors.primary}
                              onMouseUp={(e: { stopPropagation(): void }) => {
                                e.stopPropagation()
                                props.openPrompt(
                                  "Rename session",
                                  session.title || "Untitled",
                                  (name) =>
                                    props.renameSession(
                                      session.id,
                                      session.directory,
                                      name,
                                    ),
                                )
                              }}
                            >
                              ✎
                            </text>
                          </Show>
                        </box>
                      )
                    }}
                  </For>
                  <Show
                    when={
                      !props.showAllSessions()[group.project.id] &&
                      visibleSessions(group).length < group.sessions.length
                    }
                  >
                    <box
                      paddingLeft={5}
                      height={1}
                      flexShrink={0}
                      onMouseUp={(e: { stopPropagation(): void }) => {
                        e.stopPropagation()
                        props.showMoreSessions(group.project.id)
                      }}
                    >
                      <text fg={colors.primary}>more</text>
                    </box>
                  </Show>
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
      </box>
    </box>
  )
}

export default { id, tui }
