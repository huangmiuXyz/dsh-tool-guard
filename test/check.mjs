// Offline self-check for the tool-guard plugin.
//
// The fakes here mirror the REAL contracts, not invented shapes:
//
//   - `ctx.tools.guard(fn)`: `ToolGuard = (execution: Readonly<ToolExecution>) =>
//     string | undefined`, and "synchronous check; a returned string denies the
//     execution" (the `tools` Service contract). The returned value is the exact
//     disposer that unregisters the guard.
//   - `ctx.on(name, listener)`: the payload for `agent/created` is
//     `{ agent, source, signal }` (the Event contract).
//   - `ctx.agents.isOwnedBy(id, owner)`: "Test whether a live agent was created
//     through one exact parent agent's scoped context."
//   - `ctx.effect(fn, label)` / `ctx.inject(names, cb)`: Cordis registration.
//   - `webServer.register({ kind: 'exact', path, handler })`: the shipped route
//     shape, read off `dsh-edit-retry`'s host half.
//   - The control route is exercised over a REAL node:http server rather than a
//     mock req/res, so a wrong header check or a body read that never ends shows up
//     here instead of in the browser.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Repo root, resolved from this file so the check runs from any checkout. */
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  — ' + detail}`)
  if (!ok) failures++
}

// --- 1. manifests -------------------------------------------------------------
const pkg = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'))
check('package.json: name', pkg.name === 'dsh-tool-guard', pkg.name)
check('package.json: type module', pkg.type === 'module', pkg.type)
check('package.json: dsh.client.platform', pkg.dsh?.client?.platform === 'web')
// `immediately` puts the bundle in the boot-blocking tier: a module failure then
// fails the WHOLE web boot ("web boot: N entry did not activate") instead of
// degrading to one inactive plugin. Never set it without a reason.
check(
  'package.json: not in the boot-blocking tier',
  pkg.dsh?.client?.immediately === undefined,
  String(pkg.dsh?.client?.immediately)
)
check('package.json: exports ./client', typeof pkg.exports?.['./client'] === 'string', pkg.exports?.['./client'])
check('package.json: exports .', typeof pkg.exports?.['.'] === 'string', pkg.exports?.['.'])
check('package.json: bundle patch', typeof pkg.dsh?.bundle?.patch === 'string', pkg.dsh?.bundle?.patch)
// This package ships no Config schema on purpose: it must import nothing at all,
// because a profile installs it with `link:` and there is no dependency to resolve.
check('package.json: no runtime dependencies', pkg.dependencies === undefined, JSON.stringify(pkg.dependencies))

const patch = fs.readFileSync(path.join(PKG, pkg.dsh.bundle.patch), 'utf8')
check('cordis.patch.yml: inserts the package', patch.includes("name: 'dsh-tool-guard'"), patch.trim().split('\n').pop())
check('cordis.patch.yml: insert block', /^\s*-\s*insert:/m.test(patch))

// The host half must import NOTHING beyond the language itself; the client half may
// import react and react-dom only. A new import is how a `link:`-installed plugin
// starts failing to resolve.
const hostSource = fs.readFileSync(path.join(PKG, 'src', 'index.js'), 'utf8')
const clientSource = fs.readFileSync(path.join(PKG, 'src', 'client.js'), 'utf8')
const hostImports = [...hostSource.matchAll(/^\s*import\s[^\n]*?from\s+'([^']+)'/gm)].map((m) => m[1])
check('host half: imports no package', hostImports.length === 0, hostImports.join(', '))
const clientImports = [...clientSource.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1])
check(
  'client half: only react require() calls',
  clientImports.every((name) => name === 'react' || name === 'react-dom'),
  clientImports.join(', ')
)
check('client half: registers an id', clientSource.includes("id: 'dsh-tool-guard'"), 'window.__ModuleLoader__.load')

// --- 2. classification --------------------------------------------------------
const {
  AGENT_TOOLS,
  ALLOWED,
  HEADER,
  PROTOCOL,
  READ_TOOLS,
  ROUTE,
  SHELL_TOOLS,
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
} = await import(path.join(PKG, 'src', 'index.js'))

