import assert from 'node:assert/strict';
import test from 'node:test';
import { agyProgress } from '../src/agy-local-progress.js';
import { AGY_TOOL_CARD, AGY_TOOL_RECORD, agyToolSize, decodeAgyTool, summarizeAgyTool } from '../src/agy-local-tool-data.js';
import { agyToolDefinition, createAgyToolCard, registerAgyToolCards } from '../src/agy-tool-cards-client.js';

const call = (id, fields) => ({ kind: 'tool', value: { toolCallId: id, ...fields } });
const tree = { createElement: (tag, props, ...children) => ({ tag, props, children }) };
const row = (id, value, seq = 3) => ({ type: AGY_TOOL_RECORD, ignorable: true, seq, time: 50, data: { version: 1, id, ...value } });

test('ACP tool projection selects known fields and enforces encoded byte limits', () => {
  const text = '\u202e<script>test</script>\r\n' + '😀'.repeat(10_000);
  const preview = summarizeAgyTool({ toolCallId: 'x', kind: 'execute', title: '\x00Run job',
    locations: [{ path: 'a.txt', line: 4 }, { path: 'b.txt' }], rawInput: { CommandLine: 'echo hello', secret: 'do not serialize' },
    content: [{ type: 'content', content: { type: 'text', text } }, { type: 'diff', path: 'a.txt', oldText: 'first\n', newText: 'one\ntwo\n' },
      { type: 'content', content: { type: 'image', data: 'do not serialize' } }] });
  assert.equal(preview.category, 'command');
  assert.equal(preview.title, 'Run job');
  assert.deepEqual(preview.paths, ['a.txt:5', 'b.txt']);
  assert.equal(preview.target, 'echo hello');
  assert.match(preview.output, /^<script>test<\/script>\n.*…$/s);
  assert.ok(Buffer.byteLength(preview.output) <= 700);
  assert.doesNotMatch(JSON.stringify(preview), /do not serialize|\u202e/);
  assert.deepEqual(preview.diffs, [{ path: 'a.txt', before: 1, after: 2, oldPreview: 'first', newPreview: 'one\ntwo' }]);
  assert.equal(decodeAgyTool({ ...row('x', {}), ignorable: false }), undefined);
  assert.ok(agyToolSize(summarizeAgyTool({ toolCallId: 'x', rawInput: { input: '好'.repeat(50_000) }, title: '界'.repeat(50_000) })) < 1600);
  for (const [kind, title, category] of [['read','a','read'],['edit','Edit','edit'],['create','Create','write'],['search','Find','search'],['other','mcp_dsh_office_render','mcp'],['other','mcp_dsh_subagent','subagent']]) {
    assert.equal(summarizeAgyTool({ toolCallId: 'x', kind, title }).category, category);
  }
});

test('tool progress emits one durable identity, never repeats it in reasoning, and retains the tool-only receipt', () => {
  const writes = [];
  let now = 100;
  const p = agyProgress(0, { now: () => now, displayTool(id, data) { return writes.push([id, data]); } });
  assert.match(p.push({ kind: 'thought', value: 'Thinking' }).at(-1).text, /^Thinking$/);
  assert.deepEqual(p.push(call('x', { status: 'in_progress', kind: 'edit', title: 'Update file', rawInput: { TargetFile: 'x' } })), []);
  assert.deepEqual(p.push(call('x', { status: 'in_progress' })), []);
  now = 345;
  assert.deepEqual(p.push(call('x', { status: 'completed' })), []);
  assert.deepEqual(p.push(call('x', { status: 'in_progress' })), []);
  assert.deepEqual(p.close().map(e => e.block.text), ['Thinking']);
  assert.match(p.receipt(), /已完成 1 项/);
  assert.deepEqual(writes.map(([id, value]) => [id, value.status, value.target, value.startedAt, value.settledAt]), [
    ['x', 'in_progress', 'x', 100, undefined], ['x', 'completed', 'x', 100, 345],
  ]);
  assert.match(agyProgress(0, { displayTool: () => false }).push(call('x', { status: 'failed', title: '<script>' })).at(-1).text, /工具失败：\\<script\\>/);
});

