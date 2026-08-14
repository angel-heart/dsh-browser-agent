/* Browser automation service for the DeepSeek Harness browser-agent plugin.
 *
 * Protocol: newline-delimited JSON over stdio.
 *   request : {"id":1,"method":"open","params":{...}}
 *   response: {"id":1,"ok":true,"result":{...}} | {"id":1,"ok":false,"error":"..."}
 * First line after boot is a hello: {"id":0,"ok":true,"result":{"ready":true,...}}
 * Diagnostics go to stderr, tagged [browser-agent].
 *
 * The browser uses a persistent profile (./profile) so cookies and login
 * state survive restarts; screenshots land in ./shots.
 */
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')
const { chromium } = require('playwright-core')

const ROOT = __dirname
const CONFIG = loadConfig()
const PROFILE_DIR = path.join(ROOT, 'profile')
const SHOTS_DIR = path.join(ROOT, 'shots')
fs.mkdirSync(SHOTS_DIR, { recursive: true })

function loadConfig() {
  const p = path.join(ROOT, 'config.json')
  const defaults = { channel: 'chrome', headless: true, executablePath: '' }
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
    return { ...defaults, ...parsed }
  } catch (e) {
    return defaults
  }
}

let context = null
let page = null

function log(...args) {
  console.error('[browser-agent]', ...args)
}

async function ensurePage() {
  if (page !== null && !page.isClosed()) return
  const opts = {
    headless: CONFIG.headless !== false,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    args: ['--disable-blink-features=AutomationControlled'],
  }
  if (CONFIG.channel) opts.channel = CONFIG.channel
  if (CONFIG.executablePath) opts.executablePath = CONFIG.executablePath
  context = await chromium.launchPersistentContext(PROFILE_DIR, opts)
  page = context.pages()[0] || await context.newPage()
  page.setDefaultTimeout(20000)
  page.setDefaultNavigationTimeout(45000)
  log('page ready (headless=' + (CONFIG.headless !== false) + ', channel=' + (CONFIG.channel || 'default') + ')')
}

function truncate(text, max) {
  const s = String(text)
  return s.length > max ? s.slice(0, max) + '\n...[truncated]' : s
}

async function visibleLocator(selector) {
  const base = page.locator(selector)
  const count = await base.count()
  if (count === 0) throw new Error('no element matches selector: ' + selector)
  for (let i = 0; i < count; i++) {
    const el = base.nth(i)
    if (await el.isVisible()) return el
  }
  return base.first()
}