// The two halves are loaded independently (the bundle hot-reloads; the host half
// does not), so their protocol numbers are the ONLY thing keeping a saved edit from
// silently pairing a new client with a stale host. They must be edited together.
const clientProtocol = Number(clientSource.match(/^\s*const PROTOCOL = (\d+)/m)?.[1])
check('protocol: the client half declares it', Number.isInteger(clientProtocol), String(clientProtocol))
check('protocol: both halves agree', clientProtocol === PROTOCOL, `client ${clientProtocol} vs host ${PROTOCOL}`)
check(
  'protocol: the client posts the fields the host reads',
  ['allowRead', 'allowWrite', 'allowShell'].every((field) => clientSource.includes(`toggle('${field}')`))
)

const none = { read: new Set(), write: new Set(), shell: new Set(), agent: new Set() }
check('classify: write tool', classify('write', none) === 'write')
check('classify: edit is a write', classify('edit', none) === 'write')
// bash is its OWN kind, separate from writes: a shell is a superset of the write
// tools, so the two switches are different capabilities and each is wanted alone.
check('classify: bash is a shell, not a write', classify('bash', none) === 'shell')
check('classify: pwsh is a shell', classify('pwsh', none) === 'shell')
check('classify: read tool', classify('read', none) === 'read')
check('classify: grep is a read', classify('grep', none) === 'read')
check('classify: web_fetch is a read', classify('web_fetch', none) === 'read')
// Session bookkeeping is deliberately ungoverned: blocking it would interrupt work
// without protecting anything on disk.
check('classify: todo_write is ungoverned', classify('todo_write', none) === undefined)
// Delegation tools are their own kind: they change no file, and they gate whether
// this session may act THROUGH another agent — a question the other kinds cannot ask.
check('classify: subagent is a delegation tool', classify('subagent', none) === 'agent')
check('classify: subagent_fork is a delegation tool', classify('subagent_fork', none) === 'agent')
check('classify: workflow is a delegation tool', classify('workflow', none) === 'agent')
// send_message MOVED out of writes: it performs no file change, and leaving it under
// writes would let a user who disabled delegation keep driving existing children.
check('classify: send_message is delegation, not a write', classify('send_message', none) === 'agent')
// Every tool that touches another agent answers to the SAME switch, whatever its
// mechanics. list_agents used to sit under reads and interrupt_agent under nothing,
// which split the subagent surface across three switches: a user who turned
// delegation off could still enumerate and stop children.
check('classify: list_agents is delegation, not a read', classify('list_agents', none) === 'agent')
check('classify: interrupt_agent is delegation', classify('interrupt_agent', none) === 'agent')
check('classify: todo_write is ungoverned', classify('todo_write', none) === undefined)
check('classify: unknown tool is ungoverned', classify('mcp__foo__bar', none) === undefined)
// An extension outranks the built-in table, so a name can be MOVED between kinds
// rather than being unreachable behind the built-in entry.
const moved = { read: new Set(['bash']), write: new Set(), shell: new Set(), agent: new Set() }
check('classify: extension moves bash to reads', classify('bash', moved) === 'read')
const added = { read: new Set(), write: new Set(['mcp__fs__write']), shell: new Set(), agent: new Set() }
check('classify: extension adds an unknown tool', classify('mcp__fs__write', added) === 'write')
check(
  'classify: all four built-in lists non-empty',
  WRITE_TOOLS.size > 0 && READ_TOOLS.size > 0 && SHELL_TOOLS.size > 0 && AGENT_TOOLS.size > 0
)
// A name in two built-in lists would be governed by whichever set is consulted
// first, which is an invisible change of meaning — so the lists must stay disjoint.
const allLists = { read: READ_TOOLS, write: WRITE_TOOLS, shell: SHELL_TOOLS, agent: AGENT_TOOLS }
const names = Object.keys(allLists)
const overlaps = []
for (const left of names) {
  for (const right of names) {
    if (left >= right) continue
    for (const name of allLists[left]) {
      if (allLists[right].has(name)) overlaps.push(`${name} (${left}/${right})`)
    }
  }
}
check('classify: the built-in lists are disjoint', overlaps.length === 0, overlaps.join(', '))

// --- 3. the guard, per session + inheritance ----------------------------------
/** A policy record as the host stores it. */
const record = (patch = {}) => ({
  allowRead: true,
  allowWrite: true,
  allowShell: true,
  allowAgent: true,
  blocked: { read: 0, write: 0, shell: 0, agent: 0 },
  last: undefined,
  ...patch
})
const freshPolicies = (entries = {}) =>
  new Map(Object.entries(entries).map(([id, patch]) => [id, record(patch)]))
