/** Test-only overlay for the built DSH Web profile. No external model or subprocess is started. */
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { AgyAcpClient } from './agy-acp-client.js';
import { mountAgyNativeTurnHost } from './agy-native-turn-host.js';
import { openAgyTurnLedger } from './agy-turn-ledger.js';
import { parseAgyTurnOptions } from './agy-turn-options.js';
import { createAgyTurnSession } from './agy-turn-session.js';

const officialId = 'web-fixture-official';
const model = { type: 'select', id: 'model', category: 'model', name: 'Model', currentValue: 'synthetic-web',
  options: [{ value: 'synthetic-web', name: 'Synthetic Antigravity' }] };
const effort = { type: 'select', id: 'effort', category: 'thought_level', name: 'Thinking', currentValue: 'low',
  options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] };

function syntheticChild(receive) {
  const child = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let closed = false;
  const send = (packet) => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...packet })}\n`);
  const exit = () => {
    if (closed) return;
    closed = true;
    child.emit('exit', 0, null);
    stdout.end();
    stderr.end();
  };
  const stdin = new Writable({
    write(bytes, _encoding, done) {
      try { receive(JSON.parse(bytes.toString('utf8')), send); done(); }
      catch (error) { done(error); }
    },
    final(done) { done(); queueMicrotask(exit); },
  });
  return Object.assign(child, { stdin, stdout, stderr, kill() { queueMicrotask(exit); return true; } });
}

export const name = 'antigravity-native-web-fixture';
export const inject = ['agentLoop', 'agents', 'appExit', 'appReady', 'connection', 'llm', 'sessionController',
  'sessionPersistence', 'sessions', 'storageDomain', 'webServer', 'workspaceRegistry', 'workingDirectory'];

/** Mount the real Antigravity adapter and prepare a disposable browser handoff. */
export async function apply(ctx, { root, workspace }) {
  if (ctx.webServer.host !== '127.0.0.1' || ctx.connection.allowsRemoteAuthorities || !process.env.DSH_HOME) {
    throw new Error('Synthetic fixture needs its isolated loopback Web profile');
  }
  const ledger = await openAgyTurnLedger(ctx.storageDomain);
  ctx.effect(() => ledger.close, 'synthetic ACP ledger');
  const trace = { acpPrompts: 0, cancellations: 0, ordinaryPrompts: 0, bound: 0, efforts: [], handoff: false };
  class OrdinaryFixture extends LlmAdapter {
    providerInfo(provider) { return { id: provider, name: 'Local test provider' }; }
    listModels(provider) { return Promise.resolve([{ provider, id: 'ordinary-web', name: 'Synthetic ordinary' }]); }
    async *stream() {
      const text = `Fixture ordinary answer ${++trace.ordinaryPrompts}`;
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['ordinary-fixture'], new OrdinaryFixture()), 'ordinary test model');
  mountAgyNativeTurnHost(ctx, {
    options: parseAgyTurnOptions([model, effort]), defaultEffort: 'low', ledger, includeDshHistory: true,
    makeSession({ cwd }) {
      if (cwd.toLowerCase() !== workspace.toLowerCase()) throw new Error('Fixture session changed workspace');
      return createAgyTurnSession({ cwd, timeLimits: { open: 5000, turn: 180000, cancel: 5000 },
        makeClient: hooks => new AgyAcpClient({ ...hooks, cwd, timeoutMs: 5000, env: {}, executable: join(cwd, 'never-launched-agy.exe'),
          spawnFactory: () => {
            let pending;
            let currentEffort = 'low';
            return syntheticChild((packet, send) => {
              const reply = result => send({ id: packet.id, result });
              const configOptions = () => [model, { ...effort, currentValue: currentEffort }];
              const text = text => send({ method: 'session/update', params: { sessionId: officialId,
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
              switch (packet.method) {
                case 'initialize': return reply({ protocolVersion: 1, agentInfo: { name: 'Antigravity ACP Server', version: 'fixture' },
                  agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } } });
                case 'session/new': ++trace.bound; return reply({ sessionId: officialId, configOptions: configOptions() });
                case 'session/load': return reply({ sessionId: officialId, configOptions: configOptions() });
                case 'session/set_config_option':
                  if (packet.params.configId !== effort.id) throw new Error('Unexpected option');
                  currentEffort = packet.params.value;
                  trace.efforts.push(currentEffort);
                  return reply({ configOptions: configOptions() });
                case 'session/prompt': {
                  if (packet.params.sessionId !== officialId || pending !== undefined) throw new Error('Invalid fixture prompt order');
                  const blocks = packet.params.prompt;
                  const request = blocks.at(-1)?.text;
                  ++trace.acpPrompts;
                  if (request === 'Hold the synthetic turn') {
                    trace.handoff = blocks.slice(0, -1).some(block => block.text?.includes('Fixture ordinary answer 2'));
                    text('Fixture partial before Stop');
                    pending = packet.id;
                    return;
                  }
                  if (request !== 'Send via native Antigravity') throw new Error('Unexpected text entered the fixture ACP');
                  text('Fixture answer aldertrail');
                  return reply({ stopReason: 'end_turn' });
                }
                case 'session/cancel':
                  if (packet.params.sessionId !== officialId || pending === undefined) throw new Error('Stop lost its fixture turn');
                  ++trace.cancellations;
                  send({ id: pending, result: { stopReason: 'cancelled' } });
                  pending = undefined;
                  return;
                case 'session/close': return reply({});
                default: throw new Error(`Unexpected fixture RPC: ${packet.method}`);
              }
            });
          },
        }),
      });
    },
  });
  await ctx.workspaceRegistry.create(workspace);
  const body = readFileSync(join(root, 'browser-template.js'), 'utf8');
  const stop = join(root, 'stop');
  const timer = setInterval(() => {
    if (existsSync(stop)) ctx.appExit(0);
  }, 150);
  ctx.effect(() => () => clearInterval(timer), 'bounded Web fixture stop signal');
  const disposeReady = ctx.appReady.onReady(() => {
    const base = `http://127.0.0.1:${ctx.webServer.port}`;
    const url = ctx.connection.authenticatedUrl(base);
    // The launch URL stays in the disposable Playwright program. It is never logged.
    const controlPath = '/__agy_native_fixture_state';
    const clientRoute = ctx.webServer.register({ kind: 'exact', path: controlPath, handler(req, res) {
      if (req.method !== 'GET' || req.socket.remoteAddress !== '127.0.0.1' || req.headers.host !== new URL(base).host
        || ctx.connection.requestRejection(req) !== undefined) {
        res.writeHead(404).end();
        return;
      }
      const agent = ctx.agents.list().find(item => item.session.header.cwd.toLowerCase() === workspace.toLowerCase());
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ...trace, agent: agent === undefined ? null : { id: agent.id, status: agent.status,
        running: agent.activeTurnProvider ?? null, queue: agent.inbox.nextTurn.length },
        pinned: ctx.workspaceRegistry.pinnedSessionIds, archived: ctx.workspaceRegistry.archivedSessionIds,
        members: ctx.workspaceRegistry.list().flatMap(item => item.sessionIds) }));
    } });
    ctx.effect(() => clientRoute, 'test observation route (synthetic state only)');
    writeFileSync(join(root, 'browser-run.js'), body.replace('/* HANDOFF */ null', JSON.stringify({ base, url, controlPath })), { flag: 'wx' });
    writeFileSync(join(root, 'ready'), `${base}\n`, { flag: 'wx' });
  });
  ctx.effect(() => disposeReady, 'Web fixture handoff');
}
