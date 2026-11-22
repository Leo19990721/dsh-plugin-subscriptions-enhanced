/** Isolated source-composition tests. Copied by the reproduction script next to the stock Session host fixture. */
import { EventEmitter } from 'node:events'
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import WorkspaceController from '@deepseek-ai/dsh-api-workspace-controller'
import { TYPERT as sessionType } from '@deepseek-ai/dsh-api-session-controller/typert'
import { TYPERT as uploadType } from '@deepseek-ai/dsh-client-file-upload/typert'
import { TYPERT as workspaceType } from '../../workspace-controller/lib/typert.host.js'
import { SessionTitleService } from '@deepseek-ai/dsh-session-title'
import * as FirstPromptTitle from '@deepseek-ai/dsh-session-title-first-prompt-llm'
import { validateTypertManifest } from '@deepseek-ai/dsh-typert-loader'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { ModelCatalog, SessionPromptRequest, SessionRequestId } from '../src/types.ts'
import { expect, it, onTestFinished } from 'vitest'
import { AgyAcpClient } from './subscriptions-agy/agy-acp-client.js'
import { mountAgyNativeTurnHost } from './subscriptions-agy/agy-native-turn-host.js'
import { openAgyTurnLedger } from './subscriptions-agy/agy-turn-ledger.js'
import { parseAgyTurnOptions } from './subscriptions-agy/agy-turn-options.js'
import { createAgyTurnSession } from './subscriptions-agy/agy-turn-session.js'
import { createSessionTurnHost, sessionTurnModels } from './session-turn-provider-fixture.ts'

