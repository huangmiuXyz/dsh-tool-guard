// Offline self-check for the tool-guard plugin.
//
// The fakes here mirror the REAL contracts, not invented shapes:
//
//   - `ctx.tools.guard(fn)`: `ToolGuard = (execution: Readonly<ToolExecution>) =>
//     string | undefined`, and "synchronous check; a returned string denies the
//     execution" (the `tools` Service contract). The returned value is the exact
//     disposer that unregisters the guard.
//   - `ctx.effect(fn, label)`: Cordis effect registration; `fn` returns a disposer.
//   - `ctx.inject(names, cb)`: deferred registration once the named services exist.
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
const { HEADER, PROTOCOL, READ_TOOLS, ROUTE, SHELL_TOOLS, WRITE_TOOLS, classify, denyReason, makeGuard, readExtensions } =
  await import(path.join(PKG, 'src', 'index.js'))

// The two halves are loaded independently (the bundle hot-reloads; the host half
// does not), so their protocol numbers are the ONLY thing keeping a saved edit from
// silently pairing a new client with a stale host. They must be edited together.
const clientProtocol = Number(clientSource.match(/^\s*const PROTOCOL = (\d+)/m)?.[1])
check('protocol: the client half declares it', Number.isInteger(clientProtocol), String(clientProtocol))
check(
  'protocol: both halves agree',
  clientProtocol === PROTOCOL,
  `client ${clientProtocol} vs host ${PROTOCOL}`
)
// A field rename is exactly what a protocol bump accompanies, so assert the
// renamed fields are the ones the client actually posts.
check(
  'protocol: the client posts the fields the host reads',
  ['allowRead', 'allowWrite', 'allowShell'].every((field) => clientSource.includes(`toggle('${field}')`))
)

const none = { read: new Set(), write: new Set(), shell: new Set() }
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
check('classify: subagent is ungoverned', classify('subagent', none) === undefined)
check('classify: unknown tool is ungoverned', classify('mcp__foo__bar', none) === undefined)
// An extension outranks the built-in table, so a name can be MOVED between kinds
// rather than being unreachable behind the built-in entry.
const moved = { read: new Set(['bash']), write: new Set(), shell: new Set() }
check('classify: extension moves bash to reads', classify('bash', moved) === 'read')
const added = { read: new Set(), write: new Set(['mcp__fs__write']), shell: new Set() }
check('classify: extension adds an unknown tool', classify('mcp__fs__write', added) === 'write')
check(
  'classify: all three built-in lists non-empty',
  WRITE_TOOLS.size > 0 && READ_TOOLS.size > 0 && SHELL_TOOLS.size > 0
)
// A name in two built-in lists would be governed by whichever set is consulted
// first, which is an invisible change of meaning — so the lists must stay disjoint.
const allLists = { read: READ_TOOLS, write: WRITE_TOOLS, shell: SHELL_TOOLS }
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

// --- 3. the guard -------------------------------------------------------------
// Every switch starts ALLOWED, which is what "on" means after the flip.
const fresh = () => ({
  allowRead: true,
  allowWrite: true,
  allowShell: true,
  blocked: { read: 0, write: 0, shell: 0 },
  last: undefined
})
const call = (name) => ({ name, callId: 'call-1', arguments: {}, signal: new AbortController().signal })

{
  const live = fresh()
  const guard = makeGuard(live, none)
  check('guard: allows a write while the switch is on', guard(call('write')) === undefined)
  live.allowWrite = false
  const reason = guard(call('write'))
  check('guard: denies a write once the switch is off', typeof reason === 'string', String(reason))
  check('guard: denial names the tool', reason.includes('"write"'), reason)
  check('guard: denial uses the requested wording', reason.includes('此操作已被用户实时禁用'), reason)
  check('guard: denial tells the model not to retry', reason.includes('Do not retry'), reason)
  check('guard: counts the denial', live.blocked.write === 1, String(live.blocked.write))
  check('guard: records the last denial', live.last?.tool === 'write' && live.last?.kind === 'write')
  // The whole point of three switches: turning writes off must NOT touch the shell,
  // and turning the shell off must not touch writes. This is the pair that regressed
  // when bash lived in the write list.
  check('guard: disabling writes leaves the shell alone', guard(call('bash')) === undefined)
  live.allowShell = false
  check('guard: the shell is denied by its own switch', typeof guard(call('bash')) === 'string')
  check('guard: the shell denial says 命令行', guard(call('bash')).includes('命令行'), guard(call('bash')))
  // Turning it back on must restore the very next call — that is the whole promise.
  live.allowWrite = true
  check('guard: allows again as soon as the switch is back on', guard(call('write')) === undefined)
}

