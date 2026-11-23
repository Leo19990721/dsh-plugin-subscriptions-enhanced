import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { projectToolSchema } from '@deepseek-ai/dsh-tools';
import { executeToolBatch, ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline';

const serverPrefix = name => name === 'remote' ? ['remote_', 'mcp__remote__'] : [`mcp__${name}__`];
const nativeSubagentTools = new Set(['subagent', 'send_message', 'list_agents', 'wait_agent', 'list_subagent_models']);
const imageGenerateTools = new Set(['image_generate', 'dsh_subscriptions_image_generate']);
const nativeUtilityTools = new Set([
  'todo_write', 'ask_user_question', 'present',
  'office_render', 'office_convert', 'office_recalculate',
  'session_search', 'session_event_search', 'session_trace', 'session_event_trace', 'session_event_read',
  'schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit',
]);
const subscriptionBridgeTools = new Set([
  'image_generate', 'dsh_subscriptions_image_generate',
  'video_generate', 'dsh_subscriptions_video_generate',
  'x_search', 'dsh_subscriptions_x_search',
]);
const MCP_VERSION = '2025-11-25';
const SUPPORTED_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18', MCP_VERSION]);
const objectValue = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export async function mcpToolResult(ctx, name, result, signal) {
  const content = [];
  for (const block of result.content) {
    if (block.type === 'text' || block.type === 'reasoning') content.push({ type: 'text', text: block.text });
    else if (block.type === 'image') {
      try {
        const image = await ctx.get('attachments').readImage(block.attachment, signal);
        content.push({ type: 'image', mimeType: image.ref.mediaType, data: Buffer.from(image.data).toString('base64') });
      } catch { content.push({ type: 'text', text: 'DSH tool image unavailable.' }); }
    } else {
      // The host ContentBlock union can widen. Keep opaque data inert, rather
      // than discarding it or treating a DSH attachment ID as an external URL.
      content.push({ type: 'text', text: JSON.stringify(block) });
    }
  }
  // Only the requested native tools have reviewed public output contracts;
  // others may keep private execution-only data in value/meta. Forward a
  // wrapped MCP tool's explicitly public structured output, never its meta.
  const structured = nativeUtilityTools.has(name) ? result.value : name.startsWith('mcp__') ? result.value?.structuredContent : undefined;
  const structuredContent = objectValue(structured) ? structured : structured === undefined ? undefined : { value: structured };
  return { content, isError: result.isError === true, ...(!result.isError && structuredContent !== undefined ? { structuredContent } : {}) };
}

// Expose the existing DSH registrations (and their live scope/guards), not a copy
// of their commands, credentials, Chrome profile, or endpoint configuration.
export function agyMcpTools(ctx, agent, toolSet, servers, allowSubagents = false) {
  const prefixes = servers === undefined || servers.includes('*') ? undefined : servers.flatMap(serverPrefix);
  if (typeof ctx.tools?.definitions !== 'function' || typeof ctx.tools.executable !== 'function') return new Map();
  const defs = ctx.tools.definitions(agent, toolSet).filter(tool => ctx.tools.executable(tool.name, agent, toolSet) === tool);
  const hasImageGen = prefixes === undefined && defs.some(({ name }) => imageGenerateTools.has(name));
  return new Map(defs.filter(({ name }) => (allowSubagents && nativeSubagentTools.has(name)) || (prefixes
    ? prefixes.some(prefix => name.startsWith(prefix))
    : name.startsWith('mcp__') || name.startsWith('remote_') || nativeUtilityTools.has(name)
      || subscriptionBridgeTools.has(name) || (hasImageGen && name === 'read_image')))
    .map(tool => [tool.name, tool]));
}

/** Private, per-open ACP MCP capability. Without an active turn, nothing may execute. */
export async function openAgyMcp(ctx, { waitMs = 5000 } = {}) {
  const token = randomUUID();
  let pipeline;
  const getPipeline = () => (pipeline ??= new ToolExecutionPipeline(ctx));
  let active, wave;
  const inFlight = new Map(), waiters = new Set();
  const count = (origin, delta) => {
    const total = (inFlight.get(origin) ?? 0) + delta;
    if (total) inFlight.set(origin, total); else inFlight.delete(origin);
    if (origin === wave) origin.mcpCount(total);
    else if (origin === active && !wave) origin.onMcpCount?.(total);
  };
  const listedTools = turn => [...(turn?.tools?.values() ?? [])].filter(tool =>
    ctx.tools?.executable(tool.name, turn.agent, turn.toolSet) === tool);
  const release = turn => { for (const resolve of waiters) resolve(turn); };
  function forgetWave() {
    if (!wave) return;
    wave.signal.removeEventListener('abort', forgetWave);
    if (active?.wave === wave) active = undefined;
    release(undefined);
    wave = undefined;
  }
  function waitForTurn(res) {
    return new Promise(resolve => {
      const done = value => { clearTimeout(timer); waiters.delete(done); res.off('close', disconnected); resolve(value); };
      const disconnected = () => done();
      const timer = setTimeout(disconnected, waitMs);
      waiters.add(done); res.once('close', disconnected);
    });
  }
  const server = createServer(async (req, res) => {
    const end = (status, body) => {
      if (body === undefined) res.writeHead(status).end();
      else res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };
    if (req.url !== '/mcp' || req.headers.authorization !== `Bearer ${token}`) return end(403);
    if (req.method !== 'POST') return end(405);
    // Pin the originating lease before reading the async body. A slow request
    // from an idle/retired generation must not borrow a later turn's tools.
    const origin = wave ?? active;
    let rpc;
    try {
      const parts = [];
      let bytes = 0;
      for await (const part of req) {
        if ((bytes += part.length) > 1024 * 1024) return end(413);
        parts.push(part);
      }
      rpc = JSON.parse(Buffer.concat(parts));
    } catch { return end(400); }
    if (rpc?.jsonrpc !== '2.0' || typeof rpc.method !== 'string') return end(400);
    if (rpc.id === undefined) return end(202);
    const reply = result => end(200, { jsonrpc: '2.0', id: rpc.id, result });
    const fail = (code, message) => end(200, { jsonrpc: '2.0', id: rpc.id, error: { code, message } });
    if (rpc.method === 'initialize') return reply({ protocolVersion: SUPPORTED_VERSIONS.has(rpc.params?.protocolVersion)
      ? rpc.params.protocolVersion : MCP_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'dsh-tools', version: '1' } });
    if (rpc.method === 'ping') return reply({});
    let counted = false;
    try {
      if (rpc.method === 'tools/list') {
        const listed = listedTools(active).map(tool => {
          const { name, description, parameters: inputSchema } = projectToolSchema(tool, false);
          return { name, description, inputSchema };
        });
        return reply({ tools: listed });
      }
      if (rpc.method !== 'tools/call') return fail(-32601, 'Method not found');
      if (!origin || origin !== (wave ?? active)) return fail(-32602, 'Tool unavailable in this DSH turn');
      // Only a signed, live wave opens this bounded wait. Never let an idle
      // HTTP call hitch a ride on a future ordinary prompt or another wave.
      if (origin === wave) { count(origin, 1); counted = true; }
      const turn = active ?? (wave && await waitForTurn(res));
      const { name, arguments: args = {} } = rpc.params ?? {};
      if (res.destroyed || origin !== (wave ?? active) || !turn || turn !== active || turn.signal.aborted || !turn.canCall()) return fail(-32602, 'Tool unavailable in this DSH turn');
      const disconnect = new AbortController();
      res.on('close', () => disconnect.abort());
      const callSignal = AbortSignal.any([turn.signal, disconnect.signal]);

      if (!turn.tools?.has(name)
        || ctx.tools?.executable(name, turn.agent, turn.toolSet) !== turn.tools.get(name)) return fail(-32602, 'Tool unavailable in this DSH turn');
      if (!counted) { count(origin, 1); counted = true; }
      const { results } = await executeToolBatch({ agent: turn.agent, signal: callSignal,
        calls: [{ type: 'tool-call', id: randomUUID(), name, arguments: JSON.stringify(args) }], toolSet: turn.toolSet,
      }, getPipeline(), () => 1);
      const result = results[0]?.result;
      if (!result) return fail(-32603, 'DSH tool did not settle');
      return reply(await mcpToolResult(ctx, name, result, callSignal));
    } catch { return fail(-32603, 'DSH tool execution failed'); }
    finally { if (counted) count(origin, -1); }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  server.unref();
  return {
    servers: [{ type: 'http', name: 'dsh', url: `http://127.0.0.1:${server.address().port}/mcp`,
      headers: [{ name: 'Authorization', value: `Bearer ${token}` }] }],
    beginWave(value) {
      forgetWave(); active = undefined; wave = value;
      wave.mcpCount(inFlight.get(wave) ?? 0);
      wave.signal.addEventListener('abort', forgetWave, { once: true });
    },
    get inFlight() { return inFlight.get(wave ?? active) ?? 0; },
    clearTurn(value) { if (active === value) active = undefined; },
    setTurn(value) {
      if (value && wave && value.wave !== wave) return;
      active = value;
      if (value) release(value);
    },
    async close() {
      forgetWave(); active = undefined;
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    },
  };
}
