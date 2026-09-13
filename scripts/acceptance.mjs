/**
 * Live acceptance for a gateway mounted inside a real DSH host (0.1.5-rc.2).
 *
 * The gateway runs in-process, so it cannot be started standalone: load the
 * built plugin into a DSH profile first, e.g. add this row to the profile's
 * cordis.patch.yml and restart (or let `patchReload: live` hot-apply it):
 *
 *   - insert:
 *       - id: dsh-api-gw
 *         name: dsh-api-gateway
 *         config:
 *           apiKeys: [acceptance-key]
 *
 * Then run:
 *   DSH_AGW_KEY=acceptance-key node scripts/acceptance.mjs
 *
 * Environment:
 *   DSH_AGW_BASE    http://127.0.0.1:3080   host origin
 *   DSH_AGW_PREFIX  /api-gw/v1              gateway route prefix
 *   DSH_AGW_KEY     (required)              API key
 */
import { WebSocket } from 'ws'
import { randomUUID } from 'node:crypto'

const BASE = (process.env.DSH_AGW_BASE ?? 'http://127.0.0.1:3080').replace(/\/+$/, '')
const PREFIX = process.env.DSH_AGW_PREFIX ?? '/api-gw/v1'
const KEY = process.env.DSH_AGW_KEY
if (KEY === undefined || KEY === '') {
  console.error('DSH_AGW_KEY is required')
  process.exit(2)
}

let failures = 0
const check = (label, condition, detail) => {
  if (condition) {
    console.log('  ok  ' + label)
  } else {
    failures += 1
    console.log('FAIL  ' + label + (detail === undefined ? '' : ' -> ' + detail))
  }
}

const envelope = (method, args, rpcId = randomUUID()) =>
  JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } })

const post = async (endpoint, args, key = KEY) => {
  const res = await fetch(`${BASE}${PREFIX}/proxy/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key },
    body: envelope(endpoint, args),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* keep null */ }
  return { status: res.status, json, text }
}

console.log('== health ==')
{
  const res = await fetch(`${BASE}${PREFIX}/health`)
  const body = await res.json()
  check('GET /health answers 200', res.status === 200, String(res.status))
  check('upstream is ok', body.upstream === 'ok', JSON.stringify(body))
  check('at least one API key is set', body.apiKeySet === true, JSON.stringify(body))
}

console.log('== auth ==')
{
  const res = await post('session/list', { _request: {} }, 'definitely-wrong')
  check('wrong key -> 401', res.status === 401, String(res.status))
}

console.log('== whitelist ==')
{
  const res = await post('credentials/describe', { refs: [] })
  check('privileged endpoint -> 403 method_not_allowed',
    res.status === 403 && res.json?.error === 'method_not_allowed', JSON.stringify(res.json))
  const legacy = await post('session.list', {})
  check('legacy dot endpoint -> 404 (not a valid route shape)', legacy.status === 404, String(legacy.status))
}

console.log('== unary dispatch ==')
{
  const list = await post('session/list', { _request: {} })
  check('session/list returns a server-response', list.json?.type === 'server-response', list.text.slice(0, 160))
  check('session/list result ok', list.json?.result?.ok === true, list.text.slice(0, 160))

  const catalog = await post('session/modelCatalog', {})
  check('session/modelCatalog result ok', catalog.json?.result?.ok === true, catalog.text.slice(0, 160))
  const model = catalog.json?.result?.value?.default
  check('model catalog carries a default selection',
    typeof model?.provider === 'string' && typeof model?.model === 'string', JSON.stringify(model))

  // Argument validation is the host's; the gateway must not swallow it.
  const invalid = await post('session/create', {})
  check('session/create with empty args -> gateway/arguments-invalid',
    invalid.json?.result?.ok === false && invalid.json?.result?.error?.code === 'gateway/arguments-invalid',
    invalid.text.slice(0, 200))
}

console.log('== mux streams ==')
{
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}${PREFIX}/proxy/events.mux`, {
    headers: { 'x-api-key': KEY },
  })
  const queue = []
  const waiters = []
  ws.on('message', (data) => {
    const frame = JSON.parse(String(data))
    const waiter = waiters.shift()
    if (waiter !== undefined) waiter(frame)
    else queue.push(frame)
  })
  const nextFrame = (timeoutMs = 8_000) => new Promise((resolve, reject) => {
    if (queue.length > 0) return resolve(queue.shift())
    const timer = setTimeout(() => reject(new Error('mux frame timeout')), timeoutMs)
    waiters.push((frame) => { clearTimeout(timer); resolve(frame) })
  })
  const open = (endpoint, payload) => {
    const streamId = randomUUID()
    ws.send(JSON.stringify({ type: 'open', streamId, endpoint, payload }))
    return streamId
  }
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })

  const eventsId = open('$events', { args: {} })
  const ready = await nextFrame()
  check('$events opens with a ready frame',
    ready.type === 'item' && ready.streamId === eventsId && ready.value?.type === 'ready',
    JSON.stringify(ready).slice(0, 200))
  const clientId = ready.value?.clientId

  const result = await post('$events/result', { clientId, eventId: randomUUID(), outcome: { kind: 'result' } })
  check('$events/result answer channel accepts the outcome',
    result.json?.result?.ok === true, result.text.slice(0, 200))

  const controlId = open('session/control', { args: {} })
  const control = await nextFrame()
  check('session/control opens with a baseline frame',
    control.type === 'item' && control.streamId === controlId && control.value?.type === 'baseline',
    JSON.stringify(control).slice(0, 200))

  const followId = open('session/follow', { args: { request: { address: { kind: 'session', sessionId: 'session-acceptance-missing' } } } })
  const followError = await nextFrame()
  check('session/follow on an unknown session maps a stream error',
    followError.type === 'error' && followError.streamId === followId && typeof followError.error?.code === 'string',
    JSON.stringify(followError).slice(0, 200))

  const deniedId = open('workspace/follow', { args: {} })
  const denied = await nextFrame()
  check('non-whitelisted stream -> error frame',
    denied.type === 'error' && denied.streamId === deniedId && denied.error?.code === 'gateway/endpoint-not-allowed',
    JSON.stringify(denied).slice(0, 200))

  ws.close()
}

