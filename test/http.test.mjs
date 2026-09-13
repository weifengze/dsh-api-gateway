/**
 * Unit tests for the HTTP plumbing (CORS negotiation, route splitting,
 * one-time key provisioning). Runs against the BUILT output (`lib/`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { provisionDecision, resolveCorsOrigin, routeSegments } from '../lib/http.js'

const provision = (over = {}) => provisionDecision({
  provisionedKey: undefined,
  apiKeys: [],
  allowKeyProvision: true,
  prefix: '/api-gw/v1',
  ...over,
})

test('provisionDecision mints only when the deployment has no key at all', () => {
  assert.deepEqual(provision(), { action: 'mint' })
  // Empty strings are not keys: a blank entry in the list must not be mistaken
  // for a configured credential and lock the bootstrap out.
  assert.deepEqual(provision({ apiKeys: ['', ''] }), { action: 'mint' })
  assert.deepEqual(provision({ provisionedKey: '' }), { action: 'mint' })
})

test('provisionDecision refuses once a static key is configured', () => {
  // The regression this exists for: an operator sets apiKeys, and an
  // unauthenticated caller could still mint a second, equally powerful key.
  const decision = provision({ apiKeys: ['operator-key'] })
  assert.equal(decision.action, 'refuse')
  assert.equal(decision.status, 403)
  assert.equal(decision.error, 'key_already_provisioned')
})

test('provisionDecision stays closed after the first mint is persisted', () => {
  // Persisted `provisionedKey` is what makes the bootstrap one-time *ever*
  // rather than once per restart, so this is the check that the window does not
  // reopen on the next boot.
  const decision = provision({ provisionedKey: 'apigw-abc' })
  assert.equal(decision.action, 'refuse')
  assert.equal(decision.error, 'key_already_provisioned')
  assert.match(decision.hint, /rotate-key/)
})

test('provisionDecision reports a disabled bootstrap distinctly from a used one', () => {
  const decision = provision({ allowKeyProvision: false })
  assert.equal(decision.action, 'refuse')
  assert.equal(decision.status, 403)
  assert.equal(decision.error, 'key_provisioning_disabled')
})

test('provisionDecision stays closed while a minted key lives only in memory', () => {
  // Regression: a deployment without a settings provider kept the minted key
  // in a volatile slot, and the predicate ignored it — so the unauthenticated
  // /key window stayed open (and an admin rotation could be overwritten by an
  // anonymous mint). The volatile flag must close it.
  const decision = provision({ volatileKey: true })
  assert.equal(decision.action, 'refuse')
  assert.equal(decision.error, 'key_already_provisioned')
  assert.match(decision.hint, /rotate-key/)
})

test('resolveCorsOrigin passes wildcard through without Vary', () => {
  assert.deepEqual(resolveCorsOrigin('*', 'https://a.example'), { origin: '*', vary: false })
  assert.deepEqual(resolveCorsOrigin(['*', 'https://a.example'], undefined), { origin: '*', vary: false })
  assert.deepEqual(resolveCorsOrigin([], undefined), { origin: '*', vary: false })
})

test('resolveCorsOrigin echoes a matching origin from an allow-list', () => {
  const list = ['https://a.example', 'https://b.example']
  assert.deepEqual(resolveCorsOrigin(list, 'https://b.example'), { origin: 'https://b.example', vary: true })
})

test('resolveCorsOrigin never emits a joined list for a non-matching origin', () => {
  const list = ['https://a.example', 'https://b.example']
  const { origin } = resolveCorsOrigin(list, 'https://evil.example')
  assert.equal(origin, null)
  const missing = resolveCorsOrigin(list, undefined)
  assert.equal(missing.origin, null)
})

test('resolveCorsOrigin allows a single configured origin even without an Origin header', () => {
  assert.deepEqual(resolveCorsOrigin('https://a.example', undefined), { origin: 'https://a.example', vary: true })
  assert.deepEqual(resolveCorsOrigin(['https://a.example'], 'https://a.example'), { origin: 'https://a.example', vary: true })
})

test('routeSegments strips the prefix and the query string', () => {
  assert.deepEqual(routeSegments('/api-gw/v1', '/api-gw/v1/sessions/abc/stream?since=3'), ['sessions', 'abc', 'stream'])
  assert.deepEqual(routeSegments('/api-gw/v1', '/api-gw/v1'), [])
  assert.deepEqual(routeSegments('/api-gw/v1', '/api-gw/v1/'), [])
  assert.deepEqual(routeSegments('api-gw/v1/', '/api-gw/v1/health'), ['health'])
})

test('routeSegments rejects URLs outside the prefix', () => {
  assert.equal(routeSegments('/api-gw/v1', '/other/health'), null)
  assert.equal(routeSegments('/api-gw/v1', '/api-gw'), null)
  assert.equal(routeSegments('/api-gw/v1', '/api-gw/v2/health'), null)
  assert.equal(routeSegments('/api-gw/v1', undefined), null)
})

test('routeSegments keeps the slash-form endpoint as two segments', () => {
  // DSH 0.1.5 endpoints are `<namespace>/<method>`; the proxy route carries
  // them as two path segments after /proxy.
  assert.deepEqual(routeSegments('/api-gw/v1', '/api-gw/v1/proxy/session/create'), ['proxy', 'session', 'create'])
  assert.deepEqual(routeSegments('/api-gw/v1', '/api-gw/v1/proxy/$events/result'), ['proxy', '$events', 'result'])
})