const SELECTED = { provider: 'turn:antigravity', model: 'fixture-official', reasoningEffort: 'high' } as const
const SESSION = SessionId('native-connection-same-conversation')
const OFFICIAL = 'synthetic-official-one'
const schema = [
  { type: 'select', id: 'model-selector', category: 'model', name: 'Model', currentValue: SELECTED.model,
    options: [{ value: SELECTED.model, name: 'Synthetic Antigravity' }] },
  { type: 'select', id: 'effort-selector', category: 'thought_level', name: 'Thinking', currentValue: 'low',
    options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
]
const strictFaces = [
  ['@deepseek-ai/dsh-api-session-controller', sessionType],
  ['@deepseek-ai/dsh-client-file-upload', uploadType],
  ['@deepseek-ai/dsh-api-workspace-controller', workspaceType],
] as const
const ACCEPTED = { ok: true, value: { accepted: true } }
const LOCAL = { ok: false, error: { code: 'session/agent-busy', details: { reason: 'LOCAL_TURN_UNAVAILABLE' } } }
const TEXT_ONLY = { ok: false, error: { code: 'session/attachment-invalid', details: { reason: 'TEXT_ONLY_SELECTION' } } }
const STALE = { ok: false, error: { code: 'session/agent-busy', details: { reason: 'MODEL_SELECTION_CHANGED' } } }

type Packet = { readonly id?: number | string; readonly method?: string; readonly params?: Record<string, unknown>; readonly result?: unknown }

function officialChild(reply: (packet: Packet, send: (packet: object) => void, disconnect: () => void) => void) {
  const child = new EventEmitter()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const send = (packet: object) => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...packet })}\n`)
  let exited = false
  const exit = (code: number) => {
    if (exited) return
    exited = true
    child.emit('exit', code, null)
    stdout.end()
    stderr.end()
  }
  const stdin = new Writable({
    write(bytes: Buffer, _encoding, done) {
      try { reply(JSON.parse(bytes.toString('utf8')) as Packet, send, () => queueMicrotask(() => exit(1))); done() }
      catch (error) { done(error instanceof Error ? error : new Error('Synthetic ACP write refused')) }
    },
    final(done) { done(); queueMicrotask(() => exit(0)) },
  })
  return Object.assign(child, { stdin, stdout, stderr, kill() { queueMicrotask(() => exit(0)); return true } })
}

function ok<T>(result: { readonly ok: boolean; readonly value?: unknown }): T {
  expect(result.ok).toBe(true)
  return result.value as T
}

type Replay = {
  readonly header: SessionHeader
  readonly events: readonly SessionEvent[]
  readonly row: ReturnType<Awaited<ReturnType<typeof openAgyTurnLedger>>['read']>
  readonly promptCount: number
}

async function setup({ failSecond = false, replay }: { failSecond?: boolean; replay?: Replay } = {}) {
  const calls: Packet[] = []
  const replies: object[] = []
  const secondDispatched = Promise.withResolvers<void>()
  let mode = 'low'
  let promptCount = replay?.promptCount ?? 0
  let hold: { id: Packet['id']; send: (packet: object) => void } | undefined
  let cwd: string
  let ledger: Awaited<ReturnType<typeof openAgyTurnLedger>>
  const closeSecond = () => {
    const pending = hold
    hold = undefined
    if (pending === undefined) return
    pending.send({ method: 'session/update', params: { sessionId: OFFICIAL,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'tail' } } } })
    pending.send({ id: pending.id, result: { stopReason: 'cancelled' } })
    pending.send({ method: 'session/update', params: { sessionId: OFFICIAL,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'must not display' } } } })
  }
  const host = await createSessionTurnHost({
    http: true, search: true, ordinaryResponses: ['ordinaryinterlude', 'ordinaryafterstop'], beforeDispose: closeSecond,
    extras: [
      { id: 'workspaceController', plugin: WorkspaceController },
      { id: 'sessionTitle', plugin: SessionTitleService, config: { fallbackMaxWords: 10, fallbackMaxBytes: 128, maxTitleBytes: 128 } },
      { id: 'firstPromptTitle', plugin: FirstPromptTitle, config: {
        targetWords: 5, targetCjkCharacters: 10, maxInputBytes: 4096, maxOutputTokens: 4096, timeoutMs: 1500,
      } },
      { id: 'generatedTypert', plugin: { inject: ['typert'], apply(owner: Context) {
        for (const [pkg, artifact] of strictFaces) owner.typert.register(validateTypertManifest(pkg, artifact))
      } } },
      { id: 'subscriptionsAgy', plugin: { inject: ['agentLoop', 'agents', 'connection', 'sessionController', 'sessionPersistence', 'sessions', 'storageDomain', 'webServer', 'workspaceRegistry', 'workingDirectory'],
        async apply(owner: Context) {
          ledger = await openAgyTurnLedger(owner.storageDomain)
          owner.effect(() => ledger.close, 'synthetic ledger')
          mountAgyNativeTurnHost(owner, {
            options: parseAgyTurnOptions(schema), defaultEffort: 'low', ledger,
            makeSession({ cwd: requested }: { cwd: string }) {
              expect(requested).toBe(cwd)
              return createAgyTurnSession({ cwd, timeLimits: { open: 1500, turn: 5000, cancel: 1500 },
                makeClient: (hooks: object) => new AgyAcpClient({
                  ...hooks, cwd, executable: join(cwd, 'not-launched-agy.exe'), env: {}, timeoutMs: 1500,
                  spawnFactory: () => {
                    mode = 'low'
                    let firstPromptId: Packet['id']
                    return officialChild((packet, send, disconnect) => {
                      if (packet.method === undefined) {
                        replies.push(packet)
                        if (packet.id === 'tool-fixture' && firstPromptId !== undefined) {
                          send({ method: 'session/update', params: { sessionId: OFFICIAL,
                            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'acpvisiblefirst' } } } })
                          send({ id: firstPromptId, result: { stopReason: 'end_turn' } })
                        }
                        return
                      }
                      calls.push(packet)
                      const result = (value: object) => send({ id: packet.id, result: value })
                      const configOptions = () => [schema[0], { ...schema[1], currentValue: mode }]
                      const text = (value: string) => send({ method: 'session/update', params: { sessionId: OFFICIAL,
                        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } } } })
                      switch (packet.method) {
                        case 'initialize': result({ protocolVersion: 1, agentInfo: { name: 'Antigravity ACP Server', version: 'fixture' },
                          agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } } }); break
                        case 'session/new':
                        case 'session/load': result({ sessionId: OFFICIAL, configOptions: configOptions() }); break
                        case 'session/set_config_option':
                          expect(packet.params?.configId).toBe('effort-selector')
                          mode = String(packet.params?.value)
                          result({ configOptions: configOptions() }); break
                        case 'session/prompt':
                          if (++promptCount === 1) {
                            firstPromptId = packet.id
                            send({ id: 'tool-fixture', method: 'session/request_permission', params: {
                              sessionId: OFFICIAL, toolCall: { toolCallId: 'fixture-read', kind: 'read', title: 'Synthetic read', rawInput: { path: join(cwd, 'example.txt') } },
                              options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
                                { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }],
                            } })
                          } else {
                            text('partial ')
                            secondDispatched.resolve()
                            if (failSecond) disconnect()
                            else if (promptCount === 2) hold = { id: packet.id, send }
                            else result({ stopReason: 'end_turn' })
                          }
                          break
                        case 'session/cancel': closeSecond(); break
                        case 'session/close': result({}); break
                        default: throw new Error(`Unexpected fixture method ${packet.method}`)
                      }
                    })
                  },
                }),
              })
            },
          })
        } } },
    ],
  })
  cwd = replay?.header.cwd ?? join(host.root, 'project')
  if (replay === undefined) await mkdir(cwd)
  const browser = { headers: { cookie: await host.http.cookie() } }
  const operator = { headers: { cookie: await host.http.cookie('operator') } }
  const { workspace } = ok<{ workspace: { workspaceId: string } }>(await host.http.rpc('workspace/create', { request: { path: cwd } }, browser))
  if (replay !== undefined) {
    // A graceful Agent disposal intentionally clears its queue. To exercise
    // interrupted-process recovery, reopen the exact pre-disposal log and
    // ledger with a new Loader, browser peer, and executor registration.
    {
      const writer = await host.ctx.sessionPersistence.create(replay.header)
      try { await writer.append(replay.events) } finally { await writer.close() }
    }
    if (replay.row !== undefined) await ledger.write(SESSION, replay.row)
    await host.ctx.agents.resume({ resumeSessionId: SESSION, agentOptions: sessionTurnModels.ordinary })
    const entry = host.ctx.workspaceRegistry.list().find(item => item.id === workspace.workspaceId)
    if (entry === undefined) throw new Error('Fixture Workspace missing')
    await entry.attachSession(SESSION)
  } else {
    expect(await host.http.rpc('session/create', { request: { sessionId: SESSION, workspaceId: workspace.workspaceId } }, browser))
      .toMatchObject({ ok: true, value: { sessionId: SESSION } })
  }
  expect(host.ctx.workspaceRegistry.list().find(entry => entry.id === workspace.workspaceId)?.sessionIds).toEqual([SESSION])
  const getAgent = () => {
    const agent = host.ctx.agents.get(SESSION)
    if (agent === undefined) throw new Error('The native Session did not attach')
    return agent
  }
  const agent = getAgent()
  const rpc = (method: string, args: Record<string, unknown> = {}) => host.http.rpc(method, args, browser)
  const select = (selection: typeof SELECTED | typeof sessionTurnModels.ordinary | typeof sessionTurnModels.next) =>
    rpc('session/selectModel', { request: { sessionId: SESSION, ...selection } })
  const promptRequest = (id: string, text: string, extras: Partial<SessionPromptRequest> = {}): SessionPromptRequest => ({
    requestId: id as SessionRequestId, sessionId: SESSION, mode: 'queue', content: [{ type: 'text', text }],
    ...(getAgent().model.current()?.provider === SELECTED.provider ? { expectedSelection: SELECTED } : {}), ...extras,
  })
  const send = (id: string, text: string, extras?: Partial<SessionPromptRequest>) => rpc('session/prompt', { request: promptRequest(id, text, extras) })
  const catalogRequest = { request: { audience: 'conversation', sessionId: SESSION } }
  async function snapshot() {
    await host.ctx.sessionPersistence.flush()
    const handle = await host.ctx.sessionPersistence.open(SESSION, 'read')
    try { return { header: handle.header, events: (await handle.read()).events } } finally { await handle.close() }
  }
  const stored = async () => (await snapshot()).events
  const capture = async (): Promise<Replay> => ({ ...await snapshot(), row: ledger.read(SESSION), promptCount })
  return { ...host, agent, capture, rpc, browser, operator, select, send, promptRequest, catalogRequest, stored, calls, replies,
    secondDispatched: secondDispatched.promise, row: () => ledger.read(SESSION) }
}

it('keeps the exact native conversation through official ACP, ordinary turns, search, pin, and archive', async () => {
  const h = await setup()
  const { ctx, agent, rpc, catalogRequest } = h
  expect(ctx.typert.local.get('session/modelCatalog')?.parameters[0]).toMatchObject({ wire: 'request', acceptsUndefined: true, codec: { mode: 'strict' } })
  const unscoped = ok<ModelCatalog>(await rpc('session/modelCatalog'))
  expect(unscoped.groups.map(group => group.id)).toEqual(['mock'])
  const catalog = ok<ModelCatalog>(await rpc('session/modelCatalog', catalogRequest))
  expect(catalog).toMatchObject({ selected: sessionTurnModels.ordinary, routableProviders: ['mock'] })
  expect(catalog.groups.at(-1)).toMatchObject({ id: SELECTED.provider, input: 'text-only' })
  expect(h.calls).toEqual([])
  expect(await h.select(SELECTED)).toMatchObject({ ok: true, value: { selected: SELECTED } })
  expect(await h.send('first', 'firstprompt', { mode: 'steer', expectedSelection: SELECTED })).toMatchObject(ACCEPTED)
  await agent.whenIdle()
  const one = await h.stored()
  expect(one.find(event => 'surfaceOp' in event)).toMatchObject({ type: 'system/message', data: { message: { content: [] } } })
  expect(h.row()).toMatchObject({ officialId: OFFICIAL, pending: null, stopReason: 'end_turn' })
  expect(h.replies).toContainEqual(expect.objectContaining({ id: 'tool-fixture', result: { outcome: { outcome: 'cancelled' } } }))
  expect(ctx.agents.get(SESSION)).toBe(agent)
  expect(await h.select(sessionTurnModels.next)).toMatchObject({ ok: true })
  expect(ctx.agentDefaultModel.currentSelection()).toEqual(sessionTurnModels.ordinary)
  expect(await h.send('interlude', 'ordinaryquestion')).toMatchObject(ACCEPTED)
  await agent.whenIdle()
  expect(h.adapter.requests).toHaveLength(1)
  expect(JSON.stringify(h.adapter.requests[0]?.messages)).toContain('acpvisiblefirst')
  await ctx.sessionTitle.refresh(agent.session)
  expect(h.adapter.requests).toHaveLength(1)
  expect(await h.select(SELECTED)).toMatchObject({ ok: true })
  expect(await h.send('second', 'secondprompt')).toMatchObject(ACCEPTED)
  await h.secondDispatched
  const second = h.calls.filter(call => call.method === 'session/prompt').at(-1)
  expect(second?.params?.prompt).toEqual([{ type: 'text', text: 'secondprompt' }])
  expect(h.calls.filter(call => call.method === 'session/new')).toHaveLength(1)
  expect(h.calls.filter(call => call.method === 'session/load')).toMatchObject([{ params: { sessionId: OFFICIAL } }])
  expect(await h.select(sessionTurnModels.next)).toMatchObject({ ok: true })
  const stop = { request: { sessionId: SESSION } }
  const streamSignal = new AbortController()
  const request = { address: { kind: 'session', sessionId: SESSION }, assistantStream: true, turnReservation: true }
  const follow = (await ctx.typertGateway.wireStream.open('session/follow', { args: { request } },
    { async *[Symbol.asyncIterator]() { /* No uplink frames are sent. */ } }, ctx.connection.browserPeer, streamSignal.signal))[Symbol.asyncIterator]()
  onTestFinished(async () => { streamSignal.abort(); await follow.return?.() })
  const codec = ctx.typert.local.get('session/follow')?.result
  if (codec?.mode !== 'strict') throw new Error('Missing official follow codec')
  const decode = codec.create()
  expect(decode.parse((await follow.next()).value)).toMatchObject({ type: 'snapshot', wholeTurnActive: true })
  const { turnReservation: _optIn, ...legacyRequest } = request
  const legacy = (await ctx.typertGateway.wireStream.open('session/follow', { args: { request: legacyRequest } },
    { async *[Symbol.asyncIterator]() { /* No uplink frames are sent. */ } }, ctx.connection.browserPeer, streamSignal.signal))[Symbol.asyncIterator]()
  try {
    const snapshot = decode.parse((await legacy.next()).value)
    expect(snapshot).toMatchObject({ type: 'snapshot' })
    expect(snapshot).not.toHaveProperty('wholeTurnActive')
  } finally { await legacy.return?.() }
  expect(await h.http.rpc('session/cancel', stop, h.operator)).toMatchObject(LOCAL)
  expect(await rpc('session/cancel', stop)).toMatchObject(ACCEPTED)
  await agent.whenIdle()
  for (;;) {
    const next = await follow.next()
    if (next.done) throw new Error('The follow stream closed before releasing the reservation')
    const item = decode.parse(next.value) as { readonly type: string }
    if (item.type !== 'turn-reservation') continue
    expect(item).toMatchObject({ wholeTurnActive: false })
    break
  }
  await follow.return?.()
  expect(await h.send('ordinary-after', 'new native text', { mode: 'steer' })).toMatchObject(ACCEPTED)
  await agent.whenIdle()
  const all = await h.stored()
  expect(all.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind)).toEqual(['completed', 'completed', 'aborted', 'completed'])
  expect(all.find(event => event.type === 'assistant/message' && event.data.turn === 3)).toMatchObject({
    data: { interrupted: true, message: { content: [{ type: 'text', text: 'partial tail' }] } },
  })
  expect(h.row()).toMatchObject({ officialId: OFFICIAL, pending: null, stopReason: 'cancelled' })
  expect(ok<{ items: { sessionId: string }[] }>(await rpc('session/list', { _request: {} })).items.map(row => row.sessionId)).toEqual([SESSION])
  expect(await rpc('session/search', { request: { query: 'acpvisiblefirst' } })).toMatchObject({ ok: true, value: { items: [{ sessionId: SESSION }] } })
  expect(await rpc('workspace/pinSession', stop)).toMatchObject({ ok: true, value: { pinnedSessionIds: [SESSION] } })
  expect(await rpc('workspace/archiveSession', stop)).toMatchObject({ ok: true, value: { archivedSessionIds: [SESSION] } })
  expect(ok<ModelCatalog>(await rpc('session/modelCatalog', catalogRequest)).groups.map(group => group.id)).toEqual(['mock'])
  expect(await rpc('workspace/unarchiveSession', stop)).toMatchObject({ ok: true, value: { archivedSessionIds: [] } })
  expect(ctx.agents.get(SESSION)).toBe(agent)
})

it('accepts only authenticated loopback browser actions and refuses nontext before receipts', async () => {
  const h = await setup()
  const { ctx, agent, rpc, catalogRequest } = h
  expect(ok<ModelCatalog>(await h.http.rpc('session/modelCatalog', catalogRequest, h.operator)).groups.map(group => group.id)).toEqual(['mock'])
  expect(ok<ModelCatalog>(await h.http.rpc('session/modelCatalog', catalogRequest, { ...h.browser, remoteAddress: '192.0.2.9' })).groups.map(group => group.id)).toEqual(['mock'])
  const select = { request: { sessionId: SESSION, ...SELECTED } }
  expect(await h.http.rpc('session/selectModel', select, h.operator)).toMatchObject(LOCAL)
  await expect(ctx.typertGateway.invoke({ namespace: 'session', method: 'selectModel', args: select, peer: ctx.connection.browserPeer })).rejects.toMatchObject(LOCAL.error)
  expect(await h.select(SELECTED)).toMatchObject({ ok: true })
  const { expectedSelection: _chosen, ...staleWindow } = h.promptRequest('missed-remote-selection', 'draft typed for the ordinary model')
  expect(await rpc('session/prompt', { request: staleWindow })).toMatchObject(STALE)
  const direct = { request: h.promptRequest('synthetic-operator', 'forbidden') }
  expect(await h.http.rpc('session/prompt', direct, h.operator)).toMatchObject(LOCAL)
  await expect(ctx.typertGateway.invoke({ namespace: 'session', method: 'prompt', args: direct, peer: ctx.connection.browserPeer })).rejects.toMatchObject(LOCAL.error)
  expect(await h.send('stale', 'do not dispatch', { expectedSelection: sessionTurnModels.ordinary })).toMatchObject(STALE)
  expect(await h.send('serialized', 'already processed', { serializedReferences: true })).toMatchObject(TEXT_ONLY)
  expect(await h.send('receipt', 'unused', { content: [{ type: 'file', receiptId: 'unknown' as never }] })).toMatchObject(TEXT_ONLY)
  expect(await h.send('image', 'unused', { content: [{ type: 'image', data: 'invalid', mediaType: 'image/png' }] })).toMatchObject(TEXT_ONLY)
  const start = agent.session.seq
  await expect(ctx.fileUploads.uploadStream({ sessionId: SESSION, data: {
    [Symbol.asyncIterator]() { throw new Error('Forbidden upload read its body') },
  } })).rejects.toMatchObject(TEXT_ONLY.error)
  const upload = await h.http.request('POST', `/api/session/uploadFileBinary?sessionId=${SESSION}&name=synthetic.txt`, {
    headers: { ...h.browser.headers, 'content-type': 'application/octet-stream' }, body: 'text file',
  })
  expect(JSON.parse(upload.body)).toMatchObject(TEXT_ONLY)
  expect(await rpc('fileUploads/upload', { agentId: SESSION, request: { data: 'c3ludGhldGlj', name: 'fixture.txt' } })).toMatchObject(TEXT_ONLY)
  await expect(stat(join(h.root, 'attachments', 'v1'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(agent.session.seq).toBe(start)
  expect(agent.inbox.hasPending).toBe(false)
  expect(h.calls).toEqual([])
  expect(h.row()).toBeUndefined()
  expect(await rpc('session/modelCatalog', { request: { audience: 'not-a-scope', sessionId: SESSION } })).toMatchObject({ ok: false })
})

it('retains confirmed text and fences an unconfirmed official outcome without falling back', async () => {
  const h = await setup({ failSecond: true })
  expect(await h.select(SELECTED)).toMatchObject({ ok: true })
  expect(await h.send('one', 'one')).toMatchObject(ACCEPTED)
  await h.agent.whenIdle()
  expect(await h.send('uncertain', 'possible official write')).toMatchObject(ACCEPTED)
  await h.agent.whenIdle()
  const events = await h.stored()
  expect(events.find(event => event.type === 'assistant/message' && event.data.turn === 2)).toMatchObject({
    data: { interrupted: true, message: { content: [{ type: 'text', text: 'partial ' }] } },
  })
  expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'TURN_OUTCOME_UNKNOWN' } } } })
  expect(h.row()).toMatchObject({ pending: { turn: 2 } })
  const cold = await setup({ replay: await h.capture() })
  expect(cold.agent.session).not.toBe(h.agent.session)
  const retry = { request: h.promptRequest('uncertain', 'possible official write') }
  const before = cold.agent.session.seq
  expect(await cold.rpc('session/prompt', retry)).toMatchObject(ACCEPTED)
  expect(await cold.http.rpc('session/prompt', retry, cold.operator)).toMatchObject(LOCAL)
  expect(cold.agent.session.seq).toBe(before)
  expect(await cold.send('must-not-send', 'Never retry this automatically')).toMatchObject({
    ok: false, error: { code: 'session/agent-busy', details: { reason: 'agy/outcome-unknown' } },
  })
  expect(h.calls.filter(call => call.method === 'session/prompt')).toHaveLength(2)
  expect(h.adapter.requests).toEqual([])
  expect(await cold.select(sessionTurnModels.next)).toMatchObject({ ok: true })
  expect(await cold.rpc('session/prompt', retry)).toMatchObject(ACCEPTED)
  expect(await cold.http.rpc('session/prompt', retry, cold.operator)).toMatchObject(LOCAL)
  expect(cold.calls).toEqual([])
  expect(cold.adapter.requests).toEqual([])
})

it('keeps cold queued input visible but rejects a new prompt before accepting it', async () => {
  const h = await setup()
  expect(await h.select(SELECTED)).toMatchObject({ ok: true })
  expect(await h.send('establish', 'open the official conversation')).toMatchObject(ACCEPTED)
  await h.agent.whenIdle()
  expect(await h.send('stop-this', 'this will be stopped')).toMatchObject(ACCEPTED)
  await h.secondDispatched
  expect(await h.send('old-queue', 'old message waiting')).toMatchObject(ACCEPTED)
  expect(await h.rpc('session/cancel', { request: { sessionId: SESSION } })).toMatchObject(ACCEPTED)
  await h.agent.whenIdle()
  const cold = await setup({ replay: await h.capture() })
  const resumed = cold.agent
  expect(resumed.session).not.toBe(h.agent.session)
  expect(cold.row()).toMatchObject({ pending: null, stopReason: 'cancelled' })
  expect(resumed.inbox.nextTurn).toHaveLength(1)
  const old = resumed.inbox.nextTurn[0]!
  const seq = resumed.session.seq
  expect(await cold.send('new-queue', 'keep this draft')).toMatchObject({
    ok: false, error: { code: 'session/agent-busy', details: { reason: 'LOCAL_TURN_QUEUE_NEEDS_AUTHORIZATION' } },
  })
  const edit = { request: { sessionId: SESSION, itemId: old.id, action: { kind: 'edit', content: [{ type: 'text', text: 'edited old message' }] } } }
  expect(await cold.rpc('session/updateQueue', edit)).toMatchObject({
    ok: false, error: { code: 'session/agent-busy', details: { reason: 'LOCAL_TURN_QUEUE_NEEDS_AUTHORIZATION' } },
  })
  expect(resumed.session.seq).toBe(seq)
  expect(resumed.inbox.nextTurn[0]).toBe(old)
  expect(cold.calls).toEqual([])
  const remove = { request: { sessionId: SESSION, itemId: old.id, action: { kind: 'remove' } } }
  expect(await cold.http.rpc('session/updateQueue', remove, cold.operator)).toMatchObject(LOCAL)
  expect(await cold.rpc('session/updateQueue', remove)).toMatchObject(ACCEPTED)
  expect(await cold.send('new-queue', 'keep this draft')).toMatchObject(ACCEPTED)
  await resumed.whenIdle()
  expect(cold.calls.filter(call => call.method === 'session/prompt')).toMatchObject([{ params: { prompt: [{ type: 'text', text: 'keep this draft' }] } }])
  expect(cold.row()).toMatchObject({ pending: null, stopReason: 'end_turn' })
})
