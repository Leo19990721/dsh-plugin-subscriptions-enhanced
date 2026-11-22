import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { projectToolSchema } from '@deepseek-ai/dsh-tools';
import { executeToolBatch, ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline';

const serverPrefix = name => name === 'remote' ? ['remote_', 'mcp__remote__'] : [`mcp__${name}__`];
const nativeSubagentTools = new Set(['subagent', 'send_message', 'list_agents', 'wait_agent', 'list_subagent_models']);
const imageGenerateTools = new Set(['image_generate', 'dsh_subscriptions_image_generate']);
const subscriptionBridgeTools = new Set([
  'image_generate', 'dsh_subscriptions_image_generate',
  'video_generate', 'dsh_subscriptions_video_generate',
  'x_search', 'dsh_subscriptions_x_search',
]);
const MCP_VERSION = '2025-11-25';
const SUPPORTED_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18', MCP_VERSION]);

// Expose the existing DSH registrations (and their live scope/guards), not a copy
// of their commands, credentials, Chrome profile, or endpoint configuration.
export function agyMcpTools(ctx, agent, toolSet, servers, allowSubagents = false) {
  const prefixes = servers === undefined || servers.includes('*') ? undefined : servers.flatMap(serverPrefix);
  if (!ctx.tools) return new Map();
  const defs = ctx.tools.definitions(agent, toolSet);
  const hasImageGen = prefixes === undefined && defs.some(({ name }) => imageGenerateTools.has(name));
  return new Map(defs.filter(({ name }) => (allowSubagents && nativeSubagentTools.has(name)) || (prefixes
    ? prefixes.some(prefix => name.startsWith(prefix))
    : name.startsWith('mcp__') || name.startsWith('remote_') || subscriptionBridgeTools.has(name) || (hasImageGen && name === 'read_image')))
    .map(tool => [tool.name, tool]));
}

/** Private, per-open ACP MCP capability. Without an active turn, nothing may execute. */
export async function openAgyMcp(ctx) {
  const token = randomUUID();
  let pipeline;
  const getPipeline = () => (pipeline ??= new ToolExecutionPipeline(ctx));
  let active;
  const server = createServer(async (req, res) => {
    const end = (status, body) => {
      if (body === undefined) res.writeHead(status).end();
      else res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };
    if (req.url !== '/mcp' || req.headers.authorization !== `Bearer ${token}`) return end(403);
    if (req.method !== 'POST') return end(405);
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
    try {
      if (rpc.method === 'tools/list') {
        const listed = [
          ...[...(active?.tools?.values() ?? [])].map(tool => {
            const { name, description, parameters: inputSchema } = projectToolSchema(tool, false);
            return { name, description, inputSchema };
          }),
        ];
        return reply({ tools: listed });
      }
      if (rpc.method !== 'tools/call') return fail(-32601, 'Method not found');
      const turn = active;
      const { name, arguments: args = {} } = rpc.params ?? {};
      if (!turn || turn.signal.aborted || !turn.canCall()) return fail(-32602, 'Tool unavailable in this DSH turn');
      const disconnect = new AbortController();
      res.on('close', () => disconnect.abort());
      const callSignal = AbortSignal.any([turn.signal, disconnect.signal]);

      if (!turn.tools?.has(name)
        || ctx.tools?.executable(name, turn.agent, turn.toolSet) !== turn.tools.get(name)) return fail(-32602, 'Tool unavailable in this DSH turn');
      const { results } = await executeToolBatch({ agent: turn.agent, signal: callSignal,
        calls: [{ type: 'tool-call', id: randomUUID(), name, arguments: JSON.stringify(args) }], toolSet: turn.toolSet,
      }, getPipeline(), () => 1);
      const result = results[0]?.result;
      if (!result) return fail(-32603, 'DSH tool did not settle');
      const content = [];
      for (const block of result.content) {
        if (block.type === 'text') content.push({ type: 'text', text: block.text });
        if (block.type === 'image' && ctx.get('attachments')) {
          try {
            const image = await ctx.get('attachments').readImage(block.attachment, turn.signal);
            content.push({ type: 'image', mimeType: image.ref.mediaType, data: Buffer.from(image.data).toString('base64') });
          } catch { content.push({ type: 'text', text: 'DSH tool image unavailable.' }); }
        }
      }
      return reply({ content, isError: result.isError === true });
    } catch { return fail(-32603, 'DSH tool execution failed'); }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  server.unref();
  return {
    servers: [{ type: 'http', name: 'dsh', url: `http://127.0.0.1:${server.address().port}/mcp`,
      headers: [{ name: 'Authorization', value: `Bearer ${token}` }] }],
    setTurn: value => { active = value; },
    async close() {
      active = undefined;
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    },
  };
}