const freshTree = (entries = {}) => new Map(Object.entries(entries))
const call = (name, sessionId) => ({
  name,
  callId: 'call-1',
  arguments: {},
  signal: new AbortController().signal,
  ...(sessionId === undefined ? {} : { agent: { id: sessionId } })
})

{
  const table = freshPolicies()
  const guard = makeGuard(table, freshTree(), none)
  check('guard: allows a write while the switch is on', guard(call('write', 's1')) === undefined)
  table.set('s1', record({ allowWrite: false }))
  const reason = guard(call('write', 's1'))
  check('guard: denies a write once the switch is off', typeof reason === 'string', String(reason))
  check('guard: denial names the tool', reason.includes('"write"'), reason)
  check('guard: denial uses the requested wording', reason.includes('此操作已被用户实时禁用'), reason)
  check('guard: denial tells the model not to retry', reason.includes('Do not retry'), reason)
  check('guard: counts the denial on the owning session', table.get('s1').blocked.write === 1, String(table.get('s1').blocked.write))
  check(
    'guard: records the last denial with its session',
    table.get('s1').last?.tool === 'write' && table.get('s1').last?.sessionId === 's1'
  )
  // The whole point of separate switches: denying writes must NOT touch the shell, and
  // denying the shell must not touch writes.
  check('guard: denying writes leaves the shell alone', guard(call('bash', 's1')) === undefined)
  table.set('s1', record({ allowWrite: false, allowShell: false }))
  check('guard: the shell is denied by its own switch', typeof guard(call('bash', 's1')) === 'string')
  check('guard: the shell denial says 命令行', guard(call('bash', 's1')).includes('命令行'))
  // Delegation is its own kind: a denied shell must not follow through to it, and a
  // denied delegation must not touch the shell.
  check('guard: denying the shell leaves delegation alone', guard(call('subagent', 's1')) === undefined)
  table.set('s1', record({ allowAgent: false }))
  const agentReason = guard(call('subagent', 's1'))
  check('guard: delegation is denied by its own switch', typeof agentReason === 'string')
  check('guard: the delegation denial says 子智能体调用', agentReason.includes('子智能体调用'), agentReason)
  check('guard: denying delegation leaves the shell alone', guard(call('bash', 's1')) === undefined)
  check('guard: denying delegation leaves writes alone', guard(call('write', 's1')) === undefined)
  check('guard: the delegation counter is its own', table.get('s1').blocked.agent === 1, String(table.get('s1').blocked.agent))
  table.set('s1', record({ allowShell: false }))
  check('guard: allows again as soon as the switch is back on', guard(call('write', 's1')) === undefined)
}

{
  // THE core scoping promise: restricting one session must not touch another.
  const table = freshPolicies()
  const guard = makeGuard(table, freshTree(), none)
  table.set('s1', record({ allowWrite: false }))
  check('scope: the restricted session is denied', typeof guard(call('write', 's1')) === 'string')
  check('scope: an unrelated session is untouched', guard(call('write', 's2')) === undefined)
  check('scope: and stays untouched for reads', guard(call('read', 's2')) === undefined)
  table.set('s2', record({ allowRead: false }))
  check(
    'scope: each session keeps its own read switch',
    guard(call('read', 's1')) === undefined && typeof guard(call('read', 's2')) === 'string'
  )
  table.set('s1', record())
  check('scope: releasing one session does not release the other', typeof guard(call('read', 's2')) === 'string')
  // Delegation is scoped like everything else.
  table.set('s1', record({ allowAgent: false }))
  check('scope: delegation is denied in the restricted session', typeof guard(call('subagent', 's1')) === 'string')
  check('scope: and still allowed in the other', guard(call('subagent', 's2')) === undefined)
}

{
  // Inheritance: a restriction reaches what the session spawned, however deep, and
  // whether or not the child existed when the switch was flipped.
  const table = freshPolicies()
  const tree = freshTree({ child: 'root', grand: 'child' })
  const guard = makeGuard(table, tree, none)
  check('inherit: an unrestricted tree allows everything', guard(call('write', 'grand')) === undefined)
  // Restrict the ROOT, after the descendants already exist — the lazy walk is what
  // makes this work without re-visiting them.
  table.set('root', record({ allowWrite: false }))
  check('inherit: the root is denied', typeof guard(call('write', 'root')) === 'string')
  check('inherit: the child inherits', typeof guard(call('write', 'child')) === 'string')
  check('inherit: the grandchild inherits', typeof guard(call('write', 'grand')) === 'string')
  check('inherit: the inherited denial still allows reads', guard(call('read', 'grand')) === undefined)
  // Releasing the root releases the whole subtree at once.
  table.delete('root')
  check('inherit: releasing the root releases the child', guard(call('write', 'child')) === undefined)
  check('inherit: releasing the root releases the grandchild', guard(call('write', 'grand')) === undefined)
  check('inherit: an unrelated session is untouched', guard(call('write', 'other')) === undefined)
}

