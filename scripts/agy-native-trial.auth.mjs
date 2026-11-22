/** Owns only the explicit official ACP sign-in operation; it never accepts tokens or prompts. */
const known = new Set(['TIMEOUT', 'SPAWN_FAILED', 'PROCESS_EXIT', 'IO', 'PROTOCOL', 'UNSUPPORTED_PROTOCOL',
  'RPC_ERROR', 'INVALID_ARGUMENT', 'CLOSED', 'auth-unavailable', 'catalog-unavailable', 'cleanup-unconfirmed']);
const safeError = error => known.has(error?.code) ? String(error.code) : 'unavailable';
const problem = code => Object.assign(new Error('Official Antigravity sign-in could not complete.'), { code });

/**
 * @param {object} options - Explicit official client factory and post-login catalog callback.
 * @returns {object} In-memory status, explicit login/cancel and owned disposal methods.
 */
export function createTrialAuthentication({ makeClient, connect }) {
  let status = 'signed-out';
  let canLogin = false;
  let error;
  let active;
  let disposed = false;
  let cleanupFailed = false;
  const clients = new Set();
  const snapshot = () => ({ status, canLogin: !disposed && !cleanupFailed && canLogin,
    ...(error === undefined ? {} : { error }) });
  const setError = failure => {
    status = 'error'; error = safeError(failure);
    if (error === 'cleanup-unconfirmed') cleanupFailed = true;
  };

  async function clientFor(operation, allowAuthentication) {
    const client = await makeClient({ allowAuthentication });
    clients.add(client);
    operation.client = client;
    if (disposed || operation.controller.signal.aborted) throw problem('CLOSED');
    return client;
  }
  async function closeClient(client) {
    if (!client) return;
    try { await client.close(); clients.delete(client); }
    catch (_error) { cleanupFailed = true; throw problem('cleanup-unconfirmed'); }
  }
  const newOperation = () => ({ controller: new AbortController(), client: undefined, done: undefined });
  const offersPersonal = result => Array.isArray(result?.authMethods)
    && result.authMethods.filter(item => item?.id === 'oauth-personal').length === 1;

  return Object.freeze({
    snapshot,
    /** Initialize advertises methods only; no authenticate, session or model work is sent. */
    async inspect() {
      if (disposed || cleanupFailed || active) return snapshot();
      const operation = active = newOperation();
      operation.done = (async () => {
        try {
          const client = await clientFor(operation, false);
          const initialization = await client.start();
          if (disposed || operation.controller.signal.aborted) return;
          canLogin = offersPersonal(initialization);
          if (!canLogin) setError(problem('auth-unavailable'));
        } catch (failure) { if (!disposed) setError(failure); }
        finally {
          try { await closeClient(operation.client); }
          catch (failure) { if (!disposed) setError(failure); }
          if (active === operation) active = undefined;
        }
      })();
      await operation.done;
      return snapshot();
    },
    /** The authenticated DSH button is the only caller; completion never returns credentials. */
    login() {
      if (disposed || cleanupFailed || active || status === 'connected' || !canLogin) return snapshot();
      const operation = active = newOperation();
      status = 'signing-in';
      error = undefined;
      operation.done = (async () => {
        try {
          const client = await clientFor(operation, true);
          const initialization = await client.start();
          if (disposed || operation.controller.signal.aborted) return;
          if (!offersPersonal(initialization)) { canLogin = false; throw problem('auth-unavailable'); }
          await client.authenticate('oauth-personal');
          if (disposed || operation.controller.signal.aborted) return;
          await closeClient(client);
          operation.client = undefined;
          if (disposed || operation.controller.signal.aborted) return;
          await connect(operation.controller.signal);
          if (!disposed && !operation.controller.signal.aborted) { status = 'connected'; error = undefined; }
        } catch (failure) {
          if (!disposed && (!operation.controller.signal.aborted || failure?.code === 'cleanup-unconfirmed')) setError(failure);
        } finally {
          try { await closeClient(operation.client); }
          catch (failure) { if (!disposed) setError(failure); }
          if (active === operation) active = undefined;
        }
      })();
      return snapshot();
    },
    async cancel() {
      const operation = active;
      if (disposed || !operation || status !== 'signing-in') return snapshot();
      operation.controller.abort();
      try { await closeClient(operation.client); }
      catch (failure) { setError(failure); }
      await operation.done;
      if (!cleanupFailed) { status = 'signed-out'; error = undefined; }
      return snapshot();
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      const operation = active;
      operation?.controller.abort();
      for (const client of clients) {
        try { await closeClient(client); }
        catch (_error) { /* All owned clients are attempted before reporting cleanup failure. */ }
      }
      await operation?.done;
      if (cleanupFailed) throw problem('cleanup-unconfirmed');
    },
  });
}

/** Local Web-only login capability. Never registered as a DSH RPC/tool or an agent action. */
export function trialAuthRoute(ctx, auth) {
  const path = '/__agy_trial_auth';
  const json = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  return { kind: 'exact', path, async handler(req, res) {
    const reply = (code, value) => { res.writeHead(code, json); res.end(JSON.stringify(value)); };
    if (req.url !== path) return reply(404, {});
    if (req.method !== 'POST') return reply(405, {});
    const headers = req.headers ?? {};
    const authority = `127.0.0.1:${ctx.webServer.port}`;
    if (ctx.webServer.host !== '127.0.0.1' || ctx.connection.allowsRemoteAuthorities !== false
      || !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)
      || headers.host !== authority || headers.origin !== `http://${authority}`
      || headers['sec-fetch-site'] !== 'same-origin') return reply(403, {});
    const { peer } = ctx.connection.admit(req);
    if (!peer || peer !== ctx.connection.browserPeer || peer.signal.aborted || peer.principal.kind !== 'owner') return reply(403, {});
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(headers['content-type'] ?? '')) return reply(415, {});
    if (headers['content-length'] !== undefined && !/^\d{1,3}$/u.test(headers['content-length'])) return reply(413, {});
    if (Number(headers['content-length']) > 128) return reply(413, {});
    let body;
    try {
      let bytes = 0;
      const chunks = [];
      for await (const chunk of req) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 128) return reply(413, {});
        chunks.push(Buffer.from(chunk));
      }
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
      // JSON.parse collapses repeated keys. Permit exactly one string-to-string member before decoding it.
      if (!/^[ \t\r\n]*\{[ \t\r\n]*"(?:[^"\\]|\\.)*"[ \t\r\n]*:[ \t\r\n]*"(?:[^"\\]|\\.)*"[ \t\r\n]*\}[ \t\r\n]*$/u.test(text)) return reply(400, {});
      body = JSON.parse(text);
    } catch (_error) { return reply(400, {}); }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1
      || !Object.hasOwn(body, 'action') || !['status', 'login', 'cancel'].includes(body.action)) return reply(400, {});
    if (peer.signal.aborted || peer !== ctx.connection.browserPeer || ctx.connection.allowsRemoteAuthorities !== false) return reply(403, {});
    try {
      const result = body.action === 'status' ? auth.snapshot() : body.action === 'login' ? auth.login() : await auth.cancel();
      return reply(200, result);
    } catch (_error) { return reply(503, { status: 'error', canLogin: false, error: 'unavailable' }); }
  } };
}
