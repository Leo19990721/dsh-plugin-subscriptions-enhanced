import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

// Local fixture. It uses only stdio and never accesses a profile, filesystem or network.
const mode = process.argv[2];
const init = {
  protocolVersion: 1,
  agentInfo: { name: 'Antigravity ACP Server', version: '1.5.12' },
  agentCapabilities: { loadSession: true },
  authMethods: [],
};
const sessionId = 'synthetic-session';
const pendingPermissions = new Map();
const seen = [];
let promptId;
let orderId;
const line = payload => Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', ...payload })}\n`);
const send = payload => process.stdout.write(line(payload));
const result = (id, data) => send({ id, result: data });
const error = (id, code) => send({ id, error: {
  code, message: 'SYNTHETIC_PRIVATE_RPC_MESSAGE', data: { marker: 'SYNTHETIC_PRIVATE_RPC_DATA' },
} });
const update = text => line({ method: 'session/update', params: {
  sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
} });

function permission(id, toolCallId) {
  send({ id, method: 'session/request_permission', params: {
    sessionId, toolCall: { toolCallId }, options: [
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
    ],
  } });
}

const stdin = createInterface({ input: process.stdin });
for await (const data of stdin) {
  const message = JSON.parse(data);
  assert.equal(message.jsonrpc, '2.0');
  const { id, method, params } = message;
  if (method === 'initialize') {
    assert.equal(params.protocolVersion, 1);
    assert.equal(params.clientCapabilities?.terminal ?? false, false);
    assert.equal(params.clientCapabilities?.fs?.readTextFile ?? false, false);
    assert.equal(params.clientCapabilities?.fs?.writeTextFile ?? false, false);
    assert.equal(params.clientCapabilities?.auth?.terminal ?? false, false);
    assert.equal(typeof params.clientInfo.name, 'string');
    assert.equal(typeof params.clientInfo.version, 'string');
    if (mode === 'exit-before-initialize') process.exit(23);
    if (mode === 'initialize-timeout') continue;
    if (mode === 'initialize-auth') { error(id, -32000); continue; }
    if (mode === 'wrong-version') { result(id, { ...init, protocolVersion: 2 }); continue; }
    if (mode === 'wrong-name') {
      result(id, { ...init, agentInfo: { name: 'agy', title: 'Antigravity ACP Server', version: '1.5.12' } });
      continue;
    }
    if (mode === 'missing-version') {
      result(id, { ...init, agentInfo: { name: init.agentInfo.name } });
      continue;
    }
    result(id, init);
    continue;
  }
  if (!method) {
    pendingPermissions.get(id)?.(message);
    continue;
  }
  if (method === 'test/duplex') {
    // More than a pipe buffer; stderr must be consumed without being surfaced.
    process.stderr.write('SYNTHETIC_PRIVATE_STDERR'.repeat(30_000));
    const text = params.text;
    const first = update(text);
    const start = first.indexOf(Buffer.from('汉'));
    assert.ok(start >= 0);
    process.stdout.write(first.subarray(0, start + 1));
    await delay(20);
    process.stdout.write(first.subarray(start + 1, start + 2));
    await delay(20);
    process.stdout.write(Buffer.concat([first.subarray(start + 2, first.length - 1), Buffer.from('\r\n'),
      update('🚀二'), line({ id, result: { echo: text } })]));
  } else if (method === 'test/mark') {
    seen.push(params.tag);
  } else if (method === 'test/order') {
    if (mode === 'permission' && seen.length < 4) orderId = id;
    else result(id, seen);
  } else if (method === 'test/first') {
    seen.push(id);
  } else if (method === 'test/second') {
    result(String(id), 'wrong type');
    result(id + 100_000, 'unknown id');
    result(id, 'second');
    result(seen.pop(), 'first');
  } else if (method === 'session/new') {
    error(id, -32000);
  } else if (method === 'test/rpc-error') {
    error(id, -32602);
  } else if (method === 'session/prompt') {
    promptId = id;
    if (mode === 'permission') {
      process.stdout.write(update('询问'));
      pendingPermissions.set('peer-permission', message => {
        process.stdout.write(update('继续'));
        result(id, { stopReason: 'end_turn', response: message });
      });
      permission('peer-permission', 'first-tool');
      // A server request may use the same id as a concurrent client request.
      send({ id, method: 'fs/read_text_file', params: { path: 'not-a-real-request' } });
      send({ id: 'term', method: 'terminal/create', params: {} });
      send({ id: 'mcp', method: 'mcp/connect', params: {} });
      send({ id: 'update-is-a-request', method: 'session/update', params: { ignored: true } });
      send({ method: 'fs/read_text_file', params: {} }); // Notifications receive no reply.
      for (const key of [id, 'term', 'mcp', 'update-is-a-request']) {
        pendingPermissions.set(key, reply => {
          assert.deepEqual(reply, { jsonrpc: '2.0', id: key, error: { code: -32601, message: 'Method not found' } });
          seen.push(key);
          if (seen.length === 4 && orderId !== undefined) result(orderId, seen);
        });
      }
    } else if (mode === 'permission-timeout') {
      permission('peer-permission', 'first-tool');
    } else if (mode === 'cancel') {
      pendingPermissions.set('peer-permission', message => {
        assert.deepEqual(message.result, { outcome: { outcome: 'cancelled' } });
        assert.ok(seen.includes('cancel'));
        process.stdout.write(update('停止后的最后一段'));
        result(promptId, { stopReason: 'cancelled' });
      });
      process.stdout.write(update('开始'));
      permission('peer-permission', 'first-tool');
    }
  } else if (method === 'session/cancel') {
    assert.equal(Object.hasOwn(message, 'id'), false);
    assert.equal(params.sessionId, sessionId);
    seen.push('cancel');
  } else if (method === 'test/hang') {
    // The test owns a request timeout and the client must stop this process.
  } else if (method === 'test/exit') {
    process.stderr.write('SYNTHETIC_PRIVATE_STDERR', () => process.exit(23));
  } else if (method === 'test/invalid-json') {
    process.stdout.write(Buffer.concat([Buffer.from('SYNTHETIC_PRIVATE_BAD_JSON\n'), update('ignored')]));
  } else if (method === 'test/invalid-utf8') {
    const payload = line({ id, result: 'X' });
    payload[payload.indexOf(0x58)] = 0xff; // JSON shape would survive a lossy UTF-8 decode.
    process.stdout.write(Buffer.concat([payload, update('ignored')]));
  } else if (method === 'test/invalid-response') {
    send({ id, result: {}, error: { code: -32602, message: 'SYNTHETIC_PRIVATE_RPC_MESSAGE' } });
  } else if (method === 'test/oversize') {
    // Deliberately no LF; the read fails at the byte cap rather than waiting for EOF.
    process.stdout.write(Buffer.alloc(4 * 1024 * 1024 + 1, 0x41));
  } else if (method === 'test/ping') {
    result(id, { alive: true });
  } else {
    error(id, -32601);
  }
}

if (mode === 'stubborn') {
  // Keep the real synthetic child alive after stdin EOF to exercise kill + reap.
  await new Promise(() => { setInterval(() => {}, 1000); });
}