test('on-demand calls retain the original tool identity without logging their argument string', () => {
  const rawInput = { name: 'mcp__playwright__browser_snapshot', arguments_json: '{"secret":"do not retain"}' };
  const snapshot = summarizeAgyTool({ toolCallId: 'x', title: 'Run mcp_dsh_tool_call', name: 'mcp_dsh_tool_call', kind: 'other', rawInput });
  assert.equal(snapshot.title, 'Run mcp_dsh_mcp__playwright__browser_snapshot');
  assert.equal(snapshot.category, 'mcp');
  assert.doesNotMatch(JSON.stringify(snapshot), /secret|do not retain/);
  const invalid = summarizeAgyTool({ toolCallId: 'x', title: 'Run mcp_dsh_tool_call', rawInput: { name: 'foo\nsubagent' } });
  assert.equal(invalid.title, undefined);
  let latest;
  const p = agyProgress(0, { displayTool(_id, data) { latest = data; return true; } });
  p.push(call('x', { title: 'Run mcp_dsh_tool_call', rawInput: { name: 'ask_user_question', arguments_json: '{"sensitive":true}' }, status: 'in_progress' }));
  p.push(call('x', { title: 'Run mcp_dsh_tool_call', kind: 'other', status: 'completed', content: [{ type: 'text', text: 'native question payload' }] }));
  assert.equal(latest.title, 'Run mcp_dsh_ask_user_question');
  assert.equal(latest.nativePanel, true);
  assert.equal(latest.output, undefined);
});

test('native question, todo, present and subagent output is not copied over their native surfaces', () => {
  for (const name of ['todo_write', 'ask_user_question', 'present', 'subagent']) {
    let latest;
    const p = agyProgress(0, { displayTool(_id, data) { latest = data; return true; } });
    p.push(call('x', { title: `mcp_dsh_${name}`, status: 'in_progress' }));
    p.push(call('x', { status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'duplicated native payload' } }] }));
    assert.equal(latest.output, undefined);
    assert.equal(latest.status, 'completed');
  }
});

test('card folds on stable start identity, renders literal strings and shows unconfirmed on closure', () => {
  const d = agyToolDefinition();
  const event = row('x', { title: '<script>no</script>', category: 'command', status: 'in_progress', target: 'echo hello', startedAt: 20 });
  assert.deepEqual(d.match[AGY_TOOL_RECORD](event), { id: 'x', role: 'start' });
  const state = d.start({}, { event });
  const context = { id: 'x', key: 'stable', start: { event, location: { kind: 'step', step: { end: { time: 45 } }, turn: {} } }, current: new Map(), state };
  const node = d.buildViewNode(context);
  assert.equal(node.data.interrupted, true);
  const rendered = createAgyToolCard(tree)({ node, useDisclosure: () => ({ expanded: true, toggle() {} }) });
  const serialized = JSON.stringify(rendered);
  assert.equal(rendered.tag, 'div');
  assert.equal(rendered.props['data-agy-tool-status'], 'interrupted');
  assert.match(serialized, /Unconfirmed/);
  assert.match(serialized, /25 ms/);
  assert.match(serialized, /echo hello/);
  assert.doesNotMatch(serialized, /dangerouslySetInnerHTML|"tag":"script"|"tag":"details"/);
  const complete = row('x', { ...event.data, status: 'completed', settledAt: 40 }, 4);
  const updated = d.buildViewNode({ ...context, state: d.update(context, { event: complete }) });
  assert.equal(updated.key, node.key);
  assert.equal(updated.anchorSeq, 3);
  assert.equal(updated.data.interrupted, false);
  assert.equal(updated.data.state.status, 'completed');
});