{
  // A child may hold its own restriction; the NEAREST one wins, so restricting a
  // child inside a restricted parent does not silently reuse the parent's policy.
  const table = freshPolicies()
  const tree = freshTree({ child: 'root' })
  const guard = makeGuard(table, tree, none)
  table.set('root', record({ allowRead: false }))
  check('inherit: the child sees the parent restriction', typeof guard(call('read', 'child')) === 'string')
  table.set('child', record({ allowShell: false }))
  check("inherit: the child's own policy wins over the parent's", guard(call('read', 'child')) === undefined)
  check("inherit: and the child's own restriction applies", typeof guard(call('bash', 'child')) === 'string')
  check('inherit: the parent keeps its own policy', typeof guard(call('read', 'root')) === 'string')
  check("inherit: the parent is not given the child's shell rule", guard(call('bash', 'root')) === undefined)
}

{
  // A call with no agent has no session to carry a policy, so it is out of scope
  // rather than implicitly denied.
  const table = freshPolicies({ root: { allowRead: false, allowWrite: false, allowShell: false, allowAgent: false } })
  const guard = makeGuard(table, freshTree(), none)
  check('scope: an agentless call is not governed', guard(call('write', undefined)) === undefined)
  check('scope: an agentless call records nothing', table.get('root').blocked.write === 0)
  check('scope: an ungoverned tool is never blocked', guard(call('todo_write', 'root')) === undefined)
  check('scope: an ungoverned call records nothing', table.get('root').last === undefined)
}

{
  // A cycle would hang the tool pipeline inside a synchronous guard, where a hang
  // cannot be timed out. The walk must terminate and answer.
  const table = freshPolicies()
  const tree = freshTree({ a: 'b', b: 'a' })
  const guard = makeGuard(table, tree, none)
  check('safety: a parent cycle terminates', guard(call('write', 'a')) === undefined)
  table.set('a', record({ allowWrite: false }))
  check('safety: a parent cycle still resolves the restriction', typeof guard(call('write', 'a')) === 'string')
}

{
  // Unreadable policy objects must fail CLOSED: only an exact `true` permits.
  const table = new Map([['root', { blocked: { read: 0, write: 0, shell: 0, agent: 0 } }]])
  const guard = makeGuard(table, freshTree(), none)
  check('safety: an absent allowWrite fails closed', typeof guard(call('write', 'root')) === 'string')
  check('safety: an absent allowRead fails closed', typeof guard(call('read', 'root')) === 'string')
  check('safety: an absent allowAgent fails closed', typeof guard(call('subagent', 'root')) === 'string')
}

// --- 4. extensions ------------------------------------------------------------
{
  const extensions = readExtensions({
    DSH_TOOL_GUARD_WRITE: ' mcp__fs__write , mcp__fs__remove ',
    DSH_TOOL_GUARD_READ: 'mcp__fs__read',
    DSH_TOOL_GUARD_SHELL: 'mcp__exec__run',
    DSH_TOOL_GUARD_AGENT: 'mcp__orchestrate__spawn'
  })
  check(
    'env: write names parsed and trimmed',
    extensions.write.has('mcp__fs__write') && extensions.write.has('mcp__fs__remove')
  )
  check('env: read names parsed', extensions.read.has('mcp__fs__read'))
  check('env: shell names parsed', extensions.shell.has('mcp__exec__run'))
  check('env: agent names parsed', extensions.agent.has('mcp__orchestrate__spawn'))
  const empty = readExtensions(undefined)
  check(
    'env: absent vars yield empty sets',
    empty.write.size === 0 && empty.read.size === 0 && empty.shell.size === 0 && empty.agent.size === 0
  )
  const table = freshPolicies({ root: { allowWrite: false } })
  check('env: an extended write tool is denied', typeof makeGuard(table, freshTree(), extensions)(call('mcp__fs__write', 'root')) === 'string')
  const shellTable = freshPolicies({ root: { allowShell: false } })
  check(
    'env: an extended shell tool is denied',
    typeof makeGuard(shellTable, freshTree(), extensions)(call('mcp__exec__run', 'root')) === 'string'
  )
  const agentTable = freshPolicies({ root: { allowAgent: false } })
  check(
    'env: an extended delegation tool is denied',
    typeof makeGuard(agentTable, freshTree(), extensions)(call('mcp__orchestrate__spawn', 'root')) === 'string'
  )
}