{
  const live = fresh()
  const guard = makeGuard(live, none)
  live.allowRead = false
  check('guard: denies a read when only reads are off', typeof guard(call('read')) === 'string')
  check('guard: still allows a write when only reads are off', guard(call('write')) === undefined)
  check('guard: still allows the shell when only reads are off', guard(call('bash')) === undefined)
  check('guard: read count is separate', live.blocked.read === 1 && live.blocked.write === 0)
  check('guard: read reason differs from the write reason', denyReason('read', 'read') !== denyReason('write', 'write'))
  check('guard: shell reason differs from the write reason', denyReason('bash', 'shell') !== denyReason('write', 'write'))
}

{
  const live = fresh()
  live.allowRead = false
  live.allowWrite = false
  live.allowShell = false
  const guard = makeGuard(live, none)
  check('guard: ungoverned tool is never blocked', guard(call('todo_write')) === undefined)
  check('guard: ungoverned call records nothing', live.last === undefined && live.blocked.write === 0)
}

// --- 4. extensions ------------------------------------------------------------
{
  const extensions = readExtensions({
    DSH_TOOL_GUARD_WRITE: ' mcp__fs__write , mcp__fs__remove ',
    DSH_TOOL_GUARD_READ: 'mcp__fs__read',
    DSH_TOOL_GUARD_SHELL: 'mcp__exec__run'
  })
  check('env: write names parsed and trimmed', extensions.write.has('mcp__fs__write') && extensions.write.has('mcp__fs__remove'))
  check('env: read names parsed', extensions.read.has('mcp__fs__read'))
  check('env: shell names parsed', extensions.shell.has('mcp__exec__run'))
  const empty = readExtensions(undefined)
  check(
    'env: absent vars yield empty sets',
    empty.write.size === 0 && empty.read.size === 0 && empty.shell.size === 0
  )
  const live = fresh()
  live.allowWrite = false
  const guard = makeGuard(live, extensions)
  check('env: an extended write tool is denied', typeof guard(call('mcp__fs__write')) === 'string')
  const shellLive = fresh()
  shellLive.allowShell = false
  const shellGuard = makeGuard(shellLive, extensions)
  check('env: an extended shell tool is denied', typeof guard === 'function' && typeof shellGuard(call('mcp__exec__run')) === 'string')
}

// --- 5. the live pipeline, over a real HTTP server ----------------------------
/**
 * A Cordis-shaped context that registers the bundle the way the Loader would, and
 * a REAL http server standing in for `webServer` — so the route, the header check
 * and the body read are exercised end to end instead of being asserted about.
 */
function fakeHost() {
  const guards = []
  const routes = new Map()
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
    get: (name) => (name === 'webServer' ? webServer : undefined),
    inject: (names, callback) => {
      const scope = { webServer, effect: (fn) => fn() }
      callback(scope)
    },
    effect: (fn) => {
      const disposer = fn()
      return disposer
    }
  }
  return { ctx, guards, server, routes }
}

const host = fakeHost()
const { apply } = await import(path.join(PKG, 'src', 'index.js'))
apply(host.ctx)
check('apply: registers exactly one guard', host.guards.length === 1, String(host.guards.length))
check('apply: registers the control route', host.routes.has(ROUTE), ROUTE)

await new Promise((resolve) => host.server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${host.server.address().port}`
const post = (body, withHeader) =>
  fetch(`${base}${ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(withHeader ? { [HEADER]: '1' } : {}) },
    body: JSON.stringify(body)
  })