test('card uses native DSH DisclosureRow/TerminalBlock primitives and formats MCP/file titles cleanly', () => {
  const calls = [];
  const DisclosureRow = props => ({ kind: 'DisclosureRow', props });
  const TextShimmer = props => ({ kind: 'TextShimmer', props });
  const TerminalBlock = props => ({ kind: 'TerminalBlock', props });
  const IconBrowseOutlineRegular = props => ({ icon: 'Browse', props });
  const IconApiOutlineRegular = props => ({ icon: 'Api', props });
  const IconSparkleRegular = props => ({ icon: 'Sparkle', props });
  const primitives = { DisclosureRow, TextShimmer, TerminalBlock, IconBrowseOutlineRegular, IconApiOutlineRegular, IconSparkleRegular };
  const Card = createAgyToolCard(tree, primitives);

  // 1. MCP Playwright tool cleans noisy "Run mcp_dsh_mcp__playwright__" prefix
  const mcpRendered = Card({
    node: { data: { interrupted: false, state: {
      id: '1', category: 'mcp', status: 'completed', startedAt: 10, settledAt: 1810,
      title: 'Run mcp_dsh_mcp__playwright__browser_network_requests', target: '', paths: [], diffs: [], output: '',
    } } },
  });
  const mcpRow = mcpRendered.children[0];
  assert.equal(mcpRow.tag, DisclosureRow);
  assert.equal(mcpRow.props.title, 'Browser');
  assert.equal(mcpRow.props.running, false);
  const mcpSummary = JSON.stringify(mcpRow.props.collapsedContent);
  assert.match(mcpSummary, /browser_network_requests/);
  assert.doesNotMatch(mcpSummary, /Run mcp_dsh|1\.8 s|Completed/);

  // 2. File read normalizes "/C:/..." prefix, shortens path, and wires clickable openFile
  const fileRendered = Card({
    node: { data: { interrupted: false, state: {
      id: '2', category: 'read', status: 'completed', startedAt: 10, settledAt: 58,
      title: 'File /C:/Users/admin/.dsh/artifacts/playwright/page-2026-11-23.yml', target: '', paths: [], diffs: [], output: '',
    } } },
    openFile: file => calls.push(file),
  });
  const fileRow = fileRendered.children[0];
  assert.equal(fileRow.props.title, 'Read');
  const fileJson = JSON.stringify(fileRow.props.collapsedContent);
  assert.match(fileJson, /playwright\/page-2026-11-23\.yml/);
  assert.doesNotMatch(fileJson, /File \/C:/);
  // Click the file link button and verify normalized Windows path
  const fileBtn = fileRow.props.collapsedContent.children.find(child => child?.tag === 'button');
  assert.ok(fileBtn);
  fileBtn.props.onClick({ stopPropagation() {} });
  assert.deepEqual(calls, ['C:/Users/admin/.dsh/artifacts/playwright/page-2026-11-23.yml']);

  // 3. Expanded command renders native TerminalBlock
  const cmdRendered = Card({
    node: { data: { interrupted: false, state: {
      id: '3', category: 'command', status: 'failed', startedAt: 10, settledAt: 100,
      title: 'Run command', target: 'python -c "print(1)"', paths: [], diffs: [], output: 'Traceback...',
    } } },
    useDisclosure: () => ({ expanded: true, toggle() {} }),
  });
  const cmdRow = cmdRendered.children[0];
  assert.equal(cmdRow.props.title, 'Run command');
  const terminalNode = cmdRow.children[0].children[0].children[0];
  assert.equal(terminalNode.tag, TerminalBlock);
  assert.equal(terminalNode.props.exitCode, 1);
  assert.match(JSON.stringify(cmdRow.props.collapsedContent), /Failed/);
});

test('client negotiates only after both the optional Conversation API and the keyed chat seat mount', async () => {
  let activation, onSlot, definition, payload, rpcSignal;
  const slots = { inject(name, setup) { assert.equal(name, 'conversation.chat.node'); onSlot = setup; },
    register(config, renderer) { assert.equal(config.key, AGY_TOOL_CARD); assert.equal(typeof renderer, 'function'); return () => {}; } };
  const base = { slots, inject(keys, setup) { assert.deepEqual(keys, ['uiConversation']); activation = setup; } };
  registerAgyToolCards(base, tree);
  assert.equal(onSlot, undefined);
  activation({});
  assert.equal(onSlot, undefined);
  activation({ slots, effect(fn) { fn(); }, locale: { register() {} }, on() { return () => {}; },
    uiConversation: { events: { register(value) { definition = value; return () => { definition = undefined; }; } } },
    get: () => ({ isLoopback: true, rpc: { call(channel, endpoint, value, signal) {
      assert.equal(channel, '/api'); assert.equal(endpoint, 'subscriptions-enhanced-gemini'); payload = value; rpcSignal = signal;
    } } }),
  });
  assert.equal(payload, undefined);
  const dispose = onSlot();
  await Promise.resolve();
  assert.deepEqual(payload, { action: 'tool-cards-v1' });
  assert.equal(definition.kind, AGY_TOOL_CARD);
  dispose();
  assert.equal(definition, undefined);
  assert.equal(rpcSignal.aborted, true);
});