// --- 5. the live pipeline, over a real HTTP server ----------------------------
/**
 * A Cordis-shaped context that registers the bundle the way the Loader would, with
 * a REAL http server standing in for `webServer` and a fake agent registry that can
 * answer `isOwnedBy` — so the route, the header check, the body read, and the
 * parent detection are all exercised end to end.
 */
function fakeHost() {
  const guards = []
  const routes = new Map()
  const listeners = new Map()
  const live = []
  const owners = new Map()
  const server = http.createServer((req, res) => {
    const route = routes.get(new URL(req.url, 'http://localhost').pathname)
    if (route === undefined) {
      res.writeHead(404).end()
      return
    }
    route(req, res)
  })
  const webServer = {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    }
  }
  const agents = {
    list: () => [...live],
    isOwnedBy: (id, owner) => owners.get(id) === owner.id,
    /** Test-only: create an agent, optionally owned by an existing one. */
    spawn(id, parentId) {
      live.push({ id })
      if (parentId !== undefined) owners.set(id, parentId)
      const payload = { agent: { id }, source: 'startup' }
      for (const listener of listeners.get('agent/created') ?? []) listener(payload)
    },
    dispose(id) {
      const index = live.findIndex((agent) => agent.id === id)
      if (index >= 0) live.splice(index, 1)
      for (const listener of listeners.get('agent/disposed') ?? []) listener({ agent: { id } })
    }
  }
  const ctx = {
    tools: {
      guard(fn) {
        guards.push(fn)
        return () => {
          const index = guards.indexOf(fn)
          if (index >= 0) guards.splice(index, 1)
        }
      }
    },
    on(name, listener) {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
      return () => {
        const at = list.indexOf(listener)
        if (at >= 0) list.splice(at, 1)
      }
    },
    get: (name) => (name === 'webServer' ? webServer : name === 'agents' ? agents : undefined),
    inject: (names, callback) => callback({ webServer, agents, effect: (fn) => fn() }),
    effect: (fn) => fn()
  }
  return { agents, ctx, guards, routes, server }
}

// The module-level tables are shared with `apply`, so clear them before wiring the
// fake host; the assertions below read them directly.
policies.clear()
parents.clear()

const host = fakeHost()
const { apply } = await import(path.join(PKG, 'src', 'index.js'))
apply(host.ctx)
check('apply: registers exactly one guard', host.guards.length === 1, String(host.guards.length))
check('apply: registers the control route', host.routes.has(ROUTE), ROUTE)

await new Promise((resolve) => host.server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${host.server.address().port}`
const get = (sessionId) =>
  fetch(sessionId === undefined ? `${base}${ROUTE}` : `${base}${ROUTE}?sessionId=${encodeURIComponent(sessionId)}`)
const post = (body, withHeader = true) =>
  fetch(`${base}${ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(withHeader ? { [HEADER]: '1' } : {}) },
    body: JSON.stringify(body)
  })

