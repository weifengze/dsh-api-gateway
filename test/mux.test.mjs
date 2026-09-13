/**
 * Mux protocol tests: client-frame validation and the server session pump.
 * Runs against the BUILT output (`lib/`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { MuxSession, parseMuxClientMessage } from '../lib/mux.js'

// ---- pure frame validation ----

test('parseMuxClientMessage accepts a well-formed open', () => {
  const message = parseMuxClientMessage(JSON.stringify({
    type: 'open', streamId: 's1', endpoint: '$events', payload: { args: {} },
  }))
  assert.deepEqual(message, { type: 'open', streamId: 's1', endpoint: '$events', payload: { args: {} } })
})

test('parseMuxClientMessage accepts cancel', () => {
  assert.deepEqual(parseMuxClientMessage('{"type":"cancel","streamId":"s1"}'), { type: 'cancel', streamId: 's1' })
})

test('parseMuxClientMessage rejects malformed frames', () => {
  const invalid = [
    'not json',
    '{}',
    '{"type":"open"}',
    '{"type":"open","streamId":"","endpoint":"$events","payload":{}}',
    '{"type":"open","streamId":"s1","endpoint":"","payload":{}}',
    '{"type":"open","streamId":"s1","endpoint":"$events"}',                      // payload required
    '{"type":"open","streamId":"s1","endpoint":"$events","payload":{},"x":1}',   // no extra keys
    '{"type":"cancel"}',
    '{"type":"cancel","streamId":""}',
    '{"type":"cancel","streamId":"s1","extra":true}',
    '{"type":"nope","streamId":"s1"}',
  ]
  for (const text of invalid) {
    assert.equal(parseMuxClientMessage(text), null, text)
  }
})

// ---- server session over a real socket pair ----

const startHost = async (options) => {
  const server = createServer()
  const wss = new WebSocketServer({ server })
  const sessions = []
  wss.on('connection', (ws) => { sessions.push(new MuxSession(ws, options)) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    close: async () => {
      for (const session of sessions) session.close()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/**
 * Connect a client whose frames are queued from the first moment: consecutive
 * frames can arrive in one TCP read and be emitted synchronously, so a
 * per-assertion `once('message')` listener attached after an await would drop
 * frames that arrived in between.
 */
const connect = (port) => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  const queue = []
  const waiters = []
  ws.on('message', (data) => {
    const frame = JSON.parse(String(data))
    const waiter = waiters.shift()
    if (waiter !== undefined) waiter(frame)
    else queue.push(frame)
  })
  const nextFrame = () => queue.length > 0
    ? Promise.resolve(queue.shift())
    : new Promise((resolveFrame) => waiters.push(resolveFrame))
  ws.on('open', () => resolve({ ws, nextFrame }))
  ws.on('error', reject)
})

const closed = (ws) => new Promise((resolve) => ws.once('close', (code) => resolve(code)))

const fakeGateway = (streams) => ({
  wireStream: {
    open: async (endpoint, _payload, signal) => {
      const frames = streams[endpoint]
      if (frames === undefined) throw new Error(`no such stream: ${endpoint}`)
      return (async function* () {
        for (const frame of frames) {
          if (signal.aborted) return
          yield frame
        }
      })()
    },
    failure: (error) => ({ code: 'test/stream-failed', message: String(error?.message ?? error), details: {} }),
  },
})

const gatewayOptions = (streams, whitelist = ['$events', 'session/follow', 'session/control']) => ({
  gateway: () => fakeGateway(streams),
  whitelist: () => whitelist,
})

test('mux pumps item frames and a terminal end frame', async () => {
  const host = await startHost(gatewayOptions({ $events: [{ type: 'ready', clientId: 'c1' }, { type: 'emit', event: 'x' }] }))
  const { ws, nextFrame } = await connect(host.port)
  try {
    ws.send(JSON.stringify({ type: 'open', streamId: 's1', endpoint: '$events', payload: { args: {} } }))
    assert.deepEqual(await nextFrame(), { type: 'item', streamId: 's1', value: { type: 'ready', clientId: 'c1' } })
    assert.deepEqual(await nextFrame(), { type: 'item', streamId: 's1', value: { type: 'emit', event: 'x' } })
    assert.deepEqual(await nextFrame(), { type: 'end', streamId: 's1' })
  } finally {
    ws.close()
    await host.close()
  }
})

