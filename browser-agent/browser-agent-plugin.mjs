/**
 * Persistent browser-agent plugin for the DeepSeek Harness `browser-pro` preset.
 *
 * A REAL Cordis plugin (not the dynamic VM sandbox): it consumes the host
 * `subprocess` / `tools` / `timer` services and publishes nothing, so the
 * preset row needs no isolate realm. It lazily spawns the managed Playwright
 * service (server.cjs next to this file) through the host subprocess service —
 * which is how it escapes the pwsh file sandbox that blocks native binaries —
 * and talks to it over a newline-delimited JSON protocol on stdio.
 *
 * PORTABLE BUILD: no hardcoded machine/user paths. The node binary is taken
 * from the running harness process (process.execPath, overridable with the
 * DSH_BROWSER_NODE env var), and the service script + working dir are derived
 * from this plugin's own location, so the whole folder can be copied anywhere.
 * The spawned service inherits the harness environment via { ...process.env }.
 *
 * Registered tools: browser_status, browser_open, browser_search,
 * browser_content, browser_html, browser_click, browser_type, browser_press,
 * browser_scroll, browser_links, browser_screenshot, browser_evaluate,
 * browser_cookies, browser_nav, browser_close.
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const NODE = process.env.DSH_BROWSER_NODE || process.execPath
const SERVER = join(HERE, 'server.cjs')
const CWD = HERE

function makeTool(name, description, parameters, method, timeoutMs) {
  const properties = {}
  const required = []
  for (const key of Object.keys(parameters)) {
    const p = { ...parameters[key] }
    const req = p.required === true
    delete p.required
    properties[key] = p
    if (req) required.push(key)
  }
  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties,
      required,
    },
    output: {
      schema: { type: 'string' },
      render(_args, value) {
        return [{ type: 'text', text: value }]
      },
    },
    execute: null, // assigned per registration below through the RPC closure
    _method: method,
    _timeoutMs: timeoutMs,
  }
}

export default {
  name: 'browser-agent',
  inject: ['tools', 'timer'],
  apply(ctx) {
    const subprocess = ctx.get('subprocess')
    if (subprocess === undefined) {
      console.error('[browser-agent] subprocess service unavailable, browser tools not registered')
      return
    }

    let handle = null
    let nextId = 0
    let buffer = ''
    const pending = new Map()
    let readyPromise = null
    let readyResolve = null
    let readyReject = null

    function failAll(err) {
      for (const p of pending.values()) p.reject(err)
      pending.clear()
      if (readyReject !== null) {
        const r = readyReject
        readyResolve = null
        readyReject = null
        r(err)
      }
    }

    function onLine(line) {
      if (line.trim() === '') return
      let msg
      try {
        msg = JSON.parse(line)
      } catch (e) {
        console.error('[browser-agent] non-json line: ' + String(line).slice(0, 200))
        return
      }
      if (msg.id === 0) {
        if (readyResolve !== null) {
          const resolve = readyResolve
          const reject = readyReject
          readyResolve = null
          readyReject = null
          if (msg.ok) resolve(msg.result)
          else reject(new Error(msg.error || 'browser service boot failed'))
        }
        return
      }
      const p = pending.get(msg.id)
      if (p === undefined) return
      pending.delete(msg.id)
      if (msg.ok) p.resolve(msg.result)
      else p.reject(new Error(msg.error || 'browser action failed'))
    }

    function start() {
      if (handle !== null) return
      handle = subprocess.spawn({
        argv: [NODE, SERVER],
        cwd: CWD,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 131072 } },
        graceMs: 8000,
        env: { ...process.env },
      })
      readyPromise = new Promise((resolve, reject) => {
        readyResolve = resolve
        readyReject = reject
      })
      handle.stdout.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        let idx
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)
          onLine(line)
        }
      })
      handle.done.then(
        (outcome) => {
          console.error('[browser-agent] service exited: ' + JSON.stringify(outcome))
          const code = outcome === null || outcome.exitCode === undefined ? '?' : outcome.exitCode
          const err = new Error('browser service exited (code ' + code + ')')
          failAll(err)
          handle = null
          readyPromise = null
        },
        (spawnErr) => {
          console.error('[browser-agent] spawn failed: ' + String((spawnErr && spawnErr.message) || spawnErr))
          const err = new Error('browser service spawn failed: ' + String((spawnErr && spawnErr.message) || spawnErr))
          failAll(err)
          handle = null
          readyPromise = null
        },
      )
      console.log('[browser-agent] spawned node service, pid ' + handle.pid)
    }

    function rpc(method, params, timeoutMs) {
      const ms = timeoutMs || 90000
      return new Promise((resolve, reject) => {
        let settled = false
        let timer = null
        const finish = (fn, value) => {
          if (settled) return
          settled = true
          if (timer !== null) { timer(); timer = null }
          fn(value)
        }
        timer = ctx.timeout(() => finish(reject, new Error('browser rpc timed out after ' + ms + 'ms: ' + method)), ms)
        const begin = () => {
          if (handle === null || handle.stdin === undefined) {
            finish(reject, new Error('browser service is not running'))
            return
          }
          const id = ++nextId
          pending.set(id, {
            resolve: (v) => finish(resolve, v),
            reject: (e) => finish(reject, e),
          })
          handle.stdin.write(JSON.stringify({ id, method, params: params || {} }) + '\n')
        }
        if (handle !== null) { begin(); return }
        if (readyPromise === null) start()
        readyPromise.then(
          () => begin(),
          (err) => finish(reject, err),
        )
      })
    }

    ctx.effect(() => () => {
      if (handle !== null) {
        try { handle.terminate() } catch (e) { /* already gone */ }
        handle = null
      }
      failAll(new Error('browser-agent plugin stopped'))
    })

    const tools = [
      makeTool('browser_status',
        'Report browser service state: whether a page is open, current URL and title, Chrome channel and headless mode.',
        {}, 'status', 30000),
      makeTool('browser_open',
        'Open (or navigate) the persistent browser page to a URL. The page runs in a persistent Chrome profile, so cookies and logins survive across calls and restarts.',
        {
          url: { type: 'string', required: true, description: 'Full URL to open' },
          waitMs: { type: 'number', description: 'Extra wait after load in ms' },
          waitUntil: { type: 'string', description: 'domcontentloaded (default) | load | networkidle' },
        }, 'open', 120000),
      makeTool('browser_search',
        'Run a search in the browser (Bing by default, Google optional) and return the top result links with titles.',
        {
          query: { type: 'string', required: true, description: 'Search query' },
          engine: { type: 'string', description: 'bing (default) or google' },
        }, 'search', 120000),
      makeTool('browser_content',
        'Extract the visible text of the current page, or of a CSS selector when given.',
        { selector: { type: 'string', description: 'CSS selector; defaults to the whole page body' } },
        'content', 60000),
      makeTool('browser_html',
        'Extract the inner HTML of the current page, or of a CSS selector when given.',
        { selector: { type: 'string', description: 'CSS selector; defaults to the whole page body' } },
        'html', 60000),
      makeTool('browser_click',
        'Click the first visible element matching a CSS selector (also accepts Playwright text selectors like text=登录).',
        {
          selector: { type: 'string', required: true, description: 'CSS or text selector' },
          waitMs: { type: 'number', description: 'Wait after click in ms' },
        }, 'click', 60000),
      makeTool('browser_type',
        'Fill text into an input matched by CSS selector; optionally press Enter to submit.',
        {
          selector: { type: 'string', required: true, description: 'CSS selector of the input' },
          text: { type: 'string', required: true, description: 'Text to type' },
          pressEnter: { type: 'boolean', description: 'Press Enter after typing' },
          waitMs: { type: 'number', description: 'Wait after typing in ms' },
        }, 'type', 60000),
      makeTool('browser_press',
        'Press a keyboard key on the page (e.g. Enter, Escape, ArrowDown, PageDown).',
        {
          key: { type: 'string', required: true, description: 'Key name' },
          waitMs: { type: 'number', description: 'Wait after the keypress in ms' },
        }, 'press', 30000),
      makeTool('browser_scroll',
        'Scroll the page vertically. Positive deltaY scrolls down; repeat with times.',
        {
          deltaY: { type: 'number', description: 'Scroll amount in px per step; default 600' },
          times: { type: 'number', description: 'Number of scroll steps; default 1' },
          waitMs: { type: 'number', description: 'Wait between steps in ms; default 250' },
        }, 'scroll', 60000),
      makeTool('browser_links',
        'List links on the current page with their visible text, optionally filtered by a text or URL substring.',
        { query: { type: 'string', description: 'Case-insensitive substring filter on link text or URL' } },
        'links', 60000),
      makeTool('browser_screenshot',
        'Take a screenshot of the current page (or of a selector) and save it under browser-agent/shots; returns the PNG file path for viewing.',
        {
          name: { type: 'string', description: 'Output file name without extension; default shot_<timestamp>' },
          selector: { type: 'string', description: 'CSS selector to capture instead of the whole page' },
          fullPage: { type: 'boolean', description: 'Capture the full scrollable page; default false (viewport)' },
        }, 'screenshot', 60000),
      makeTool('browser_evaluate',
        'Run a JavaScript expression inside the page and return its JSON result. Use for data that needs page-side computation.',
        { script: { type: 'string', required: true, description: 'JS expression evaluated in the page' } },
        'evaluate', 30000),
      makeTool('browser_cookies',
        'Read cookies from the persistent browser profile, or write cookies (array of {name, value, domain, path} or {name, value, url}). Use it to export or import login state between machines.',
        { set: { type: 'array', items: {}, description: 'When provided, adds these cookies instead of reading' } },
        'cookies', 60000),
      makeTool('browser_nav',
        'Navigate history: go back, go forward, reload, or close the browser (profile and cookies are kept).',
        { action: { type: 'string', required: true, description: 'back | forward | reload | close' } },
        'nav', 60000),
      makeTool('browser_close',
        'Close the browser. The persistent profile keeps cookies and login state for the next launch.',
        {}, 'close', 30000),
    ]

    for (const t of tools) {
      const method = t._method
      const timeoutMs = t._timeoutMs
      delete t._method
      delete t._timeoutMs
      t.execute = async (args) => {
        try {
          return JSON.stringify(await rpc(method, args, timeoutMs), null, 2)
        } catch (e) {
          return JSON.stringify({ ok: false, error: String((e && e.message) || e) }, null, 2)
        }
      }
      ctx.effect(() => ctx.tools.register(t))
    }

    console.log('[browser-agent] registered ' + tools.length + ' browser_* tools')
  },
}