try {
  // Two independent sessions, plus a delegated child and grandchild under the first.
  // Spawning AFTER apply is what proves parent detection runs on live creation.
  host.agents.spawn('root-a')
  host.agents.spawn('root-b')
  host.agents.spawn('child-a', 'root-a')
  host.agents.spawn('grand-a', 'child-a')
  check('tree: the child link was recorded', parents.get('child-a') === 'root-a', String(parents.get('child-a')))
  check('tree: the grandchild link was recorded', parents.get('grand-a') === 'child-a', String(parents.get('grand-a')))
  check('tree: a top-level session has no link', !parents.has('root-a'))

  {
    const answer = await get('root-a')
    const payload = await answer.json()
    check('route: GET answers ok', answer.status === 200 && payload.ok === true, String(answer.status))
    // A fresh load must change NOTHING: every switch on, i.e. every kind allowed.
    check(
      'route: GET starts with every kind allowed',
      payload.state?.allowRead === true &&
        payload.state?.allowWrite === true &&
        payload.state?.allowShell === true &&
        payload.state?.allowAgent === true
    )
    check('route: the snapshot advertises its protocol', payload.state?.protocol === PROTOCOL, String(payload.state?.protocol))
    check('route: the snapshot names the session', payload.state?.sessionId === 'root-a')
    check('route: a fresh session is not inherited', payload.state?.inherited === false)
  }
  {
    const answer = await get()
    check('route: GET without a session is refused', answer.status === 400, String(answer.status))
    check('route: the refusal names the parameter', String((await answer.json()).error).includes('sessionId'))
  }
  {
    // A cross-origin page can POST a "simple" request without a preflight; requiring
    // the custom header is what makes the browser block it.
    const answer = await post({ sessionId: 'root-a', allowWrite: false }, false)
    check('route: POST without the header is refused', answer.status === 403, String(answer.status))
    check('route: refusal names the missing header', String((await answer.json()).error).includes(HEADER))
  }
  {
    const answer = await post({ allowWrite: false })
    check('route: POST without a session is refused', answer.status === 400, String(answer.status))
  }
  {
    const answer = await post({ sessionId: 'root-a', allowWrite: false })
    const payload = await answer.json()
    check('route: POST flips the switch', answer.status === 200 && payload.state?.allowWrite === false)
    check('route: POST answers the state it now holds', payload.state?.allowRead === true && payload.state?.allowShell === true)
  }
  {
    const guard = host.guards[0]
    const reason = guard(call('write', 'root-a'))
    check('live: the guard denies immediately after the POST', typeof reason === 'string', String(reason))
    check('live: the reason is the exact user-facing wording', reason.includes('此操作已被用户实时禁用'), reason)
    check('live: the read side is untouched', guard(call('read', 'root-a')) === undefined)
    check('live: the shell side is untouched by the write switch', guard(call('bash', 'root-a')) === undefined)
  }
  {
    // THE scoping promise, over the wire: a second session is unaffected.
    const payload = await (await get('root-b')).json()
    check('live: another session is untouched', payload.state?.allowWrite === true)
    check('live: and its guard lets the write through', host.guards[0](call('write', 'root-b')) === undefined)
  }
  {
    // Inheritance over the wire: the child and grandchild follow the root.
    check('live: the child inherits the restriction', typeof host.guards[0](call('write', 'child-a')) === 'string')
    check('live: the grandchild inherits the restriction', typeof host.guards[0](call('write', 'grand-a')) === 'string')
    const payload = await (await get('grand-a')).json()
    check('live: an inheriting session reports its owner', payload.state?.ownerId === 'root-a', String(payload.state?.ownerId))
    check('live: and is flagged as inherited', payload.state?.inherited === true)
  }
  {
    // Editing from the child edits the ROOT: releasing there must release the whole
    // subtree, because that is what the user means by "this session".
    const payload = await (await post({ sessionId: 'grand-a', allowWrite: true })).json()
    check('live: an edit from a descendant is accepted', payload.state?.allowWrite === true)
    check('live: releasing from the descendant released the child', host.guards[0](call('write', 'child-a')) === undefined)
    check('live: releasing from the descendant released the root', host.guards[0](call('write', 'root-a')) === undefined)
    check('live: the other session was never involved', (await (await get('root-b')).json()).state?.allowWrite === true)
  }
  {
    const answer = await post({ sessionId: 'root-a', allowShell: false, allowRead: false })
    const payload = await answer.json()
    check('route: both switches are settable at once', payload.state?.allowShell === false && payload.state?.allowRead === false)
    const guard = host.guards[0]
    check('live: the shell switch denies bash', typeof guard(call('bash', 'root-a')) === 'string')
    check('live: the read switch denies read', typeof guard(call('read', 'root-a')) === 'string')
    check('live: and the file tools are still allowed', guard(call('write', 'root-a')) === undefined)
  }
  {
    // The subagent switch, end to end. Every tool that touches another agent answers
    // to it — spawning, driving, enumerating, and stopping — so turning delegation
    // off cannot be worked around by using a different verb on the same children.
    const payload = await (
      await post({ sessionId: 'root-a', allowRead: true, allowShell: true, allowAgent: false })
    ).json()
    check('route: the subagent switch is settable', payload.state?.allowAgent === false)
    const guard = host.guards[0]
    check('live: subagents deny subagent', typeof guard(call('subagent', 'root-a')) === 'string')
    check('live: subagents deny subagent_fork', typeof guard(call('subagent_fork', 'root-a')) === 'string')
    check('live: subagents deny workflow', typeof guard(call('workflow', 'root-a')) === 'string')
    check('live: subagents deny send_message', typeof guard(call('send_message', 'root-a')) === 'string')
    check('live: subagents deny list_agents', typeof guard(call('list_agents', 'root-a')) === 'string')
    check('live: subagents deny interrupt_agent', typeof guard(call('interrupt_agent', 'root-a')) === 'string')
    check('live: the other session may still delegate', guard(call('subagent', 'root-b')) === undefined)
    check('live: and this session may still read', guard(call('read', 'root-a')) === undefined)
    check('live: and this session may still write', guard(call('write', 'root-a')) === undefined)
    // Inheritance reaches it: a child of a subagent-off session cannot delegate
    // either, so going one step out is not a way around the switch.
    check('live: the child inherits the subagent ban', typeof guard(call('subagent', 'child-a')) === 'string')
    const childSnapshot = await (await get('child-a')).json()
    check('route: the inherited ban is reported', childSnapshot.state?.allowAgent === false)
    await post({ sessionId: 'root-a', allowAgent: true })
    check('live: releasing subagents releases the child', guard(call('subagent', 'child-a')) === undefined)
  }
  {
    // Counters are per session and per kind, and they must survive the round trip.
    // Re-established here rather than inherited from an earlier block: dropping a
    // policy drops its counters too (that is asserted just below), so this block has
    // to create the state it measures.
    await post({ sessionId: 'root-a', allowRead: false, allowShell: false })
    const guard = host.guards[0]
    guard(call('read', 'root-a'))
    guard(call('bash', 'root-a'))
    guard(call('read', 'root-a'))
    const payload = await (await get('root-a')).json()
    check('route: the counters survive the round trip', payload.state?.blocked?.shell === 1, String(payload.state?.blocked?.shell))
    check('route: and are counted per kind', payload.state?.blocked?.read === 2, String(payload.state?.blocked?.read))
    check('route: the last denial names its tool', payload.state?.last?.tool === 'read')
    check('route: an untouched kind stays at zero', payload.state?.blocked?.write === 0, String(payload.state?.blocked?.write))
  }
  {
    // Restoring every kind drops the entry entirely, so a session returns to "no
    // policy" rather than carrying an all-true record it does not need.
    await post({ sessionId: 'root-a', allowRead: true, allowShell: true })
    check('route: an all-allowed session drops its policy entry', !policies.has('root-a'))
    check('live: and its descendants are released', host.guards[0](call('read', 'grand-a')) === undefined)
  }
  {
    // A bad-typed field sitting BESIDE a good one: the good one still applies and the
    // bad one is ignored, because the request as a whole is intelligible.
    const payload = await (await post({ sessionId: 'root-a', allowWrite: 'yes', allowRead: false })).json()
    check('route: a bad-typed field is not coerced', payload.state?.allowWrite === true, String(payload.state?.allowWrite))
    check('route: its good sibling still applies', payload.state?.allowRead === false)
    await post({ sessionId: 'root-a', allowRead: true })
  }
  {
    // The mismatch case: a NEW client's field names against an OLD host. Replayed
    // here by sending only pre-rename field names, which this revision does not
    // recognize. It must be a loud 409 rather than a silent success — silently
    // answering `ok` with unchanged state is what made a stale host look like a
    // switch that springs back on its own.
    const answer = await post({ sessionId: 'root-a', denyWrite: true })
    const payload = await answer.json()
    check('route: an unrecognized payload is refused', answer.status === 409, String(answer.status))
    check('route: the refusal names the protocol', String(payload.error).includes('protocol'), String(payload.error))
    check('route: the refusal tells the user to restart', String(payload.error).includes('restart'), String(payload.error))
  }
  {
    const answer = await fetch(`${base}${ROUTE}?sessionId=root-a`, { method: 'DELETE' })
    check('route: an unsupported method is refused', answer.status === 405, String(answer.status))
  }
  {
    // Disposal forgets the LINK but keeps the POLICY: the restriction is a user
    // decision about a session, while a finished child should not linger in the walk.
    await post({ sessionId: 'root-a', allowWrite: false })
    check('teardown: the child is restricted before disposal', typeof host.guards[0](call('write', 'child-a')) === 'string')
    host.agents.dispose('child-a')
    check('teardown: the link is forgotten', !parents.has('child-a'))
    check('teardown: the policy survives', policies.has('root-a'))
    check('teardown: the root is still restricted', typeof host.guards[0](call('write', 'root-a')) === 'string')
  }
} finally {
  await new Promise((resolve) => host.server.close(resolve))
}

