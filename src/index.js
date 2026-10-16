/**
 * Tool guard, host half: a live per-session kill-switch for reads, writes, and the
 * shell.
 *
 * WHAT "LIVE" MEANS HERE
 *   The switch is a `ctx.tools.guard()`. A guard is a SYNCHRONOUS monotonic check
 *   that runs inside the tool pipeline after the `tools/pre-execute` waterfall and
 *   before dispatch. It resolves the calling agent's policy on every call, so
 *   flipping a switch changes the very next tool call — no reload, no restart, not
 *   even a re-render. A denial returns a string, and that string is the reason the
 *   model reads (it becomes the call's `ToolFailure.message`, and its rendered
 *   content).
 *
 * WHY A GUARD AND NOT `tools/pre-execute`
 *   The `tools` contract names the two on purpose: "A denial that must hold
 *   regardless of order is a `ctx.tools.guard()`; a guard is synchronous, so a
 *   decision that must await something, such as asking the user, returns `ask`
 *   from `tools/pre-execute`." This decision awaits nothing, so it belongs in a
 *   guard, where no other listener's ordering can route around it.
 *
 * SCOPE: ONE SESSION, PLUS WHAT IT SPAWNED
 *   A policy is held by ONE session. The menu edits that session, and every agent
 *   descended from it resolves to the same policy, so the two behave as one unit:
 *   restricting a session restricts the subagents it delegates to. This matters
 *   because `subagent` and `workflow` are NOT themselves governed — they touch
 *   nothing, they only create children. If a child did not inherit, delegating
 *   would be a one-step way around the switch.
 *
 *   Inheritance is resolved LAZILY, by walking the parent chain at call time
 *   rather than copying a policy into each child when it is created. Lazily is
 *   what makes a later-created grandchild inherit with no extra work, and what
 *   makes un-restricting a parent release every descendant at once.
 *
 *   Why the guard is registered globally and scopes itself from `exec.agent`,
 *   instead of being registered per `agent.ctx`: a single guard resolving
 *   `exec.agent.id` is one table lookup, it covers agents that do not exist yet,
 *   and it keeps the policy table the single source of truth. Registering N
 *   scoped guards would need one registration per live agent plus a rule for each
 *   agent born later, and the two would have to be kept in step.
 *
 *   A call with NO agent is not governed: it has no session to carry a policy, so
 *   there is nothing the user could have switched off for it.
 *
 * WHAT IT DOES NOT DO
 *   Classification is by TOOL NAME. A shell command is classified by the tool that
 *   would run it, not by scanning its arguments: `bash` is never parsed to guess
 *   whether `rm` or `ls` is inside. Guessing would be wrong in both directions — a
 *   `cat` could hide a redirect — and the alternative, letting every shell through,
 *   would make the switch decorative. Unknown tools (an MCP server, a third-party
 *   plugin) are deliberately NOT classified: guessing "write" for an unknown name
 *   would block harmless tools and guessing "read" would let a writer through.
 *   Extend the tables with the `DSH_TOOL_GUARD_*` environment variables instead.
 *
 * PERSISTENCE
 *   Policies live in this process's memory only. A DSH restart clears every switch
 *   back to "everything allowed". That is deliberate for a panic switch — a
 *   restriction the user forgot about should not survive a restart — but it does
 *   mean the switch is not durable configuration.
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
 * restart. Bump this whenever a field is renamed, a switch is added, or the route's
 * shape changes.
 */
const PROTOCOL = 4

/**
 * Tools that change files, and so are refused while writes are disabled.
 *
 * `subagent`/`workflow` are NOT here — they touch nothing themselves, and the child
 * agent's own tool calls resolve to the same policy through the parent chain, so a
 * subagent is stopped at the point where it actually writes. `todo_write` /
 * `create_goal` are NOT here either: they only move the agent's own bookkeeping and
 * touching them would interrupt work without protecting anything.
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

/** Every governed kind, in the order the control lists them. */
const KINDS = ['read', 'write', 'shell']

/** The policy field that owns each kind. */
const SWITCH_FOR = { read: 'allowRead', write: 'allowWrite', shell: 'allowShell' }

/** The policy every session has until the user restricts it. */
const ALLOWED = Object.freeze({ allowRead: true, allowWrite: true, allowShell: true })

/**
 * The live switch, per session.
 *
 * A session appears here only once it has been restricted; absence means every
 * kind is allowed. Each value is phrased as PERMISSION, not refusal: a switch that
 * is ON means the kind is allowed, which is what the control shows and what a user
 * reads a switch as meaning.
 *
 * `blocked` and `last` are diagnostics: they are what distinguishes a restriction
 * that is working from one that was configured but never fired. The control no
 * longer prints them, but they stay on the snapshot because reading one JSON
 * response is the fastest way to answer "is this guard actually running".
 */
const policies = new Map()

