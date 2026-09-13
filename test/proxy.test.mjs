/**
 * Integration tests: the plugin over a mock webServer carrier, with the host
 * `connection` and `typertGateway` services faked at their structural seams.
 * Runs against the BUILT output (`lib/`).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createServer } from 'node:http'
import { EventEmitter } from 'node:events'
import { WebSocket } from 'ws'
import plugin from '../lib/index.js'
import {
  DEFAULT_MUX_WHITELIST,
  DEFAULT_PROXY_WHITELIST,
  dispatchUrl,
  endpointOf,
  isMuxEndpointAllowed,
  isProxyEndpointAllowed,
} from '../lib/proxy.js'

// ---- pure helpers ----

test('apiKeys carries the secret role on the array itself', () => {
  // Item-level role('secret') is not honoured by settings redaction; only the
  // top-level field role hides the value from settings.describe.
  const field = plugin.Config.dict.apiKeys
  assert.equal(field?.meta?.role, 'secret', 'the array node must be role-secret')
})

test('endpoint builders use the DSH 0.1.5 slash form', () => {
  assert.equal(endpointOf('session', 'create'), 'session/create')
  assert.equal(endpointOf('$events', 'result'), '$events/result')
  assert.equal(dispatchUrl('session/list'), 'http://dsh.invalid/api/session/list')
  assert.equal(dispatchUrl('$events/result'), 'http://dsh.invalid/api/$events/result')
})

test('unary whitelist: the manager surface is allowed, the privileged plane is not', () => {
  for (const endpoint of ['session/list', 'session/create', 'session/page', 'session/prompt',
    'session/cancel', 'session/rename', 'session/fork', 'session/updateQueue', 'session/attachment',
    'session/modelCatalog', 'session/selectModel', '$events/result']) {
    assert.equal(isProxyEndpointAllowed(endpoint, DEFAULT_PROXY_WHITELIST), true, endpoint + ' must be allowed')
  }
  for (const endpoint of ['credentials/set', 'credentials/unset', 'settings/describe', 'settings/update',
    'workspace/create', 'agentPresets/select', 'goals/edit', 'subagents/prompt',
    'llm/discoverModels', 'session/search', 'host/describe',
    // legacy dot names and the old history/models endpoints must not sneak back in
    'session.list', 'session.history', 'session.models', 'respond',
    'session/create/extra', '']) {
    assert.equal(isProxyEndpointAllowed(endpoint, DEFAULT_PROXY_WHITELIST), false, endpoint + ' must be refused')
  }
})

test('mux whitelist: event and session streams allowed, everything else refused', () => {
  for (const endpoint of ['$events', 'session/follow', 'session/control']) {
    assert.equal(isMuxEndpointAllowed(endpoint, DEFAULT_MUX_WHITELIST), true, endpoint + ' must be allowed')
  }
  for (const endpoint of ['workspace/follow', 'workspaceFiles/changes', 'session/search', 'session/history', '']) {
    assert.equal(isMuxEndpointAllowed(endpoint, DEFAULT_MUX_WHITELIST), false, endpoint + ' must be refused')
  }
})

// ---- fakes ----

const envelope = (method, args = {}, rpcId = 'echo') =>
  JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } })

const okResponse = (body) => new Response(body, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } })

const defaultImpl = (_endpoint, body) => okResponse(JSON.stringify({
  type: 'server-response', rpcId: 'echo', result: { ok: true, value: { got: body } },
}))

/** Fake of HostConnection: records dispatched requests, answers via impl. */
const makeConnection = (captured, impl = defaultImpl) => ({
  createSharedFetchHandler: () => ({
    fetch: async (request) => {
      const endpoint = new URL(request.url).pathname.slice('/api/'.length)
      const body = await request.text()
      captured.push({ endpoint, body, contentType: request.headers.get('content-type') })
      return impl(endpoint, body)
    },
  }),
})

/** Fake of HostTypertGateway.wireStream. */
const fakeTypert = (streams) => ({
  wireStream: {
    open: async (endpoint) => (async function* () {
      for (const value of streams[endpoint] ?? []) yield value
    })(),
    failure: (error) => ({ code: 'test/failure', message: String(error?.message ?? error), details: {} }),
  },
})