// --- 6. module-level helpers --------------------------------------------------
{
  policies.clear()
  parents.clear()
  check('owner: an unrestricted session owns itself', ownerOf('solo') === 'solo')
  policies.set('p', record({ allowWrite: false }))
  parents.set('c', 'p')
  check('owner: a child resolves to its restricted parent', ownerOf('c') === 'p')
  check('policyFor: the child gets the parent policy', policyFor('c').allowWrite === false)
  check('policyFor: an unrelated session gets the default', policyFor('x').allowWrite === true)
  const snap = snapshot('c')
  check('snapshot: names the asking session', snap.sessionId === 'c')
  check('snapshot: names the owning session', snap.ownerId === 'p')
  check('snapshot: flags inheritance', snap.inherited === true)
  check('snapshot: carries the protocol', snap.protocol === PROTOCOL)
  check('snapshot: an unrestricted session reports the default', snapshot('free').allowWrite === ALLOWED.allowWrite)
  check('snapshot: carries the agent switch', snapshot('free').allowAgent === true)
  policies.clear()
  parents.clear()
}

// --- 7. the client half's wiring ----------------------------------------------
check('client: uses the documented list-slot id field', clientSource.includes(`id: ID`), 'id, not key')
check('client: the slot is conversation.input.right', clientSource.includes("const SLOT = 'conversation.input.right'"))
check('client: the slot id is its own', clientSource.includes("const ID = 'tool-guard'"))
check('client: does not set a priority (would shadow a shipped entry)', !/priority:/.test(clientSource))
check('client: the route matches the host half', clientSource.includes(`const ROUTE = '${ROUTE}'`))
check('client: portals the menu out of the composer containment context', clientSource.includes('createPortal'))
check('client: reads state with GET', clientSource.includes("method: 'GET'"))
check('client: writes state with POST', clientSource.includes("method: 'POST'"))
check('client: sends the required header', clientSource.includes('[HEADER]:'), HEADER)
check(
  'client: renders all four switches',
  ['allowRead', 'allowWrite', 'allowShell', 'allowAgent'].every((field) => clientSource.includes(`toggle('${field}')`))
)
// Scoping: every request must name the session, or the Host would edit a
// process-wide policy instead of this conversation's.
check('client: takes the slot sessionId seat', /\{\s*t: seat,\s*sessionId\s*\}/.test(clientSource))
check('client: sends the session on GET', clientSource.includes('?sessionId='))
check('client: sends the session on POST', clientSource.includes('...patch, sessionId'))
check('client: does not hardcode a session id', !/sessionId:\s*['"]/.test(clientSource))
// The inherited notice: editing a subagent's switch edits its parent, so the menu
// has to say so rather than let that read as an unrelated session changing.
check('client: surfaces an inherited policy', clientSource.includes("t('inherited')"))
// Copy the user asked to remove. Each is asserted as a NEGATIVE so a later edit
// cannot quietly bring it back and re-widen the menu.
check('client: no trigger label text', !clientSource.includes("t('trigger')"))
check('client: the icon-only trigger keeps an accessible name', clientSource.includes("'aria-label': t('title')"))
check('client: no subtitle line', !clientSource.includes("t('subtitle')"))
check('client: no not-governed paragraph', !/notGoverned/.test(clientSource))
check('client: no last-blocked line', !clientSource.includes("t('last'"))
check('client: no blocked-count readout', !/blockedRead|blockedWrite|blockedShell/.test(clientSource))
check(
  'client: every t() key exists in a dictionary',
  [...new Set([...clientSource.matchAll(/\bt\('(\w+)'/g)].map((m) => m[1]))].every((key) =>
    new RegExp(`\\n\\s+${key}:`).test(clientSource)
  ),
  [...new Set([...clientSource.matchAll(/\bt\('(\w+)'/g)].map((m) => m[1]))].join(', ')
)

// The client bundle is a classic script evaluated by the loader; a syntax error
// there is a dead control with no build step to catch it.
try {
  // eslint-disable-next-line no-new-func
  new Function(clientSource)
  check('client: parses as a script', true)
} catch (error) {
  check('client: parses as a script', false, String(error?.message ?? error))
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
