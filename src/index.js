/**
 * Tool guard, host half: a live kill-switch for reads and for writes.
 *
 * WHAT "LIVE" MEANS HERE
 *   The switch is a `ctx.tools.guard()`. A guard is a SYNCHRONOUS monotonic check
 *   that runs inside the tool pipeline after the `tools/pre-execute` waterfall and
 *   before dispatch. It reads a plain in-memory object on every call, so flipping
 *   the switch changes the very next tool call — no reload, no restart, not even a
 *   re-render. A denial returns a string, and that string is the reason the model
 *   reads (it becomes the call's `ToolFailure.message` and its rendered content).
 *
 * WHY A GUARD AND NOT `tools/pre-execute`
 *   The `tools` contract names the two on purpose: "A denial that must hold
 *   regardless of order is a `ctx.tools.guard()`; a guard is synchronous, so a
 *   decision that must await something, such as asking the user, returns `ask`
 *   from `tools/pre-execute`." This decision awaits nothing, so it belongs in a
 *   guard, where no other listener's ordering can route around it.
 *
 * WHY GLOBAL, NOT PER-SESSION
 *   A guard registered on a plain context applies to every agent; one registered
 *   through `agent.ctx` applies to a single agent. This plugin is the deployment
 *   switch — "stop touching disk while I look at something" — so it is global, and
 *   a subagent inherits it for free. The UI says so. Per-session scoping would be
 *   an addition (register the same guard on each `agent.ctx`), not a rewrite.
 *
 * WHAT IT DOES NOT DO
 *   Classification is by TOOL NAME. A shell command is classified by the tool that
 *   would run it (`bash` counts as a write, because it can write), not by scanning
 *   its arguments: `bash` is never parsed to guess whether `rm` or `ls` is inside.
 *   Guessing would be wrong in both directions — a `cat` could hide a redirect —
 *   and the alternative, letting a shell through while writes are disabled, would
 *   make the switch meaningless. Unknown tools (an MCP server, a third-party
 *   plugin) are deliberately NOT classified: guessing "write" for an unknown name
 *   would block harmless tools and guessing "read" would let a writer through. Add
 *   them to the lists below to cover them.
 */

/** Control route the client half reads and writes. Namespaced so it cannot collide. */
const ROUTE = '/dsh-tool-guard/state'
/**
 * Header the client must send on a state change. A cross-origin page can POST a
 * "simple" request without a preflight, so requiring a custom header is what
 * actually forces one — the browser then blocks the call because this server
 * answers no CORS preflight. Same-origin callers (our own client half) are
 * unaffected.
 */
const HEADER = 'x-dsh-tool-guard'

/**
 * Tools that change files, and so are refused while writes are disabled.
 *
 * `subagent`/`workflow` are NOT here — they do not touch anything themselves, and
 * the child agent's own tool calls pass through this same global guard, so a
 * subagent is stopped at the point where it actually writes. `todo_write` /
 * `create_goal` are NOT here either: they only move the agent's own bookkeeping
 * and touching them would interrupt work without protecting anything.
 */
const WRITE_TOOLS = new Set([
  'write',
  'edit',
  'plugin_manager',
  'present',
  'send_message',
  'import_chat'
])

/**
 * Tools that run an arbitrary command, and so are refused while the shell is off.
 *
 * This is its own switch, separate from writes, because the two are different
 * capabilities and each is wanted without the other: refusing commands while the
 * structured file tools stay available is a real posture, and so is inspecting the
 * tree with `ls`/`git status` while `write`/`edit` are refused.
 *
 * THE ASYMMETRY, STATED PLAINLY: a shell is a SUPERSET of the write tools. `bash`
 * can write any file, delete any tree, and reach the network, so **allowing the
 * shell while denying writes does not prevent writes** — it only stops the tools
 * named for it. That is the honest consequence of splitting the switch, which is
 * why the menu says it beside the shell row instead of leaving it to be inferred.
 * Denying the shell is the strong setting; denying writes is the precise one.
 */
const SHELL_TOOLS = new Set(['bash', 'pwsh'])

/**
 * Tools that only observe, and so are refused while reads are disabled.
 *
 * Every entry was taken from this deployment's own tool list. The set is a
 * whitelist on purpose: a name that is NOT here is not blocked as a read, which is
 * what keeps an unknown plugin tool from being misread as harmless.
 */
const READ_TOOLS = new Set([
  'read',
  'glob',
  'grep',
  'read_image',
  'web_search',
  'web_fetch',
  'list_agents',
  'job_output',
  'job_list',
  'get_goal',
  'skill',
  'cordis_inspect_list',
  'cordis_inspect_query',
  'load_workspace_dependencies'
])

