// Opt-in integration probe. Official agy *only* talks to an owned loopback
// model stub; no live profile, cloud inference, tools, credentials or login.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { AgyAcpClient } from '../lib/agy-acp-client.js';
import { agyWindowsEnv, discoverAgyExecutable } from '../lib/agy-launch.js';
import { createLocalAgy } from '../lib/agy-local-runtime.js';

await import('./runtime-hook.mjs');
const [{ agyMcpDeclarations, agyMcpTools, openAgyMcp }, { Context }, { ToolsService, projectToolSchema }, { SystemPrompt }] = await Promise.all([
  import('../lib/agy-local-mcp.js'), import('@deepseek-ai/cordis'), import('@deepseek-ai/dsh-tools'), import('@deepseek-ai/dsh-system-prompt'),
]);

const executable = await discoverAgyExecutable(process.argv.slice(2).find(arg => arg !== '--debug'));
const root = await mkdtemp(join(tmpdir(), 'dsh-agy-mcp-probe-'));
const cwd = join(root, 'workspace');
const ctx = new Context();
const system = ctx.plugin(SystemPrompt, {});
const fiber = ctx.plugin(ToolsService);
const browser = 'mcp__playwright__browser_snapshot';
const executed = [];
let permitBrowser = true;
let permitImage = true;
let simulate;
const makeTool = (name, description) => ({ name, description,
  parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  async execute(args) { executed.push([name, args.value]); return `synthetic-${name}:${args.value}`; },
});
const ordinary = Array.from({ length: 74 }, (_, i) => makeTool(`mcp__fixture__tool_${i}`, `Synthetic tool ${i}: ${'a'.repeat(300 + i * 30)}`));
const core = ['image_generate', 'subagent', 'ask_user_question'].map(name => makeTool(name, `Synthetic ${name}`));
const playwright = makeTool(browser, 'Synthetic Playwright accessibility snapshot tool');
// Put large schemas on formerly missing core names in the unfixed catalog;
// the fixed declarations keep the real-core-sized forms. No dependence on a
// specific vendor threshold, only enough unrelated tools to trigger the bug.
const before = [...ordinary, ...core.map(tool => ({ ...tool, description: 'Synthetic ' + 'a'.repeat(2600) })), playwright]
  .map(tool => { const { name, description, parameters: inputSchema } = projectToolSchema(tool, false); return { name, description, inputSchema }; });