try {
  {
    const answer = await fetch(`${base}${ROUTE}`)
    const payload = await answer.json()
    check('route: GET answers ok', answer.status === 200 && payload.ok === true, String(answer.status))
    // A fresh load must change NOTHING: every switch on, i.e. every kind allowed.
    check(
      'route: GET starts with every kind allowed',
      payload.state?.allowWrite === true && payload.state?.allowRead === true && payload.state?.allowShell === true
    )
  }
  {
    // A cross-origin page can POST a "simple" request without a preflight; requiring
    // the custom header is what makes the browser block it.
    const answer = await post({ allowWrite: false }, false)
    check('route: POST without the header is refused', answer.status === 403, String(answer.status))
    const payload = await answer.json()
    check('route: refusal names the missing header', String(payload.error).includes(HEADER), String(payload.error))
  }
  {
    const answer = await post({ allowWrite: false }, true)
    const payload = await answer.json()
    check('route: POST with the header flips the switch', answer.status === 200 && payload.state?.allowWrite === false)
    check('route: POST answers the state it now holds', payload.state?.allowRead === true)
    check('route: the snapshot carries all three switches', payload.state?.allowShell === true)
  }
  {
    const guard = host.guards[0]
    const reason = guard(call('write'))
    check('live: the guard denies immediately after the POST', typeof reason === 'string', String(reason))
    check('live: the reason is the exact user-facing wording', reason.includes('此操作已被用户实时禁用'), reason)
    check('live: the read side is untouched', guard(call('read')) === undefined)
    // The regression this feature exists to fix: writes off must leave the shell on.
    check('live: the shell side is untouched by the write switch', guard(call('bash')) === undefined)
  }
  {
    const answer = await fetch(`${base}${ROUTE}`)
    const payload = await answer.json()
    check('route: the counter survives the round trip', payload.state?.blocked?.write === 1, String(payload.state?.blocked?.write))
    check('route: the last denial survives the round trip', payload.state?.last?.tool === 'write')
  }
  {
    const answer = await post({ allowWrite: true, allowRead: false }, true)
    const payload = await answer.json()
    check('route: both switches are settable at once', payload.state?.allowWrite === true && payload.state?.allowRead === false)
    const guard = host.guards[0]
    check('live: turning writes back on restores them', guard(call('write')) === undefined)
    check('live: and blocks the reads that were just turned off', typeof guard(call('read')) === 'string')
  }
  {
    // The shell switch is independent: setting it must not disturb the reads that are
    // still off, and it must actually govern `bash`.
    const answer = await post({ allowShell: false, allowRead: true }, true)
    const payload = await answer.json()
    check('route: the shell switch is settable', payload.state?.allowShell === false)
    check('route: setting the shell does not move the reads', payload.state?.allowRead === true)
    const guard = host.guards[0]
    check('live: the shell switch denies bash', typeof guard(call('bash')) === 'string')
    check('live: and leaves the file tools alone', guard(call('write')) === undefined)
    check('live: the shell count is its own', (await (await fetch(`${base}${ROUTE}`)).json()).state?.blocked?.shell === 1)
  }
  {
    const answer = await post({ allowShell: true }, true)
    check('route: the shell switch can be turned back on', (await answer.json()).state?.allowShell === true)
    check('live: and bash is restored', host.guards[0](call('bash')) === undefined)
  }
  {
    // A bad-typed field sitting BESIDE a good one: the good one still applies and the
    // bad one is ignored, because the request as a whole is intelligible.
    const answer = await post({ allowWrite: 'yes', allowRead: false }, true)
    const payload = await answer.json()
    check('route: a bad-typed field is not coerced', payload.state?.allowWrite === true, String(payload.state?.allowWrite))
    check('route: its good sibling still applies', payload.state?.allowRead === false)
    await post({ allowRead: true }, true)
  }
  {
    // The mismatch case: a NEW client's field names against an OLD host. Replayed
    // here by sending only pre-rename field names, which this revision does not
    // recognize. It must be a loud 409 rather than a silent success — silently
    // answering `ok` with unchanged state is what made a stale host look like a
    // switch that springs back on its own.
    const answer = await post({ denyWrite: true }, true)
    const payload = await answer.json()
    check('route: an unrecognized payload is refused', answer.status === 409, String(answer.status))
    check('route: the refusal names the protocol', String(payload.error).includes('protocol'), String(payload.error))
    check('route: the refusal tells the user to restart', String(payload.error).includes('restart'), String(payload.error))
  }
  {
    const snapshotPayload = await (await fetch(`${base}${ROUTE}`)).json()
    check('route: the snapshot advertises its protocol', typeof snapshotPayload.state?.protocol === 'number', String(snapshotPayload.state?.protocol))
  }
  {
    const answer = await fetch(`${base}${ROUTE}`, { method: 'DELETE' })
    check('route: an unsupported method is refused', answer.status === 405, String(answer.status))
  }
} finally {
  await new Promise((resolve) => host.server.close(resolve))
}

// --- 6. the client half's wiring ----------------------------------------------
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
  'client: renders all three switches',
  ['allowRead', 'allowWrite', 'allowShell'].every((field) => clientSource.includes(`toggle('${field}')`))
)
// Copy the user asked to remove. Each one is asserted as a NEGATIVE so a later edit
// cannot quietly bring it back and re-widen the menu.
check('client: no trigger label text', !clientSource.includes("t('trigger')"))
check('client: the icon-only trigger keeps an accessible name', clientSource.includes("'aria-label': t('title')"))
check('client: no subtitle line', !clientSource.includes("t('subtitle')"))
check('client: no not-governed paragraph', !/notGoverned/.test(clientSource))
check('client: no last-blocked line', !clientSource.includes("t('last'"))
check('client: no blocked-count readout', !/blockedRead|blockedWrite|blockedShell/.test(clientSource))
check(
  'client: every t() key exists in both dictionaries',
  (() => {
    const keys = new Set([...clientSource.matchAll(/\bt\('(\w+)'/g)].map((m) => m[1]))
    // The dictionaries are the object literals passed to locale.register.
    const used = [...keys].filter((key) => !['tool'].includes(key))
    return used.every((key) => {
      const zh = new RegExp(`\\n\\s+${key}:`).test(clientSource)
      return zh
    })
  })(),
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