/**
 * The live switch.
 *
 * Each field is phrased as PERMISSION, not refusal: a switch that is ON means the
 * kind is allowed, which is what the control shows and what a user reads a switch
 * as meaning. Every kind starts allowed, so a fresh load changes nothing.
 *
 * Read on every guarded call, so a write from the HTTP handler is visible to the
 * next tool call with no coordination. The counters and `last` are kept on the
 * snapshot as evidence that the guard is firing at all — a restriction that
 * silently blocks nothing looks identical to one that is broken — but the control
 * no longer prints them, because the switches already say what the state is.
 *
 * The three switches are genuinely independent: revoking `write` does not revoke
 * `shell` and vice versa. See SHELL_TOOLS for why that is a deliberate tradeoff
 * rather than an oversight.
 */
const state = {
  /** Allow read tools. */
  allowRead: true,
  /** Allow write tools. */
  allowWrite: true,
  /** Allow shell tools. */
  allowShell: true,
  /** Denials since load, per kind; reported on the snapshot, not rendered. */
  blocked: { read: 0, write: 0, shell: 0 },
  /** The most recent denial: `{ tool, kind, at }`. */
  last: undefined
}

/** Every governed kind, in the order the control lists them. */
const KINDS = ['read', 'write', 'shell']

/** The state field that owns each kind. */
const SWITCH_FOR = { read: 'allowRead', write: 'allowWrite', shell: 'allowShell' }

/**
 * Which side of the switch a tool name falls on, or undefined for "not governed".
 *
 * Order matters once user extensions exist: an extension outranks the built-in
 * table, so naming `bash` under reads moves it rather than being unreachable
 * behind the shell entry.
 * @param name - the tool name as the model called it.
 * @param extensions - `{ read, write, shell }` sets from the environment.
 * @returns `'read'`, `'write'`, `'shell'`, or undefined.
 */
function classify(name, extensions) {
  for (const kind of KINDS) {
    if (extensions[kind].has(name)) return kind
  }
  if (READ_TOOLS.has(name)) return 'read'
  if (WRITE_TOOLS.has(name)) return 'write'
  if (SHELL_TOOLS.has(name)) return 'shell'
  return undefined
}

/**
 * Extra classifications, read once at load from the environment.
 *
 * Kept in the environment rather than in a Config schema because this package
 * ships no dependency at all — a profile installs it with `link:` and it must
 * import nothing. One variable per kind takes comma-separated tool names, which is
 * what covers an MCP server's tools without a release.
 * @returns `{ read, write, shell }` sets.
 */
function readExtensions(env) {
  const split = (raw) =>
    new Set(
      String(raw ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    )
  return {
    read: split(env?.DSH_TOOL_GUARD_READ),
    write: split(env?.DSH_TOOL_GUARD_WRITE),
    shell: split(env?.DSH_TOOL_GUARD_SHELL)
  }
}

/** The Chinese label each kind carries in a denial. */
const ZH_KIND = { read: '读操作', write: '写操作', shell: '命令行' }

/**
 * The reason the model receives, in both languages the deployment may run in.
 *
 * This string is the WHOLE message: it lands in `ToolFailure.message` and in the
 * call's rendered content, so it has to answer the model's three questions at
 * once — what happened, whether to retry, and what to do instead. It says
 * "do not retry" explicitly because a model that reads a bare refusal tends to
 * retry it, which burns a step and reads to the user as the switch not working.
 * @param name - the refused tool name.
 * @param kind - `'read'`, `'write'`, or `'shell'`.
 * @returns the denial reason.
 */
function denyReason(name, kind) {
  return (
    `此操作已被用户实时禁用：${ZH_KIND[kind]}「${name}」未执行，且不要再尝试调用。` +
    `This operation is disabled live by the user: the ${kind} tool "${name}" was not executed. ` +
    `Do not retry it — continue with what the user allows, or tell the user what you need.`
  )
}

/**
 * Build the synchronous guard over one live `state`.
 *
 * A factory rather than a module-level function so the guard reads the same object
 * the HTTP handler mutates, and so a test can drive an isolated copy.
 * @param live - the state object to read.
 * @param extensions - extra per-kind tool names.
 * @returns the guard, in the `ctx.tools.guard()` shape.
 */
function makeGuard(live, extensions) {
  return function guard(exec) {
    const kind = classify(exec.name, extensions)
    if (kind === undefined) return undefined
    // Fail CLOSED on an unreadable switch: only an exact `true` permits. A state
    // object from an older revision, or one a caller built by hand, would otherwise
    // read `undefined` as permission and let a revoked kind straight through.
    if (live[SWITCH_FOR[kind]] === true) return undefined
    live.blocked[kind] += 1
    live.last = { tool: exec.name, kind, at: new Date().toISOString() }
    return denyReason(exec.name, kind)
  }
}

// --- http ---------------------------------------------------------------------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    // The control polls this; a cached answer would show a stale switch.
    'cache-control': 'no-store'
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 10000) req.destroy()
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('aborted')))
  })
}

