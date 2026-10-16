// Tool guard — CLIENT half.
//
// A control on the composer's input toolbar ("conversation.input.right", the list
// slot immediately left of the model selector) with three switches: READ, WRITE,
// and SHELL. Flipping one takes effect on the very next tool call, because the host
// half enforces it with a synchronous `ctx.tools.guard()` that reads the same
// booleans this control writes. Nothing here re-renders the conversation, reloads a
// plugin, or touches the session log.
//
// What a switch means:
//   ON = ALLOWED. All three start on, so a fresh load permits everything and
//   turning one off is what disables its tools. The reverse convention (on =
//   blocked) made the default state look like a restriction.
//
// Why this slot:
//   `conversation.input.right` is a `list` slot declared by the shipped composer
//   bar, so a plain registration appends beside the other controls — no shadowing,
//   no forwarding of a shipped entry, and it is reachable in every session rather
//   than only on the new-session hero screen.
//
// Why the switches live on the Host and not in this component:
//   A client-side switch could only hide the buttons it draws. The model calls
//   tools through the Host's registry, so enforcement has to be in the pipeline —
//   that is the host half's guard. This control is a view over that state plus the
//   POSTs that flip it.
//
// What the user must be able to tell apart:
//   READ covers tools that only observe (read / glob / grep / web_search / …).
//   WRITE covers the structured file tools that change something (write / edit / …).
//   SHELL covers command execution (bash / pwsh) and is its OWN switch, because a
//   shell is a superset of the write tools: allowing the shell while denying writes
//   does not prevent writes, it only stops the tools named for it. That asymmetry is
//   stated on the shell row rather than left to be inferred. Tools that belong to no
//   kind — an MCP server, a third-party plugin — are NOT governed. Extend with the
//   DSH_TOOL_GUARD_READ / _WRITE / _SHELL env vars on the Host.
//
// Why the denial wording matters here:
//   A refused call comes back to the model as an error whose message is the whole
//   explanation. The Host's guard returns a string that says the operation is
//   disabled live AND tells the model not to retry — because a bare refusal gets
//   retried, which costs a step and reads to the user as the switch not working.
//
// Bundle format (client-modules protocol): a classic script registering a factory
// via `window.__ModuleLoader__.load({ id, factory })`. React is the only import;
// everything else is inline (no JSX, no Harness UI packages). Only `--dsw-*` theme
// tokens are styled against.
window.__ModuleLoader__.load({
  id: 'dsh-tool-guard',
  factory: (require) => {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const { useCallback, useEffect, useRef, useState } = React
    const h = React.createElement

    /** The composer cell this control occupies: beside the model selector. */
    const SLOT = 'conversation.input.right'
    /** This entry's id inside that list slot. */
    const ID = 'tool-guard'
    /** Sorts after the plugin switch, which sits at 0. */
    const ORDER = 1
    /** Locale namespace, registered here and handed to the entry as its `t` seat. */
    const NS = 'toolGuard'
    /** Stylesheet identity, so a reloaded bundle replaces its own tag instead of stacking. */
    const CSS_ID = 'dsh-tool-guard/ToolGuard.css'
    /** The host route that owns the switch. */
    const ROUTE = '/dsh-tool-guard/state'
    /** Header the Host requires on a write, so a cross-origin POST cannot flip the switch. */
    const HEADER = 'x-dsh-tool-guard'
    /** Menu geometry: fixed width so the open position can be computed before layout. */
    const MENU_WIDTH = 288
    const MENU_GAP = 6
    /** How often the open menu re-reads the Host's switch state. */
    const POLL_MS = 2000

    // --- copy -------------------------------------------------------------------
    // Registered as a real locale namespace when the locale face is installed, so
    // the renderer hands the component a reactive `t`. The navigator-keyed fallback
    // covers a profile without it.
    //
    // There is no `subtitle` entry: "takes effect now" describes what the switches
    // DO, and a menu opened to be operated does not need telling on every open.
    const ZH = {
      title: '工具开关',
      trigger: '工具开关',
      read: '读操作',
      readHint: '读取文件、搜索、联网查询',
      write: '写操作',
      writeHint: '写文件、改文件',
      // The shell row carries the one thing a user cannot infer: a shell outranks
      // the write switch. Kept to a few characters so it fits on the row instead of
      // costing a paragraph at the bottom of the menu.
      shell: '命令行',
      shellHint: '执行命令，也能读写文件',
      loading: '正在读取状态…',
      failed: '读取失败：',
      retry: '重试',
      saveFailed: '开关未保存：'
    }
    const EN = {
      title: 'Tool guard',
      trigger: 'Tool guard',
      read: 'Reads',
      readHint: 'read files, search, web lookups',
      write: 'Writes',
      writeHint: 'write files, edit files',
      shell: 'Shell',
      shellHint: 'run commands — can also write files',
      loading: 'Reading state…',
      failed: 'Could not read state: ',
      retry: 'Retry',
      saveFailed: 'The switch was not saved: '
    }

    /** The copy for the active language, as a plain dictionary. */
    function copyFor(ctx) {
      let language
      try {
        language = ctx.get('locale')?.getSnapshot?.()?.active
      } catch {
        language = undefined
      }
      if (typeof language !== 'string' || language.length === 0) {
        language = typeof navigator !== 'undefined' ? navigator.language : undefined
      }
      return String(language ?? 'en').toLowerCase().startsWith('zh') ? ZH : EN
    }

    /** A translate function over one dictionary: the seat shape, built locally. */
    function translateWith(dict) {
      return (key, params) => {
        const template = dict[key]
        if (typeof template !== 'string') return key
        if (params === undefined) return template
        return template.replace(/\{(\w+)\}/g, (match, field) =>
          Object.prototype.hasOwnProperty.call(params, field) ? String(params[field]) : match
        )
      }
    }

    // --- talking to the host ------------------------------------------------------
    /**
     * One request to the control route, unwrapped.
     *
     * The route answers a JSON envelope, and a non-2xx is a refusal whose `error`
     * is the only useful thing to show — so both paths funnel into one throw.
     * `cache: 'no-store'` is not decoration: the state is polled, and a cached
     * GET would keep showing a switch the user already flipped.
     * @returns the answer's `state` object.
     */
    async function call(ctx, init) {
      const response = await fetch(ROUTE, { cache: 'no-store', ...init })
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error(`the Host answered ${response.status} without JSON`)
      }
      if (payload?.ok !== true) {
        throw new Error(payload?.error ?? `the Host answered ${response.status}`)
      }
      return payload.state
    }

    /** Read the live switch. */
    const readState = (ctx) => call(ctx, { method: 'GET' })

    /** Flip one or both switches; the Host answers the state it now holds. */
    const writeState = (ctx, patch) =>
      call(ctx, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [HEADER]: '1' },
        body: JSON.stringify(patch)
      })

    // --- styles -----------------------------------------------------------------
    // The trigger copies the shipped chips beside it (`.trigger` in ui-model-selection
    // / ui-permission-presets): same height, radius, colour and hover language, so the
    // row reads as one control strip. The menu is drawn from plain elements against
    // theme tokens — a dynamic Client half imports no Harness UI package — and is
    // PORTALLED to `document.body`, which is not decoration:
    //
    //   The composer row that hosts `conversation.input.right` sets
    //   `container-type: inline-size`, and a containment context is a containing
    //   block for `position: fixed`. A fixed menu rendered in place would therefore
    //   be positioned and clipped against that 36px-tall row instead of the
    //   viewport. The shipped model selector in the same row portals for exactly
    //   this reason.
    const CSS = `
.dsh-tool-guard-root { position: relative; display: inline-flex; min-width: 0; }
.dsh-tool-guard-trigger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 8px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  outline: none;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 13px;
  font-weight: 400;
  line-height: 20px;
  cursor: pointer;
}
.dsh-tool-guard-trigger:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-tool-guard-trigger:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
/* The trigger carries the state, not just the label: a switch the user forgot they
   flipped must be visible without opening the menu. Colour plus the icon's fill is
   the signal; no text changes width, so the bar does not reflow on a flip. */
.dsh-tool-guard-triggerActive { color: var(--dsw-alias-state-warn-primary, var(--dsw-alias-brand-primary)); }
.dsh-tool-guard-triggerLabel { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-tool-guard-chevron { flex: none; color: var(--dsw-alias-label-caption); transition: transform .12s; }
.dsh-tool-guard-chevronOpen { transform: rotate(180deg); }
.dsh-tool-guard-menu {
  position: fixed;
  z-index: 1100;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: ${MENU_WIDTH}px;
  max-width: calc(100vw - 24px);
  padding: 4px;
  border: .5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-lg);
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-elevation-prominent);
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
}
.dsh-tool-guard-header { padding: 6px 8px 4px; }
.dsh-tool-guard-title { color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 500; line-height: 18px; }
.dsh-tool-guard-row {
  display: flex;
  align-items: center;
  gap: 10px;
  box-sizing: border-box;
  width: 100%;
  padding: 7px 8px;
  border-radius: var(--dsw-radius-md);
}
.dsh-tool-guard-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-tool-guard-meta { display: flex; flex-direction: column; min-width: 0; margin-inline-end: auto; }
.dsh-tool-guard-name { font-size: 13px; line-height: 18px; }
.dsh-tool-guard-hint { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 15px; }
/* The capsule track and circular thumb, drawn rather than imported: the shape is
   the product's own switch, and keying the fill off aria-checked is what keeps the
   picture from disagreeing with the state assistive technology reads. */
.dsh-tool-guard-switch {
  position: relative;
  box-sizing: border-box;
  flex: 0 0 auto;
  width: 36px;
  height: 20px;
  padding: 2px;
  border: 0;
  border-radius: 999px;
  background: var(--dsw-alias-border-l3);
  cursor: pointer;
  transition: background-color .12s ease;
}
.dsh-tool-guard-switch[aria-checked='true'] { background: var(--dsw-alias-state-warn-primary, var(--dsw-alias-brand-primary)); }
.dsh-tool-guard-switch:disabled { cursor: default; opacity: .45; }
.dsh-tool-guard-switch:focus-visible { outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
.dsh-tool-guard-thumb {
  display: block;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--dsw-alias-switch-thumb);
  transition: transform .12s ease, background-color .12s ease;
}
.dsh-tool-guard-switch[aria-checked='true'] .dsh-tool-guard-thumb {
  background: var(--dsw-alias-label-primary-foreground);
  transform: translateX(16px);
}
.dsh-tool-guard-status { padding: 6px 8px; }
.dsh-tool-guard-note { color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }
.dsh-tool-guard-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 17px; }
.dsh-tool-guard-retry {
  align-self: flex-start;
  margin: 4px 8px 6px;
  padding: 3px 10px;
  border: .5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.dsh-tool-guard-retry:hover { background: var(--dsw-alias-interactive-bg-hover); }
`

    // --- icons ------------------------------------------------------------------
    /**
     * The shield mark, filled while either switch is on.
     *
     * One path serves both states: `fill` is the switch, so the icon cannot drift
     * from the colour the trigger already carries.
     */
    function ShieldIcon({ active }) {
      return h(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
        h('path', {
          d: 'M8 1.6 13 3.4v4.3c0 3.2-2.1 5.6-5 6.7-2.9-1.1-5-3.5-5-6.7V3.4L8 1.6Z',
          fill: active ? 'currentColor' : 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinejoin: 'round'
        })
      )
    }

    /** The shipped chips' disclosure caret. */
    function ChevronIcon({ open }) {
      return h(
        'svg',
        {
          className: open
            ? 'dsh-tool-guard-chevron dsh-tool-guard-chevronOpen'
            : 'dsh-tool-guard-chevron',
          width: 12,
          height: 12,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true'
        },
        h('path', {
          d: 'M4 6.5 8 10.5l4-4',
          stroke: 'currentColor',
          'stroke-width': 1.3,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round'
        })
      )
    }

    /** An eye: the read side. */
    function EyeIcon() {
      return h(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M1.5 8S4 3.8 8 3.8 14.5 8 14.5 8 12 12.2 8 12.2 1.5 8 1.5 8Z',
          stroke: 'currentColor',
          'stroke-width': 1.2,
          'stroke-linejoin': 'round'
        }),
        h('circle', { cx: 8, cy: 8, r: 1.9, stroke: 'currentColor', 'stroke-width': 1.2 })
      )
    }

    /** A pencil: the write side. */
    function PencilIcon() {
      return h(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M11.2 2.3a1.6 1.6 0 0 1 2.3 2.3L5.6 12.5l-3 .7.7-3 7.9-7.9Z',
          stroke: 'currentColor',
          'stroke-width': 1.2,
          'stroke-linejoin': 'round'
        })
      )
    }

    /** A terminal prompt: the shell side. */
    function TerminalIcon() {
      return h(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('rect', {
          x: 1.6,
          y: 2.6,
          width: 12.8,
          height: 10.8,
          rx: 1.6,
          stroke: 'currentColor',
          'stroke-width': 1.2
        }),
        h('path', {
          d: 'M4.4 6.2 6.6 8l-2.2 1.8M8.2 10.2h3.4',
          stroke: 'currentColor',
          'stroke-width': 1.2,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round'
        })
      )
    }

    // --- components -------------------------------------------------------------
    /**
     * One governed side: icon, label, what it covers, and the switch.
     *
     * The switch is a real `button[role=switch]` rather than a checkbox so the
     * Space/Enter activation and the announced state come from the platform. It is
     * disabled only while a write is in flight, never because of the state itself:
     * turning a switch back on must always be possible, even if the read that
     * produced the menu is stale.
     */
    function GuardRow({ icon, title, hint, checked, busy, onToggle }) {
      return h(
        'div',
        { className: 'dsh-tool-guard-row' },
        icon,
        h(
          'div',
          { className: 'dsh-tool-guard-meta' },
          h('span', { className: 'dsh-tool-guard-name' }, title),
          h('span', { className: 'dsh-tool-guard-hint' }, hint)
        ),
        h(
          'button',
          {
            type: 'button',
            role: 'switch',
            className: 'dsh-tool-guard-switch',
            'aria-checked': checked,
            'aria-label': title,
            disabled: busy,
            onClick: onToggle
          },
          h('span', { className: 'dsh-tool-guard-thumb', 'aria-hidden': 'true' })
        )
      )
    }

    /**
     * Build the composer control for one client context.
     *
     * A factory rather than a module-level component, because the control needs the
     * live `ctx` to reach the locale service and the route, and the renderer hands
     * slot components only their entry's seats. The state is read when the menu
     * opens and then polled while it stays open — polling only there, so a switch
     * flipped in another window (the shipped Plugins page, a second tab) is picked
     * up. A composer control that polled forever would be a background tax for a
     * menu nobody has open.
     * @param ctx - the client plugin context.
     * @returns the slot component.
     */
    function makeToolGuard(ctx) {
      return function ToolGuard({ t: seat }) {
        // Two seats reach this prop, and both must work. With a locale face installed
        // the renderer supplies `t(key, params)`; without one, `inject` below supplies
        // the dictionary itself. Normalizing here keeps a single `t(key, params)` shape
        // everywhere in the component instead of a `typeof` check at every label.
        const t = typeof seat === 'function' ? seat : translateWith(seat ?? copyFor(ctx))
        const [open, setOpen] = useState(false)
        // undefined until the first read answers, so the menu can show the loading
        // line rather than rendering three switches as off.
        const [data, setData] = useState(undefined)
        const [status, setStatus] = useState(undefined)
        const [error, setError] = useState(undefined)
        // Which switch is mid-write, so only that row goes busy.
        const [pending, setPending] = useState(undefined)
        const [anchor, setAnchor] = useState(undefined)
        const triggerRef = useRef(null)
        const rootRef = useRef(null)
        // The menu lives in a portal under `document.body`, so it is NOT inside
        // `rootRef`; dismissal has to test both subtrees or a click on a row would
        // close the menu before the row's own handler ran.
        const menuRef = useRef(null)
        // Whether the component is still mounted, so a poll that lands after close
        // does not set state on a dead tree.
        const liveRef = useRef(true)
        useEffect(() => {
          liveRef.current = true
          return () => {
            liveRef.current = false
          }
        }, [])

        /** Read the switch, with the loading phase shown only on the first read. */
        // `data` is tracked through a ref rather than a dependency: `load` sets it, so
        // depending on it would give `load` a new identity after every read — and the
        // poll effect below keys off `load`, so the interval would tear down and
        // restart on every tick instead of simply running.
        const dataRef = useRef(undefined)
        const load = useCallback((quiet) => {
          if (!quiet) setStatus('loading')
          readState(ctx)
            .then((next) => {
              if (!liveRef.current) return
              dataRef.current = next
              setData(next)
              setError(undefined)
              setStatus('ready')
            })
            .catch((failure) => {
              if (!liveRef.current) return
              // A failed poll keeps the switch the user can still operate; only the
              // initial read replaces the menu with the error and its retry.
              if (quiet && dataRef.current !== undefined) return
              setError(String(failure?.message ?? failure))
              setStatus('error')
            })
        }, [ctx])

        const openMenu = useCallback(() => {
          const rect = triggerRef.current?.getBoundingClientRect()
          if (rect !== undefined) {
            // Opens upward: the trigger sits at the bottom of the viewport. Anchoring
            // by `bottom` lets the menu size itself without a measuring pass.
            setAnchor({
              left: Math.min(Math.max(8, rect.left), window.innerWidth - MENU_WIDTH - 8),
              bottom: Math.max(MENU_GAP, window.innerHeight - rect.top + MENU_GAP)
            })
          }
          setOpen(true)
          load()
        }, [load])

        const close = useCallback(() => setOpen(false), [])

        /** Flip one side. Optimistic, because the guard is already live in the Host. */
        const toggle = useCallback(
          (field) => {
            // `!== false` matches how the row is rendered (`readOn` etc.): an absent
            // field reads as "allowed", so flipping it must compute its inverse from
            // the same reading or the first click would appear to do nothing.
            const current = data?.[field] !== false
            const patch = { [field]: !current }
            // The switch moves before the answer so the control never feels laggy; a
            // refusal puts it back and says why, rather than leaving a lie on screen.
            setData((prev) => (prev === undefined ? prev : { ...prev, ...patch }))
            setPending(field)
            writeState(ctx, patch)
              .then((next) => {
                if (!liveRef.current) return
                // Keep the ref the poll's failure path reads in step with the state,
                // or a later failed poll would mistake a loaded menu for an unloaded one.
                dataRef.current = next
                setData(next)
                setError(undefined)
              })
              .catch((failure) => {
                if (!liveRef.current) return
                setData((prev) => (prev === undefined ? prev : { ...prev, [field]: current }))
                setError(`${t('saveFailed')}${String(failure?.message ?? failure)}`)
              })
              .finally(() => {
                if (liveRef.current) setPending(undefined)
              })
          },
          [ctx, data, t]
        )

        // Poll only while the menu is open, and never while a write is in flight —
        // a poll that answered an older state would fight the optimistic switch.
        useEffect(() => {
          if (!open) return undefined
          const timer = window.setInterval(() => {
            if (pending === undefined) load(true)
          }, POLL_MS)
          return () => window.clearInterval(timer)
        }, [open, pending, load])

        // Dismiss on mousedown elsewhere or Escape. No scroll listener: this control
        // sits on the input toolbar, next to the conversation's own scroller, so a
        // capture-phase `scroll` would fire for every scroll of the transcript and
        // close the menu while the user is still reading it. The shipped model
        // selector in the same row listens for `mousedown` only and stays open on
        // scroll; the menu follows that.
        useEffect(() => {
          if (!open) return undefined
          const dismiss = (event) => {
            for (const ref of [rootRef, menuRef]) {
              const node = ref.current
              if (node !== null && event.target instanceof Node && node.contains(event.target)) return
            }
            setOpen(false)
          }
          const onKeyDown = (event) => {
            if (event.key === 'Escape') setOpen(false)
          }
          document.addEventListener('mousedown', dismiss)
          document.addEventListener('keydown', onKeyDown)
          return () => {
            document.removeEventListener('mousedown', dismiss)
            document.removeEventListener('keydown', onKeyDown)
          }
        }, [open])

        // ON means ALLOWED. A user reads a switch as "this is enabled", so an on
        // switch permits its kind and turning it off is what disables the tools —
        // the reverse reading (on = blocked) made the default state look dangerous.
        const readOn = data?.allowRead !== false
        const writeOn = data?.allowWrite !== false
        const shellOn = data?.allowShell !== false

        const menu =
          !open || anchor === undefined || typeof document === 'undefined'
            ? null
            : createPortal(
                h(
                  'div',
                  {
                    ref: menuRef,
                    className: 'dsh-tool-guard-menu',
                    role: 'dialog',
                    'aria-label': t('title'),
                    style: { left: `${anchor.left}px`, bottom: `${anchor.bottom}px` }
                  },
                  // No subtitle line: the switches say what they do, and the menu is
                  // opened to be operated, not read.
                  h(
                    'div',
                    { className: 'dsh-tool-guard-header' },
                    h('div', { className: 'dsh-tool-guard-title' }, t('title'))
                  ),
                  h(GuardRow, {
                    icon: h(EyeIcon, null),
                    title: t('read'),
                    hint: t('readHint'),
                    checked: readOn,
                    busy: pending === 'allowRead',
                    onToggle: () => toggle('allowRead'),
                    t
                  }),
                  h(GuardRow, {
                    icon: h(PencilIcon, null),
                    title: t('write'),
                    hint: t('writeHint'),
                    checked: writeOn,
                    busy: pending === 'allowWrite',
                    onToggle: () => toggle('allowWrite'),
                    t
                  }),
                  h(GuardRow, {
                    icon: h(TerminalIcon, null),
                    title: t('shell'),
                    hint: t('shellHint'),
                    checked: shellOn,
                    busy: pending === 'allowShell',
                    onToggle: () => toggle('allowShell'),
                    t
                  }),
                  // Only failures and the first read get a line here. The per-row
                  // counts above already prove the switch is firing, and a
                  // "last blocked: <tool>" line said the same thing a second time
                  // while pushing the switches up the menu.
                  status === 'error'
                    ? h(
                        'div',
                        { className: 'dsh-tool-guard-status' },
                        h('span', { className: 'dsh-tool-guard-error' }, `${t('failed')}${error}`)
                      )
                    : status === 'loading' || status === undefined
                      ? h(
                          'div',
                          { className: 'dsh-tool-guard-status' },
                          h('span', { className: 'dsh-tool-guard-note' }, t('loading'))
                        )
                      : null,
                  status === 'error'
                    ? h(
                        'button',
                        {
                          type: 'button',
                          className: 'dsh-tool-guard-retry',
                          onClick: () => load()
                        },
                        t('retry')
                      )
                    : null
                ),
                document.body
              )

        // Icon-only, with the chevron kept as the affordance that a menu opens: the
        // shield carries the state and the tooltip carries the name, so a text label
        // beside them repeated information and widened the composer row for nothing.
        // The highlight tracks RESTRICTION, not permission: with ON = allowed, a
        // freshly loaded control has all three switches on and must look neutral.
        // Lighting up on "everything allowed" would make the normal state the loud
        // one and hide the state worth noticing — that something is switched off.
        const restricted = !readOn || !writeOn || !shellOn
        return h(
          'div',
          { className: 'dsh-tool-guard-root', ref: rootRef },
          h(
            'button',
            {
              ref: triggerRef,
              type: 'button',
              className: restricted
                ? 'dsh-tool-guard-trigger dsh-tool-guard-triggerActive'
                : 'dsh-tool-guard-trigger',
              'aria-haspopup': 'dialog',
              'aria-expanded': open,
              title: t('title'),
              onClick: () => (open ? close() : openMenu())
            },
            h(ShieldIcon, { active: restricted }),
            h('span', { className: 'dsh-tool-guard-triggerLabel' }, t('trigger')),
            h(ChevronIcon, { open })
          ),
          menu
        )
      }
    }

    // --- plugin -----------------------------------------------------------------
    function apply(ctx) {
      ctx.effect(() => {
        if (typeof document === 'undefined') return () => {}
        const existing = document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_ID)}]`)
        if (existing !== null) return () => {}
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-tool-guard'
        tag.dataset.pluginCss = CSS_ID
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => tag.remove()
      }, 'tool-guard: stylesheet')

      // The dictionary is registered only when a locale face exists. The entry's own
      // `locale` option is set on the same condition: the renderer throws for an
      // entry that declares a namespace no locale face can answer, so the two must
      // agree. Without one, `t` arrives as a prop from `inject` instead.
      let locale
      try {
        locale = ctx.get('locale')
      } catch {
        locale = undefined
      }
      if (locale !== undefined && typeof locale.register === 'function') {
        ctx.effect(() => locale.register(NS, { zh: ZH, en: EN }), 'tool-guard: dictionaries')
      }

      ctx.slots.inject(SLOT, () =>
        ctx.slots.register(
          {
            name: SLOT,
            id: ID,
            order: ORDER,
            ...(locale === undefined ? {} : { locale: NS }),
            // With no locale face the component cannot receive a `t` seat, so a
            // translate function over the dictionary is handed to it as a plain prop
            // instead. Both spellings arrive as the same `t(key, params)` prop.
            inject: () => (locale === undefined ? { t: translateWith(copyFor(ctx)) } : {})
          },
          makeToolGuard(ctx)
        )
      )
    }

    // The loader gates apply() until the declared services exist.
    return { apply, inject: ['slots'] }
  }
})