const METHODS = {
  async status() {
    let title = null
    if (page !== null && !page.isClosed()) {
      try { title = await page.title() } catch (e) { title = null }
    }
    return {
      ready: true,
      pid: process.pid,
      channel: CONFIG.channel || 'default',
      headless: CONFIG.headless !== false,
      url: page !== null && !page.isClosed() ? page.url() : null,
      title,
    }
  },

  async open(params) {
    await ensurePage()
    if (typeof params.url !== 'string' || params.url.length === 0) throw new Error('url is required')
    await page.goto(params.url, {
      waitUntil: params.waitUntil || 'domcontentloaded',
      timeout: params.timeout || 45000,
    })
    if (params.waitMs) await page.waitForTimeout(params.waitMs)
    return { url: page.url(), title: await page.title() }
  },

  async search(params) {
    await ensurePage()
    const engine = params.engine === 'google' ? 'google' : 'bing'
    const q = encodeURIComponent(String(params.query))
    const url = engine === 'google'
      ? 'https://www.google.com/search?q=' + q
      : 'https://www.bing.com/search?q=' + q
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 })
    await page.waitForTimeout(params.waitMs || 600)
    const links = await page.evaluate(() => {
      const out = []
      for (const a of document.querySelectorAll('a')) {
        const text = (a.innerText || '').trim()
        const href = a.href || ''
        if (!/^https?:\/\//.test(href)) continue
        if (text.length < 8) continue
        out.push({ text: text.slice(0, 160), href })
      }
      return out.slice(0, 25)
    })
    return { url: page.url(), title: await page.title(), links }
  },

  async content(params) {
    await ensurePage()
    const loc = params.selector ? await visibleLocator(params.selector) : page.locator('body')
    const text = await loc.innerText({ timeout: params.timeout || 15000 })
    return { url: page.url(), title: await page.title(), text: truncate(text, 60000) }
  },

  async html(params) {
    await ensurePage()
    const loc = params.selector ? await visibleLocator(params.selector) : page.locator('body')
    const html = await loc.innerHTML({ timeout: params.timeout || 15000 })
    return { url: page.url(), html: truncate(html, 100000) }
  },

  async click(params) {
    await ensurePage()
    const loc = await visibleLocator(params.selector)
    await loc.click({ timeout: params.timeout || 15000 })
    if (params.waitMs) await page.waitForTimeout(params.waitMs)
    return { url: page.url(), title: await page.title() }
  },

  async type(params) {
    await ensurePage()
    const loc = await visibleLocator(params.selector)
    await loc.fill(String(params.text), { timeout: params.timeout || 10000 })
    if (params.pressEnter) await loc.press('Enter')
    if (params.waitMs) await page.waitForTimeout(params.waitMs)
    return { url: page.url(), title: await page.title() }
  },

  async press(params) {
    await ensurePage()
    await page.keyboard.press(params.key)
    if (params.waitMs) await page.waitForTimeout(params.waitMs)
    return { url: page.url() }
  },

  async scroll(params) {
    await ensurePage()
    const times = Math.max(1, params.times || 1)
    const deltaY = params.deltaY === undefined ? 600 : params.deltaY
    const waitMs = params.waitMs === undefined ? 250 : params.waitMs
    for (let i = 0; i < times; i++) {
      await page.mouse.wheel(0, deltaY)
      await page.waitForTimeout(waitMs)
    }
    return { url: page.url(), title: await page.title() }
  },

  async links(params) {
    await ensurePage()
    const query = String(params.query || '').toLowerCase()
    const links = await page.evaluate((q) => {
      const out = []
      for (const a of document.querySelectorAll('a')) {
        const text = (a.innerText || '').trim()
        const href = a.href || ''
        if (!/^https?:\/\//.test(href)) continue
        if (q && text.toLowerCase().indexOf(q) === -1 && href.toLowerCase().indexOf(q) === -1) continue
        out.push({ text: text.slice(0, 160), href })
      }
      return out.slice(0, 120)
    }, query)
    return { url: page.url(), links }
  },

  async screenshot(params) {
    await ensurePage()
    const name = String(params.name || 'shot_' + Date.now()).replace(/[^\w.\-]/g, '_')
    const file = path.join(SHOTS_DIR, name.endsWith('.png') ? name : name + '.png')
    if (params.selector) {
      const loc = await visibleLocator(params.selector)
      await loc.screenshot({ path: file, timeout: 20000 })
    } else {
      await page.screenshot({ path: file, fullPage: params.fullPage === true, timeout: 20000 })
    }
    return { path: file, url: page.url() }
  },

  async evaluate(params) {
    await ensurePage()
    const script = String(params.script)
    const result = await page.evaluate((src) => {
      const fn = new Function('return (' + src + ')\n//# sourceURL=browser-agent-eval.js')()
      return typeof fn === 'function' ? fn() : fn
    }, script)
    let serialized
    try {
      serialized = JSON.stringify(result)
      if (serialized === undefined) serialized = String(result)
    } catch (e) {
      serialized = String(result)
    }
    return { result: serialized === undefined ? null : JSON.parse(serialized) }
  },

  async cookies(params) {
    await ensurePage()
    if (Array.isArray(params.set)) {
      await context.addCookies(params.set)
      return { ok: true, added: params.set.length }
    }
    const cookies = await context.cookies()
    return { cookies: cookies.map((c) => ({ name: c.name, domain: c.domain, path: c.path, value: c.value })) }
  },

  async nav(params) {
    await ensurePage()
    const action = params.action || 'reload'
    if (action === 'back') { await page.goBack({ timeout: 30000 }); return { url: page.url(), title: await page.title() } }
    if (action === 'forward') { await page.goForward({ timeout: 30000 }); return { url: page.url(), title: await page.title() } }
    if (action === 'reload') { await page.reload({ waitUntil: params.waitUntil || 'domcontentloaded' }); return { url: page.url(), title: await page.title() } }
    if (action === 'close') { await closeContext(); return { closed: true } }
    throw new Error('unknown action: ' + action)
  },

  async close() {
    await ensurePage()
    await closeContext()
    return { closed: true }
  },
}

async function closeContext() {
  if (context !== null) {
    try { await context.close() } catch (e) { /* already closed */ }
  }
  context = null
  page = null
}

async function handle(msg) {
  if (typeof msg !== 'object' || msg === null || typeof msg.method !== 'string') {
    return { ok: false, error: 'bad request: method required' }
  }
  const fn = METHODS[msg.method]
  if (fn === undefined) return { ok: false, error: 'unknown method: ' + msg.method }
  try {
    return { ok: true, result: await fn(msg.params || {}) }
  } catch (e) {
    log('method', msg.method, 'failed:', (e && e.message) || e)
    return { ok: false, error: String((e && e.message) || e) }
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

rl.on('line', (line) => {
  if (line.trim() === '') return
  let msg
  try {
    msg = JSON.parse(line)
  } catch (e) {
    send({ id: null, ok: false, error: 'bad request json' })
    return
  }
  handle(msg).then((resp) => {
    send({ id: msg.id, ok: resp.ok, ...(resp.ok ? { result: resp.result } : { error: resp.error }) })
  })
})

process.on('uncaughtException', (e) => log('uncaught:', (e && e.stack) || e))
process.on('unhandledRejection', (e) => log('unhandled rejection:', (e && e.stack) || e))

function shutdown() {
  log('shutting down')
  const done = () => process.exit(0)
  if (context !== null) {
    context.close().catch(() => {}).finally(done)
  } else {
    done()
  }
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

send({
  id: 0,
  ok: true,
  result: {
    ready: true,
    pid: process.pid,
    channel: CONFIG.channel || 'default',
    headless: CONFIG.headless !== false,
  },
})
log('listening on stdio')
