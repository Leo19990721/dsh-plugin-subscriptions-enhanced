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
const CATALOG_TOOL = 'tool_catalog';
const CALL_TOOL = 'tool_call';
const CATALOG_PAGE = 16;
// Keep the direct surface deliberately small; everything else is still available
// using its full, unmodified schema through the catalog. Native panels and the
// native subagent control path keep their existing names.
const directNativeTools = new Set(['ask_user_question', 'todo_write', 'present', 'read_image']);
const directTool = name => nativeSubagentTools.has(name) || imageGenerateTools.has(name) || directNativeTools.has(name);
const gatewayName = name => name === CATALOG_TOOL || name === CALL_TOOL;
const eager = { 'antigravity/alwaysLoad': true };
const wireTool = tool => {
  const { name, description, parameters: inputSchema } = projectToolSchema(tool, false);
  return { name, description, inputSchema };
};
const gatewayTool = (name, description, properties, required = []) => ({
  name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, _meta: eager,
});
const gatewayTools = [
  gatewayTool(CATALOG_TOOL, 'Find available DeepSeek Harness tools (including Playwright, image generation and subagents). '
    + 'Use name for the exact original input schema, or search for a capability and use nextOffset to continue.', {
    name: { type: 'string', description: 'Exact DSH tool name for its full input schema' },
    search: { type: 'string', description: 'Case-insensitive text in tool names or descriptions' },
    offset: { type: 'integer', description: 'Next offset from a previous search; omit on the first page' },
  }),
  gatewayTool(CALL_TOOL, 'Run one exact DSH tool. Get its input schema with mcp_dsh_tool_catalog first if needed. '
    + 'Uses the current DSH turn’s permissions and approvals.', {
    name: { type: 'string', description: 'Exact DSH tool name from the catalog (not an MCP function alias)' },
    arguments_json: { type: 'string', description: 'JSON-encoded arguments object; use {} for a tool without arguments' },
  }, ['name', 'arguments_json']),
];

/** The CLI may cache declarations on open; re-open if a direct schema changes. */
export const agyMcpDeclarations = tools => [...tools.values()].filter(tool => directTool(tool.name))
  .sort((a, b) => a.name < b.name ? -1 : a.name === b.name ? 0 : 1)
  .map(tool => ({ ...wireTool(tool), _meta: eager }));

function catalogResponse(tools, args) {
  if (!objectValue(args)) return;
  if (Object.hasOwn(args, 'name')) {
    const tool = typeof args.name === 'string' && tools.find(tool => tool.name === args.name);
    return tool ? wireTool(tool) : undefined;
  }
  const { search = '', offset = 0 } = args;
  if (typeof search !== 'string' || !Number.isSafeInteger(offset) || offset < 0) return;
  const query = search.trim().toLowerCase();
  const matches = tools.filter(tool => tool.name.toLowerCase().includes(query) || tool.description?.toLowerCase().includes(query))
    .sort((a, b) => a.name < b.name ? -1 : a.name === b.name ? 0 : 1);
  const page = matches.slice(offset, offset + CATALOG_PAGE).map(({ name, description }) => ({
    name, description: description?.replace(/\s+/gu, ' ').slice(0, 160),
    ...(directTool(name) ? { direct: `mcp_dsh_${name}` } : {}),
  }));
  return { tools: page, ...(offset + CATALOG_PAGE < matches.length ? { nextOffset: offset + CATALOG_PAGE } : {}) };
}

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
  const defs = ctx.tools.definitions(agent, toolSet).filter(tool => !gatewayName(tool.name) && ctx.tools.executable(tool.name, agent, toolSet) === tool);
  const hasImageGen = prefixes === undefined && defs.some(({ name }) => imageGenerateTools.has(name));
  return new Map(defs.filter(({ name }) => (allowSubagents && nativeSubagentTools.has(name)) || (prefixes
    ? prefixes.some(prefix => name.startsWith(prefix))
    : name.startsWith('mcp__') || name.startsWith('remote_') || nativeUtilityTools.has(name)
      || subscriptionBridgeTools.has(name) || (hasImageGen && name === 'read_image')))
    .map(tool => [tool.name, tool]));
}

/** Private, per-open ACP MCP capability. Without an active turn, nothing may execute. */
export async function openAgyMcp(ctx, { waitMs = 5000, declarations = [] } = {}) {
  // Publish a schema-only snapshot, even when the CLI refreshes while idle.
  // Never let a transiently removed registration poison its declaration cache;
  // the separate request lease still rechecks every lookup and execution.
  const declarationPayload = JSON.stringify([...gatewayTools, ...declarations]);
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
        // ACP can eagerly load all supplied declarations and silently truncate
        // them. Expose a fixed discovery surface; only core tools use direct
        // declarations. The entire exact DSH set remains available on demand.
        return reply({ tools: JSON.parse(declarationPayload) });
      }
      if (rpc.method !== 'tools/call') return fail(-32601, 'Method not found');
      if (!origin || origin !== (wave ?? active)) return fail(-32602, 'Tool unavailable in this DSH turn');
      // Only a signed, live wave opens this bounded wait. Never let an idle
      // HTTP call hitch a ride on a future ordinary prompt or another wave.
      if (origin === wave) { count(origin, 1); counted = true; }
      const turn = active ?? (wave && await waitForTurn(res));
      let { name, arguments: args = {} } = rpc.params ?? {};
      if (res.destroyed || origin !== (wave ?? active) || !turn || turn !== active || turn.signal.aborted || !turn.canCall()) return fail(-32602, 'Tool unavailable in this DSH turn');
      if (name === CATALOG_TOOL) {
        const found = catalogResponse(listedTools(turn), args);
        return found ? reply({ content: [{ type: 'text', text: JSON.stringify(found) }], isError: false })
          : fail(-32602, 'Invalid discovery request or tool unavailable in this DSH turn');
      }
      if (name === CALL_TOOL) {
        if (!objectValue(args) || typeof args.name !== 'string' || typeof args.arguments_json !== 'string') return fail(-32602, 'Expected a tool name and JSON arguments object');
        name = args.name;
        if (gatewayName(name)) return fail(-32602, 'Tool unavailable in this DSH turn');
        try { args = JSON.parse(args.arguments_json); } catch { return fail(-32602, 'Invalid JSON arguments'); }
        if (!objectValue(args)) return fail(-32602, 'Expected a JSON arguments object');
      } else if (!directTool(name)) return fail(-32602, 'Use the DSH tool catalog and exact-name invocation');
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