const makeWebServer = () => {
  const routes = new Map()
  const upgrades = new Map()
  return {
    routes, upgrades,
    register: (route) => { const key = route.kind + ':' + route.path; routes.set(key, route.handler); return () => routes.delete(key) },
    registerUpgrade: (route) => { upgrades.set(route.path, route.handler); return () => upgrades.delete(route.path) },
  }
}

const boot = async (config, { connection, typert } = {}) => {
  const root = new Context()
  const web = makeWebServer()
  root.provide('webServer', web)
  if (connection !== undefined) root.provide('connection', connection)
  if (typert !== undefined) root.provide('typertGateway', typert)
  root.provide('logger', { debug: () => {}, info: () => {}, warn: () => {} })
  // Object form so cordis validates the Config schema and fills the defaults
  // (prefix, whitelists, ...) exactly as the real host composition does.
  const fiber = root.plugin(plugin, config)
  await fiber
  return { root, web, fiber }
}

const fakeReq = (method, url, headers = {}, bodyBuf = null) => {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = headers
  req.destroy = () => {}
  queueMicrotask(() => {
    if (bodyBuf !== null) req.emit('data', bodyBuf)
    req.emit('end')
  })
  return req
}

const fakeRes = () => {
  const res = new EventEmitter()
  res.headers = {}
  res.statusCode = 200
  res.headersSent = false
  res.body = null
  res.ended = false
  res.setHeader = (k, v) => { res.headers[String(k).toLowerCase()] = v }
  res.writeHead = (code, hdrs) => { res.statusCode = code; res.headersSent = true; if (hdrs) Object.assign(res.headers, hdrs) }
  res.end = (chunk) => { res.body = chunk; res.ended = true }
  res.destroy = () => {}
  return res
}

const call = async (web, method, url, { headers = {}, body = null } = {}) => {
  const handler = web.routes.get('prefix:/api-gw/v1')
  assert.ok(handler, 'the prefix route is mounted')
  const req = fakeReq(method, url, headers, body)
  const res = fakeRes()
  await handler(req, res)
  return res
}

// ---- HTTP surface ----

test('index + health: no auth needed, reports dispatch reachability and key state', async () => {
  const captured = []
  const { web, fiber } = await boot({ apiKeys: ['k1'] }, { connection: makeConnection(captured) })
  try {
    const index = await call(web, 'GET', '/api-gw/v1')
    assert.equal(index.statusCode, 200)
    const body = JSON.parse(index.body)
    assert.equal(body.service, 'dsh-api-gw')
    assert.ok(Array.isArray(body.endpoints))
    const health = await call(web, 'GET', '/api-gw/v1/health')
    assert.equal(health.statusCode, 200)
    const healthBody = JSON.parse(health.body)
    assert.equal(healthBody.status, 'ok')
    assert.equal(healthBody.apiKeySet, true)
    assert.equal(healthBody.upstream, 'ok')
    // The probe uses the same in-process path real traffic uses.
    assert.equal(captured.at(-1).endpoint, 'session/list')
  } finally {
    await fiber.dispose()
  }
})

test('health reports unreachable when the host connection service is absent', async () => {
  const { web, fiber } = await boot({ apiKeys: ['k1'] })
  try {
    const health = await call(web, 'GET', '/api-gw/v1/health')
    assert.equal(health.statusCode, 200)
    assert.equal(JSON.parse(health.body).upstream, 'unreachable')
  } finally {
    await fiber.dispose()
  }
})

test('proxy refuses non-whitelisted endpoints before dispatch', async () => {
  const captured = []
  const { web, fiber } = await boot({ apiKeys: ['k1'] }, { connection: makeConnection(captured) })
  try {
    for (const endpoint of ['credentials/set', 'settings/update', 'session/history']) {
      const res = await call(web, 'POST', '/api-gw/v1/proxy/' + endpoint, {
        headers: { 'x-api-key': 'k1' },
        body: Buffer.from('{}'),
      })
      assert.equal(res.statusCode, 403, endpoint)
      assert.equal(JSON.parse(res.body).error, 'method_not_allowed')
    }
    // Extra path segments are not an endpoint at all; the route 404s before
    // auth or whitelist logic runs.
    const extra = await call(web, 'POST', '/api-gw/v1/proxy/session/list/extra', {
      headers: { 'x-api-key': 'k1' }, body: Buffer.from('{}'),
    })
    assert.equal(extra.statusCode, 404)
    assert.equal(captured.length, 0, 'no dispatch may happen for refused endpoints')
    // Auth gates the whitelist: without a key the answer is 401, not 403.
    const anonymous = await call(web, 'POST', '/api-gw/v1/proxy/credentials/set', { body: Buffer.from('{}') })
    assert.equal(anonymous.statusCode, 401)
  } finally {
    await fiber.dispose()
  }
})