const later = [];
const responseFor = (res, parts, finishReason = 'STOP') => res.writeHead(200, { 'content-type': 'text/event-stream' })
  .end(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason }] })}\n\n`);
const server = createServer(async (req, res) => {
  const json = (status, data) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
  if (!req.url.startsWith('/')) return json(403, {}); // HTTP proxy requests are never forwarded.
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
    if (req.url === '/legacy') {
      if (input.id === undefined) return res.writeHead(202).end();
      const result = input.method === 'initialize'
        ? { protocolVersion: input.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'synthetic', version: '0' } }
        : input.method === 'tools/list' ? { tools: before } : {};
      return json(200, { jsonrpc: '2.0', id: input.id, result });
    }
    if (!req.url.startsWith('/v1beta/models/') || !req.url.includes(':streamGenerateContent')) return json(404, {});
    const declarations = (input.tools ?? []).flatMap(tool => tool.functionDeclarations ?? []);
    if (!declarations.length) return responseFor(res, [{ text: 'Synthetic probe title' }]);
    // Only retain the outbound declaration names and responses from our
    // synthetic calls, not arbitrary system text or HTTP headers.
    const names = declarations.map(tool => tool.name);
    const functions = (input.contents ?? []).flatMap(content => content.parts ?? []).flatMap(part => part.functionResponse ? [part.functionResponse] : []);
    const iteration = later.filter(row => row.mode === simulate.mode).length;
    let next;
    if (simulate.mode === 'fallback' && iteration === 0) next = { name: 'mcp_dsh_tool_catalog', args: { name: browser } };
    if (simulate.mode === 'fallback' && iteration === 1) next = { name: 'mcp_dsh_tool_call', args: { name: browser, arguments_json: '{"value":"from ACP"}' } };
    if (simulate.mode === 'reloaded' && iteration === 0) next = { name: 'mcp_dsh_tool_catalog', args: { search: 'Playwright' } };
    if (simulate.mode === 'direct' && iteration === 0) next = { name: 'mcp_dsh_image_generate', args: { value: 'direct ACP' } };
    later.push({ names, functions, mode: simulate.mode });
    if (!next || !names.includes(next.name)) return responseFor(res, [{ text: 'Synthetic model completed' }]);
    const declaration = declarations.find(tool => tool.name === next.name);
    if ((declaration.parametersJsonSchema ?? declaration.parameters)?.properties?.toolSummary) next.args.toolSummary = 'Synthetic loopback probe';
    return responseFor(res, [{ functionCall: next, thoughtSignature: 'dGVzdA==' }]);
  } catch (error) {
    simulate.error ??= error;
    if (!res.headersSent) json(500, {}); else res.end();
  }
});
server.on('connect', (_req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
const controller = new AbortController();
let runtime, bridge;
try {
  await mkdir(cwd);
  await system.await();
  await fiber.await();
  for (const tool of ordinary) ctx.tools.register(tool);
  ctx.tools.register(core[0], { when: () => permitImage });
  for (const tool of core.slice(1)) ctx.tools.register(tool);
  ctx.tools.register(playwright, { when: () => permitBrowser });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const isolated = env => ({ ...env, GOOGLE_GEMINI_BASE_URL: base, GEMINI_API_KEY: 'not-a-real-key', AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
    HTTP_PROXY: base, HTTPS_PROXY: base, ALL_PROXY: base, NO_PROXY: 'localhost,127.0.0.1,::1' });
  const configure = async (env, useRuntimeSettings = false) => {
    const settings = join(env.HOME, '.gemini', 'antigravity-cli');
    const file = join(settings, 'settings.json');
    await mkdir(settings, { recursive: true });
    const runtimeSettings = useRuntimeSettings ? JSON.parse(await readFile(file, 'utf8')) : { useG1Credits: false };
    await writeFile(file, JSON.stringify({ ...runtimeSettings, modelProvider: 'gemini' }));
    return settings;
  };
  const legacyAreas = Object.fromEntries(['home', 'local', 'roaming', 'scratch'].map(k => [k, join(root, 'legacy', k)]));
  await Promise.all(Object.values(legacyAreas).map(dir => mkdir(dir, { recursive: true })));
  const legacyEnv = isolated(agyWindowsEnv(legacyAreas));
  const settings = await configure(legacyEnv);
  const authDenied = () => ({ outcome: { outcome: 'cancelled' } });
  let unexpectedApprovals = 0;
  const declineUnexpected = () => { unexpectedApprovals++; return authDenied(); };
  const legacy = new AgyAcpClient({ executable, cwd, env: legacyEnv, timeoutMs: 20_000, allowMcpServers: true, onPermission: authDenied });
  let version, baseline;
  try {
    simulate = { mode: 'legacy' };
    version = (await legacy.start()).agentInfo.version;
    const { sessionId } = await legacy.request('session/new', { cwd, mcpServers: [{ name: 'dsh', type: 'http', url: `${base}/legacy`, headers: [] }] });
    assert.equal((await legacy.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Synthetic legacy ACP probe' }] })).stopReason, 'end_turn');
    baseline = later.find(row => row.mode === 'legacy').names;
  } finally { await legacy.close(); }
  const cached = (await readdir(join(settings, 'mcp', 'dsh'))).filter(name => name.endsWith('.json')).length;
  assert.equal(cached, before.length);
  const legacyCount = baseline.filter(name => name.startsWith('mcp_dsh_')).length;
  console.log(`agy ${version}: old discovery cached ${cached} schemas, declared ${legacyCount}, native lazy resolver: ${baseline.includes('call_mcp_tool')}`);
  if (legacyCount < before.length && !baseline.includes('call_mcp_tool')) {
    assert.ok(core.some(tool => !baseline.includes(`mcp_dsh_${tool.name}`)), 'baseline lost one or more important tools');
  }

  // Only the probe replaces the credential configuration (in its own newly
  // allocated home) and redirects the CLI to a synthetic endpoint.
  runtime = createLocalAgy({ executable, dataDir: join(root, 'fixed'), agentsFile: '', proxy: 'direct' }, {
    parentEnv: { SystemRoot: process.env.SystemRoot, DSH_HOME: join(root, 'dsh-home') },
    makeTransport(opts) {
      const env = isolated(opts.env);
      const transport = new AgyAcpClient({ ...opts, env });
      return { async start() { await configure(env, true); return transport.start(); },
        request: (...args) => transport.request(...args), notify: (...args) => transport.notify(...args), close: () => transport.close() };
    },
  });
  const modelSelection = { provider: 'antigravity', model: 'synthetic' };
  async function turns(officialId, modes) {
    const toolSet = await ctx.tools.resolve({ modelSelection, signal: controller.signal });
    const tools = agyMcpTools(ctx, undefined, toolSet, ['*'], true);
    bridge = await openAgyMcp(ctx, { declarations: agyMcpDeclarations(tools) });
    let session;
    try {
      session = await runtime.open(controller.signal, { id: 'same-local-session', cwd, mode: 'full', officialId,
        mcpServers: bridge.servers, nativeSubagents: true, nativeQuestions: true, onPermission: declineUnexpected });
      let wireOpen = false;
      const mcpTurn = { tools, toolSet, signal: controller.signal, canCall: () => wireOpen };
      const cards = [];
      for (const mode of modes) {
        simulate = { mode };
        const beforeTurn = later.length;
        bridge.setTurn(mcpTurn);
        await session.prepare({ model: session.options.model.currentValue }, controller.signal);
        const result = await session.runTurn([{ type: 'text', text: `Synthetic ${mode} probe` }], { signal: controller.signal,
          onDelta() {}, onDispatch() { wireOpen = true; }, onTerminal() { wireOpen = false; bridge.clearTurn(mcpTurn); },
          onTool(update) { cards.push(update); } });
        if (simulate.error) throw simulate.error;
        assert.equal(result.stopReason, 'end_turn');
        const requests = later.slice(beforeTurn);
        const names = requests[0].names.filter(name => name.startsWith('mcp_dsh_'));
        console.log(`${mode}: ${names.length} model declarations (${names.join(', ')}), ${requests.length} model requests`);
        assert.ok(['tool_call', 'tool_catalog', 'subagent', 'ask_user_question'].every(name => names.includes(`mcp_dsh_${name}`)));
        assert.equal(names.includes('mcp_dsh_image_generate'), permitImage);
        if (mode === 'direct') assert.match(JSON.stringify(requests.at(-1).functions), /direct ACP/);
        if (mode === 'fallback') {
          assert.match(JSON.stringify(requests.at(-1).functions), /accessibility snapshot/);
          assert.match(JSON.stringify(requests.at(-1).functions), /from ACP/);
          assert.ok(cards.some(card => card.title === `Run mcp_dsh_${browser}`), 'ACP carries the original fallback name for the native tool card');
        }
        if (mode === 'reloaded') assert.match(JSON.stringify(requests.at(-1).functions), /"tools":\[\]|\\"tools\\":\[\]/);
      }
      if (officialId) assert.equal(session.id, officialId);
      return session.id;
    } finally { toolSet?.dispose(); await session?.close(); await bridge.close(); bridge = undefined; }
  }
  const id = await turns(undefined, ['direct', 'fallback']);
  permitBrowser = permitImage = false;
  await turns(id, ['reloaded']);
  assert.equal(unexpectedApprovals, 0, 'full mode requires no probe-specific permission grant');
  assert.deepEqual(executed, [['image_generate', 'direct ACP'], [browser, 'from ACP']]);
  console.log('Official ACP confirmed direct and on-demand DSH execution, same-session reuse, and refreshed discovery after session/load.');
} finally {
  controller.abort();
  await runtime?.dispose();
  await bridge?.close();
  await fiber.dispose();
  await system.dispose();
  server.closeAllConnections();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  // CLI timers may still be releasing a temp file just after child shutdown.
  for (let i = 0; ; i++) {
    try { await rm(root, { recursive: true, force: true }); break; }
    catch (error) { if (i === 3) throw error; await delay(40); }
  }
}