test('mux refuses a non-whitelisted stream endpoint without opening it', async () => {
  let opened = 0
  const options = {
    gateway: () => ({
      wireStream: {
        open: async () => { opened += 1; return (async function* () {})() },
        failure: (error) => ({ code: 'x', message: String(error), details: {} }),
      },
    }),
    whitelist: () => ['$events'],
  }
  const host = await startHost(options)
  const { ws, nextFrame } = await connect(host.port)
  try {
    ws.send(JSON.stringify({ type: 'open', streamId: 's1', endpoint: 'workspace/follow', payload: { args: {} } }))
    const frame = await nextFrame()
    assert.equal(frame.type, 'error')
    assert.equal(frame.error.code, 'gateway/endpoint-not-allowed')
    assert.equal(frame.error.details.endpoint, 'workspace/follow')
    assert.equal(opened, 0, 'a refused endpoint must never reach the host gateway')
  } finally {
    ws.close()
    await host.close()
  }
})

test('mux maps a stream failure through the host failure mapper', async () => {
  const host = await startHost(gatewayOptions({}))
  const { ws, nextFrame } = await connect(host.port)
  try {
    ws.send(JSON.stringify({ type: 'open', streamId: 's1', endpoint: 'session/follow', payload: { args: {} } }))
    const frame = await nextFrame()
    assert.equal(frame.type, 'error')
    assert.equal(frame.error.code, 'test/stream-failed')
    assert.match(frame.error.message, /no such stream/)
  } finally {
    ws.close()
    await host.close()
  }
})

test('mux reports an unavailable host gateway instead of crashing', async () => {
  const host = await startHost({ gateway: () => undefined, whitelist: () => ['$events'] })
  const { ws, nextFrame } = await connect(host.port)
  try {
    ws.send(JSON.stringify({ type: 'open', streamId: 's1', endpoint: '$events', payload: { args: {} } }))
    const frame = await nextFrame()
    assert.equal(frame.type, 'error')
    assert.equal(frame.error.code, 'gateway/service-unavailable')
  } finally {
    ws.close()
    await host.close()
  }
})

test('mux closes a malformed frame with 1008', async () => {
  const host = await startHost(gatewayOptions({}))
  const { ws } = await connect(host.port)
  try {
    ws.send('{"type":"open"}')
    assert.equal(await closed(ws), 1008)
  } finally {
    await host.close()
  }
})

test('mux closes a binary frame with 1003', async () => {
  const host = await startHost(gatewayOptions({}))
  const { ws } = await connect(host.port)
  try {
    ws.send(Buffer.from('binary'))
    assert.equal(await closed(ws), 1003)
  } finally {
    await host.close()
  }
})

test('mux closes a duplicate stream id with 1008', async () => {
  // A hanging stream keeps the id active, so the duplicate is unambiguous.
  const options = {
    gateway: () => ({
      wireStream: {
        open: async (_endpoint, _payload, signal) => (async function* () {
          await new Promise((resolve) => { signal.addEventListener('abort', resolve, { once: true }) })
        })(),
        failure: (error) => ({ code: 'x', message: String(error), details: {} }),
      },
    }),
    whitelist: () => ['$events'],
  }
  const host = await startHost(options)
  const { ws } = await connect(host.port)
  try {
    ws.send(JSON.stringify({ type: 'open', streamId: 's1', endpoint: '$events', payload: { args: {} } }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    ws.send(JSON.stringify({ type: 'open', streamId: 's1', endpoint: '$events', payload: { args: {} } }))
    assert.equal(await closed(ws), 1008)
  } finally {
    ws.close()
    await host.close()
  }
})