test('proxy forwards a whitelisted unary call verbatim', async () => {
  const captured = []
  const impl = (endpoint, body) => okResponse(JSON.stringify({
    type: 'server-response', rpcId: 'echo', result: { ok: true, value: { endpoint, got: body } },
  }))
  const { web, fiber } = await boot({ apiKeys: ['k1'] }, { connection: makeConnection(captured, impl) })
  try {
    const text = envelope('session/create', { request: { cwd: 'E:/work/demo' } }, 'r1')
    const res = await call(web, 'POST', '/api-gw/v1/proxy/session/create', {
      headers: { 'x-api-key': 'k1', 'content-type': 'application/json' },
      body: Buffer.from(text),
    })
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.result.ok, true)
    assert.equal(body.result.value.endpoint, 'session/create')
    assert.equal(captured.length, 1)
    assert.equal(captured[0].endpoint, 'session/create')
    assert.equal(captured[0].body, text, 'the envelope passes through unparsed')
  } finally {
    await fiber.dispose()
  }
})

test('proxy forwards the $events/result answer channel', async () => {
  const captured = []
  const { web, fiber } = await boot({ apiKeys: ['k1'] }, { connection: makeConnection(captured) })
  try {
    const res = await call(web, 'POST', '/api-gw/v1/proxy/$events/result', {
      headers: { 'x-api-key': 'k1' },
      body: Buffer.from(envelope('$events/result', { clientId: 'c1', eventId: 'e1', outcome: { kind: 'result' } })),
    })
    assert.equal(res.statusCode, 200)
    assert.equal(captured.length, 1)
    assert.equal(captured[0].endpoint, '$events/result')
  } finally {
    await fiber.dispose()
  }
})

test('auth: no key, wrong key, and Bearer form', async () => {
  const captured = []
  const { web, fiber } = await boot({ apiKeys: ['k1'] }, { connection: makeConnection(captured) })
  try {
    const none = await call(web, 'POST', '/api-gw/v1/proxy/session/list', { body: Buffer.from('{}') })
    assert.equal(none.statusCode, 401)
    assert.equal(captured.length, 0)
    const wrong = await call(web, 'POST', '/api-gw/v1/proxy/session/list', {
      headers: { 'x-api-key': 'nope' }, body: Buffer.from('{}'),
    })
    assert.equal(wrong.statusCode, 401)
    assert.equal(captured.length, 0)
    const bearer = await call(web, 'POST', '/api-gw/v1/proxy/session/list', {
      headers: { authorization: 'Bearer k1' }, body: Buffer.from('{}'),
    })
    assert.equal(bearer.statusCode, 200)
    assert.equal(captured.length, 1)
  } finally {
    await fiber.dispose()
  }
})

// ---- key lifecycle ----

test('key bootstrap mints once, closes for good, and the key works', async () => {
  const captured = []
  const { web, fiber } = await boot({ apiKeys: [], allowKeyProvision: true }, { connection: makeConnection(captured) })
  try {
    const first = await call(web, 'POST', '/api-gw/v1/key')
    assert.equal(first.statusCode, 200)
    const minted = JSON.parse(first.body)
    assert.equal(minted.persisted, false, 'no settings provider means in-memory only')
    assert.ok(minted.apiKey.startsWith('apigw-'))

    // Regression: the volatile key must close the unauthenticated window.
    const second = await call(web, 'POST', '/api-gw/v1/key')
    assert.equal(second.statusCode, 403)
    assert.equal(JSON.parse(second.body).error, 'key_already_provisioned')

    const proxied = await call(web, 'POST', '/api-gw/v1/proxy/session/list', {
      headers: { 'x-api-key': minted.apiKey }, body: Buffer.from('{}'),
    })
    assert.equal(proxied.statusCode, 200)
  } finally {
    await fiber.dispose()
  }
})