/**
 * Wire version of the control route, shared with the client half.
 *
 * The two halves are loaded independently: a browser bundle hot-reloads on save,
 * while this Node-side module keeps running the code it was mounted with until the
 * process restarts. So a saved edit routinely produces a NEW client talking to an
 * OLD host.
 *
 * Without this marker that mismatch is silent and looks like a bug in the switch:
 * the client posts `allowRead`, the old host only knows `denyRead`, ignores the
 * unknown field, and answers with its unchanged state — so the switch springs back
 * a moment after the click. Numbering the protocol turns that into a stated fact:
 * a client that does not see its own version says the host is stale and asks for a
 * restart. Bump this whenever a field is renamed or a switch is added.
 */
const PROTOCOL = 3

/** The snapshot the control renders. `blocked`/`last` prove the switch is firing. */
function snapshot() {
  return {
    protocol: PROTOCOL,
    allowRead: state.allowRead,
    allowWrite: state.allowWrite,
    allowShell: state.allowShell,
    blocked: { ...state.blocked },
    last: state.last
  }
}

/**
 * Serve the control route.
 *
 * GET reads the switch; POST flips it. Only the three booleans are accepted — the
 * body is otherwise ignored — so a malformed or hostile payload can do nothing
 * beyond the same toggle the control offers.
 */
async function handleState(req, res) {
  if (req.method === 'GET') {
    sendJson(res, 200, { ok: true, state: snapshot() })
    return
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'method not allowed' })
    return
  }
  if (req.headers?.[HEADER] === undefined) {
    sendJson(res, 403, { ok: false, error: `missing ${HEADER} header` })
    return
  }
  let payload = {}
  try {
    const body = await readBody(req)
    if (body) payload = JSON.parse(body)
  } catch {
    sendJson(res, 400, { ok: false, error: 'bad json body' })
    return
  }
  if (payload === null || typeof payload !== 'object') {
    sendJson(res, 400, { ok: false, error: 'bad json body' })
    return
  }
  // A body that names no field this revision knows is not a no-op to shrug off: it
  // means the caller and this host disagree about the protocol (a hot-reloaded
  // client against a host that predates the field rename, say). Answering `ok` with
  // unchanged state is what made that mismatch look like a switch that springs back
  // on its own, so say so instead.
  const recognized = KINDS.filter((kind) => typeof payload[SWITCH_FOR[kind]] === 'boolean')
  if (recognized.length === 0) {
    sendJson(res, 409, {
      ok: false,
      error:
        `this host speaks tool-guard protocol ${PROTOCOL} and recognized none of the ` +
        `fields in the request; it is probably running older code than the page — restart DSH`
    })
    return
  }
  for (const kind of recognized) {
    const field = SWITCH_FOR[kind]
    state[field] = payload[field]
  }
  sendJson(res, 200, { ok: true, state: snapshot() })
}

/**
 * Register the control route.
 *
 * `webServer` is optional — a terminal-only profile never provides it — so when it
 * is absent the route is registered if and when the service appears, instead of
 * holding the plugin's own activation open on a service that will never come. The
 * guard itself is registered unconditionally: it needs `tools` only, and a
 * deployment without a browser still wants the switch honoured for whatever flips
 * `state` (a UI-less caller can still POST to the route once it appears).
 */
function registerRoute(scope, host) {
  scope.effect(
    () => host.register({ kind: 'exact', path: ROUTE, handler: handleState }),
    'tool-guard: control route'
  )
}

/**
 * Services required before `apply` may run.
 *
 * `tools` is a hard dependency: the guard IS the feature, so a deployment without
 * the registry should keep this plugin inactive rather than half-mounted. The
 * control route's `webServer` is deliberately NOT listed — a terminal-only profile
 * never provides it, and an `inject` edge on a service that never appears would
 * hold the whole plugin inactive forever, taking the guard down with it.
 */
export const inject = ['tools']

export function apply(ctx) {
  ctx.effect(
    () => ctx.tools.guard(makeGuard(state, readExtensions(process.env))),
    'tool-guard: live guard'
  )
  const server = ctx.get('webServer')
  if (server !== undefined) registerRoute(ctx, server)
  else ctx.inject(['webServer'], (scope) => registerRoute(scope, scope.webServer))
}

export {
  HEADER,
  KINDS,
  PROTOCOL,
  READ_TOOLS,
  ROUTE,
  SHELL_TOOLS,
  SWITCH_FOR,
  WRITE_TOOLS,
  classify,
  denyReason,
  makeGuard,
  readExtensions,
  state
}