console.log('== mutation flow (creates a real session) ==')
if (process.env.DSH_AGW_MUTATE !== '1') {
  console.log('  skip  set DSH_AGW_MUTATE=1 to run session/create + sandbox-mode + rename')
} else {
  const cwd = process.env.DSH_AGW_CWD ?? process.cwd()
  const created = await post('session/create', { request: { cwd } })
  const sessionId = created.json?.result?.value?.sessionId
  check('session/create returns a sessionId', typeof sessionId === 'string' && sessionId.length > 0, created.text.slice(0, 200))

  if (typeof sessionId === 'string') {
    const sandbox = async (mode) => {
      const res = await fetch(`${BASE}${PREFIX}/sessions/${encodeURIComponent(sessionId)}/sandbox-mode`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': KEY },
        body: JSON.stringify({ mode }),
      })
      return { status: res.status, json: await res.json() }
    }
    const pinned = await sandbox('read-only')
    check('sandbox-mode pins read-only on the live session',
      pinned.status === 200 && pinned.json?.mode === 'read-only', JSON.stringify(pinned))
    const invalid = await sandbox('danger-full-access')
    check('sandbox-mode rejects danger-full-access over the wire', invalid.status === 400, JSON.stringify(invalid))

    const renamed = await post('session/rename', { request: { sessionId, title: 'gw-acceptance' } })
    check('session/rename accepts a title', renamed.json?.result?.ok === true, renamed.text.slice(0, 200))

    // Leave the session in the safest remotely grantable state.
    await sandbox('read-only')
    console.log('  note  test session ' + sessionId + ' (\'' + cwd + '\') was created and renamed "gw-acceptance"')
  }
}

console.log(failures === 0 ? '\nacceptance: PASS' : `\nacceptance: FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