test('rotate-key revokes the previous key without a settings provider', async () => {
  const captured = []
  const { web, fiber } = await boot(
    { apiKeys: [], provisionedKey: 'apigw-old', adminKey: 'adm' },
    { connection: makeConnection(captured) },
  )
  try {
    const before = await call(web, 'POST', '/api-gw/v1/proxy/session/list', {
      headers: { 'x-api-key': 'apigw-old' }, body: Buffer.from('{}'),
    })
    assert.equal(before.statusCode, 200)

    const rotated = await call(web, 'POST', '/api-gw/v1/admin/rotate-key', { headers: { 'x-admin-key': 'adm' } })
    assert.equal(rotated.statusCode, 200)
    const minted = JSON.parse(rotated.body).apiKey

    // Regression: the old key used to stay accepted because the live config
    // still carried it while only the volatile slot was replaced.
    const old = await call(web, 'POST', '/api-gw/v1/proxy/session/list', {
      headers: { 'x-api-key': 'apigw-old' }, body: Buffer.from('{}'),
    })
    assert.equal(old.statusCode, 401)
    const fresh = await call(web, 'POST', '/api-gw/v1/proxy/session/list', {
      headers: { 'x-api-key': minted }, body: Buffer.from('{}'),
    })
    assert.equal(fresh.statusCode, 200)
  } finally {
    await fiber.dispose()
  }
})

// ---- mux upgrade surface ----

test('mux upgrade refuses unauthenticated callers before the handshake', async () => {
  const { web, fiber } = await boot({ apiKeys: ['k1'] })
  try {
    const handler = web.upgrades.get('/api-gw/v1/events.mux')
    assert.ok(handler, 'the upgrade route is mounted')
    let ended = null
    const socket = { end: (chunk) => { ended = String(chunk) } }
    const req = fakeReq('GET', '/api-gw/v1/events.mux', {})
    await handler(req, socket, Buffer.alloc(0))
    assert.match(ended, /401 Unauthorized/)
  } finally {
    await fiber.dispose()
  }
})

test('mux upgrade serves whitelisted streams to an authenticated client', async () => {
  const { web, fiber } = await boot(
    { apiKeys: ['k1'] },
    { connection: makeConnection([]), typert: fakeTypert({ $events: [{ type: 'ready', clientId: 'c1' }] }) },
  )
  const server = createServer()
  server.on('upgrade', (req, socket, head) => {
    const handler = web.upgrades.get(String(req.url).split('?')[0])
    if (handler === undefined) { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return }
    handler(req, socket, head)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api-gw/v1/proxy/events.mux`, {
      headers: { 'x-api-key': 'k1' },
    })
    const frames = []
    await new Promise((resolve, reject) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'open', streamId: 's1', endpoint: '$events', payload: { args: {} } }))
      })
      ws.on('message', (data) => {
        frames.push(JSON.parse(String(data)))
        if (frames.at(-1).type === 'end') resolve()
      })
      ws.on('error', reject)
    })
    assert.deepEqual(frames, [
      { type: 'item', streamId: 's1', value: { type: 'ready', clientId: 'c1' } },
      { type: 'end', streamId: 's1' },
    ])
    ws.close()
  } finally {
    await new Promise((resolve) => server.close(resolve))
    await fiber.dispose()
  }
})

// ---- master switch ----

test('a disabled gateway answers 503 while health stays up', async () => {
  const captured = []
  const { web, fiber } = await boot({ apiKeys: ['k1'], enabled: false }, { connection: makeConnection(captured) })
  try {
    const health = await call(web, 'GET', '/api-gw/v1/health')
    assert.equal(health.statusCode, 200)
    assert.equal(JSON.parse(health.body).status, 'disabled')
    const proxied = await call(web, 'POST', '/api-gw/v1/proxy/session/create', {
      headers: { 'x-api-key': 'k1' }, body: Buffer.from('{}'),
    })
    assert.equal(proxied.statusCode, 503)
    // The health probe may still dispatch session/list; what must not happen is
    // any dispatch for the proxied endpoint.
    assert.equal(captured.some((entry) => entry.endpoint === 'session/create'), false)
  } finally {
    await fiber.dispose()
  }
})