/**
 * Who spawned whom, for every live agent — restricted or not.
 *
 * This is separate from `policies` on purpose. A link must be recorded even while
 * both ends are unrestricted, because a session can be restricted LATER, and by
 * then the only moment at which `isOwnedBy` can answer "who is the parent" has
 * already passed for the cheapest case. Keeping the whole tree means the walk below
 * always has somewhere to go.
 */
const parents = new Map()

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
 * The session whose policy governs one session: itself, or its nearest restricted
 * ancestor.
 *
 * Walking up rather than copying a policy down is what makes restriction behave as
 * one unit across a delegation tree — a parent restricted after a child was
 * created still governs that child, and releasing the parent releases every
 * descendant that had no restriction of its own.
 *
 * The `seen` guard is not defensive padding: a cycle would hang the TOOL PIPELINE,
 * and this walk runs inside a synchronous guard where a hang cannot be timed out.
 * The registry is not supposed to produce cycles, but the cost of being wrong here
 * is a wedged session rather than a wrong answer.
 * @param table - the policy map to read.
 * @param tree - the child→parent map.
 * @param sessionId - the session asking.
 * @returns the id of the session that holds the applicable policy.
 */
function ownerIn(table, tree, sessionId) {
  let current = sessionId
  const seen = new Set()
  while (typeof current === 'string' && !seen.has(current)) {
    if (table.has(current)) return current
    seen.add(current)
    current = tree.get(current)
  }
  // Nobody above holds a policy. This session is the one that will hold the next
  // edit, so it is its own owner.
  return sessionId
}

/** `ownerIn` over the live tables. */
function ownerOf(sessionId) {
  return ownerIn(policies, parents, sessionId)
}

/** The effective policy for one session, whether held by it or inherited. */
function policyFor(sessionId) {
  return policies.get(ownerOf(sessionId)) ?? ALLOWED
}

/**
 * Build the synchronous guard over one live policy table.
 *
 * A factory rather than a module-level function so the guard reads the same table
 * the HTTP handler mutates, and so a test can drive an isolated copy.
 * @param table - the policy map to read.
 * @param tree - the child→parent map used to resolve inheritance.
 * @param extensions - extra per-kind tool names.
 * @returns the guard, in the `ctx.tools.guard()` shape.
 */
function makeGuard(table, tree, extensions) {
  return function guard(exec) {
    const sessionId = exec.agent?.id
    // No agent means no session to carry a policy: nothing was switched off for
    // this call, so it is out of scope rather than implicitly denied.
    if (typeof sessionId !== 'string') return undefined
    const kind = classify(exec.name, extensions)
    if (kind === undefined) return undefined
    // Resolve the owner ONCE and reuse it: the walk runs inside the pipeline, and
    // asking for the owner twice per call is work with no second answer.
    const ownerId = ownerIn(table, tree, sessionId)
    const policy = table.get(ownerId) ?? ALLOWED
    // Fail CLOSED on an unreadable switch: only an exact `true` permits. A policy
    // object from an older revision, or one a caller built by hand, would otherwise
    // read `undefined` as permission and let a revoked kind straight through.
    if (policy[SWITCH_FOR[kind]] === true) return undefined
    const record = table.get(ownerId)
    if (record !== undefined) {
      record.blocked[kind] += 1
      record.last = { tool: exec.name, kind, at: new Date().toISOString(), sessionId }
    }
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
 * The snapshot the control renders for ONE session.
 *
 * `ownerId` is sent because the control needs to say when a switch it is showing is
 * actually held by an ancestor: without that, a subagent's menu would look like the
 * place its restriction was set, and unchecking it there would look like it should
 * not affect the parent.
 */
function snapshot(sessionId) {
  const ownerId = ownerOf(sessionId)
  const policy = policies.get(ownerId) ?? ALLOWED
  const record = policies.get(ownerId)
  return {
    protocol: PROTOCOL,
    sessionId,
    ownerId,
    inherited: ownerId !== sessionId,
    allowRead: policy.allowRead,
    allowWrite: policy.allowWrite,
    allowShell: policy.allowShell,
    blocked: { ...(record?.blocked ?? { read: 0, write: 0, shell: 0 }) },
    last: record?.last
  }
}

/** A session id as it may appear in a query string or a JSON body. */
function cleanSessionId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined
}

/**
 * Serve the control route.
 *
 * GET reads one session's switch; POST flips it on the session that owns the
 * policy. Only the three booleans are accepted, so a malformed or hostile payload
 * can do nothing beyond the same toggle the control offers.
 */
async function handleState(req, res) {
  const url = new URL(req.url ?? ROUTE, 'http://localhost')
  if (req.method === 'GET') {
    const sessionId = cleanSessionId(url.searchParams.get('sessionId'))
    if (sessionId === undefined) {
      sendJson(res, 400, { ok: false, error: 'missing sessionId query parameter' })
      return
    }
    sendJson(res, 200, { ok: true, state: snapshot(sessionId) })
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
  const sessionId = cleanSessionId(payload.sessionId)
  if (sessionId === undefined) {
    sendJson(res, 400, { ok: false, error: 'missing sessionId in the request body' })
    return
  }
  const recognized = KINDS.filter((kind) => typeof payload[SWITCH_FOR[kind]] === 'boolean')
  // A body that names no field this revision knows is not a no-op to shrug off: it
  // means the caller and this host disagree about the protocol (a hot-reloaded
  // client against a host that predates the field rename, say). Answering `ok` with
  // unchanged state is what made that mismatch look like a switch that springs back
  // on its own, so say so instead.
  if (recognized.length === 0) {
    sendJson(res, 409, {
      ok: false,
      error:
        `this host speaks tool-guard protocol ${PROTOCOL} and recognized none of the ` +
        `fields in the request; it is probably running older code than the page — restart DSH`
    })
    return
  }
  // The edit lands on the session that OWNS the policy, not necessarily the one
  // that asked. A subagent showing an inherited restriction must be able to release
  // it, and releasing it for the whole tree is what the user means by "this session".
  const ownerId = ownerOf(sessionId)
  const current = policies.get(ownerId)
  const next = {
    allowRead: current?.allowRead ?? ALLOWED.allowRead,
    allowWrite: current?.allowWrite ?? ALLOWED.allowWrite,
    allowShell: current?.allowShell ?? ALLOWED.allowShell
  }
  for (const kind of recognized) next[SWITCH_FOR[kind]] = payload[SWITCH_FOR[kind]]
  if (next.allowRead && next.allowWrite && next.allowShell) {
    // Nothing is restricted, so there is no policy to hold. Dropping the entry is
    // what lets a later-created descendant inherit "allowed" by simple absence,
    // instead of every session accumulating an entry it does not need.
    policies.delete(ownerId)
  } else {
    policies.set(ownerId, {
      ...next,
      blocked: current?.blocked ?? { read: 0, write: 0, shell: 0 },
      last: current?.last
    })
  }
  sendJson(res, 200, { ok: true, state: snapshot(sessionId) })
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
 * Record who spawned one agent, so a restriction can reach it later.
 *
 * `isOwnedBy` is the authoritative answer and needs no assumption about listener
 * ordering or about a causal-parent ambient being in scope at this moment. Scanning
 * every live agent is O(live agents) and runs once per creation, which is the
 * cheapest reliable way to ask the registry a question it answers per candidate.
 *
 * A failure here is swallowed into "no known parent": the consequence is that a
 * restriction may not reach that one child, which is strictly better than failing
 * agent creation.
 * @returns the parent's id, or undefined for a top-level agent.
 */
function detectParent(agents, child) {
  try {
    for (const candidate of agents.list()) {
      if (candidate.id === child.id) continue
      if (agents.isOwnedBy(child.id, candidate)) return candidate.id
    }
  } catch {
    /* an older registry without isOwnedBy: leave the tree flat */
  }
  return undefined
}

/**
 * Services required before `apply` may run.
 *
 * `tools` is a hard dependency: the guard IS the feature, so a deployment without
 * the registry should keep this plugin inactive rather than half-mounted. `agents`
 * is NOT listed: the guard scopes itself from `exec.agent` and works without any
 * registry, so an `inject` edge on it would take the whole feature down on a
 * deployment that happened not to provide it — only inheritance would be lost.
 */
export const inject = ['tools']

export function apply(ctx) {
  ctx.effect(
    () => ctx.tools.guard(makeGuard(policies, parents, readExtensions(process.env))),
    'tool-guard: live guard'
  )

  // Record the delegation tree. Both listeners are registered through the same
  // optional-service probe, so a deployment without `agents` keeps the guard and
  // simply has a flat tree (every session its own owner).
  const agents = ctx.get('agents')
  if (agents !== undefined) {
    ctx.effect(
      () => ctx.on('agent/created', ({ agent }) => {
        const parentId = detectParent(agents, agent)
        if (parentId !== undefined) parents.set(agent.id, parentId)
      }),
      'tool-guard: delegation tree'
    )
    ctx.effect(
      () => ctx.on('agent/disposed', ({ agent }) => {
        // The LINK goes, the POLICY stays: the restriction is an explicit user
        // decision about a session, and a session that closes and is resumed later
        // should still be restricted. Keeping the link would instead keep a
        // finished child in the walk forever.
        parents.delete(agent.id)
      }),
      'tool-guard: tree cleanup'
    )
  }

  const server = ctx.get('webServer')
  if (server !== undefined) registerRoute(ctx, server)
  else ctx.inject(['webServer'], (scope) => registerRoute(scope, scope.webServer))
}

export {
  ALLOWED,
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
  ownerOf,
  parents,
  policies,
  policyFor,
  readExtensions,
  snapshot
}
