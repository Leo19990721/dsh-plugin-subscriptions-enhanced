async (page) => {
  let stage = 'BROWSER', browser;
  const check = ok => { if (!ok) throw new Error('STOP'); };
  const keys = (v, ...names) => v !== null && typeof v === 'object' && !Array.isArray(v)
    && Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
  const uuid = v => typeof v === 'string' && /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(v);
  try {
    const type = page.context().browser().browserType();
    check(type.name() === 'chromium');
    // Playwright allocates its own temporary directory; no existing Chrome profile is opened.
    browser = await type.launch({ channel: 'chrome', headless: false });
    stage = 'CONTEXT';
    const ctx = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1160, height: 740 },
      serviceWorkers: 'block', acceptDownloads: false });
    const trial = await ctx.newPage();
    trial.setDefaultTimeout(30_000);

    stage = 'INPUT';
    // The substituted expression's offline file picker belongs to the new browser too.
    const input = await (async page => {
      const handoff = /* HANDOFF */ null;
      return handoff;
    })(trial);
    check(keys(input, 'base', 'url') && typeof input.base === 'string' && typeof input.url === 'string');
    const { base, url } = input, port = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.exec(base);
    check(port && port[0] === base && +port[1] <= 65535);
    const root = base + '/', prefix = root + '?token=', statusUrl = root + '__agy_trial_auth';
    check(url.startsWith(prefix) && url.length === prefix.length + 43
      && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(url.slice(prefix.length)));

    stage = 'REDIRECT';
    check((await ctx.cookies()).length === 0);
    const exchange = await ctx.request.get(url, { maxRedirects: 0, maxRetries: 0, timeout: 15_000 });
    try {
      const fields = exchange.headersArray(), header = name => fields.find(h => h.name.toLowerCase() === name);
      check(exchange.status() === 303 && header('location')?.value === './'
        && header('referrer-policy')?.value === 'no-referrer' && !!header('set-cookie'));
    } finally { await exchange.dispose(); }
    stage = 'COOKIE';
    const jar = await ctx.cookies(root);
    check(jar.length === 1 && /^dsh-auth-[A-Za-z0-9_-]{43}$/.test(jar[0].name) && jar[0].domain === '127.0.0.1'
      && jar[0].path === '/' && jar[0].httpOnly && !jar[0].secure && jar[0].sameSite === 'Strict'
      && jar[0].expires > Date.now() / 1000);

    stage = 'GUARD';
    const preload = await ctx.addInitScript(({ root, mux }) => {
      // Keep the actual carrier. Removing these descriptors restores even the socket already in use.
      const tag = Symbol.for('agy.trial.handoff'), undo = [], listeners = new Map();
      const stop = () => { throw new Error('GUARD'); };
      const keys = (v, ...names) => v !== null && typeof v === 'object' && !Array.isArray(v)
        && Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
      const uuid = v => typeof v === 'string' && /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(v);
      const main = () => window === window.top && location.href === root;
      const swap = (owner, key, value) => {
        const original = Object.getOwnPropertyDescriptor(owner, key);
        Object.defineProperty(owner, key, { ...original, value });
        undo.push(() => Object.defineProperty(owner, key, original));
      };
      let active = true, workspace, blank, spent = false, ticket;
      const Native = window.WebSocket, send = Native.prototype.send, fetch = window.fetch;
      const simple = new Set(['$events', 'workspace/follow', 'session/control', 'account/watch', 'remoteAccess/follow']);
      function permit(endpoint, a) {
        if (simple.has(endpoint)) return keys(a);
        if (!blank) return false;
        if (endpoint === 'terminal/watch') return keys(a, 'sessionId') && a.sessionId === blank;
        if (!keys(a, 'request')) return false;
        const r = a.request;
        if (endpoint === 'job/list') return keys(r, 'sessionId') && r.sessionId === blank;
        return endpoint === 'session/follow' && r && keys(r.address, 'kind', 'sessionId')
          && r.address.kind === 'session' && r.address.sessionId === blank && r.activate === true
          && r.assistantStream === true && r.turnReservation === true && (r.maxMessages === undefined || r.maxMessages === 500)
          && (r.turnWindow === undefined || (keys(r.turnWindow, 'minMessages', 'minTurns')
            && r.turnWindow.minMessages === 50 && r.turnWindow.minTurns === 2))
          && Object.keys(r).every(k => ['address', 'activate', 'assistantStream', 'turnReservation', 'maxMessages', 'turnWindow'].includes(k));
      }
      const Guarded = new Proxy(Native, { construct(target, args, newTarget) {
        if (!active) return Reflect.construct(target, args, newTarget);
        if (!main() || args.length !== 1 || args[0] !== mux) stop();
        const ws = Reflect.construct(target, args, newTarget), live = new Map(), used = new Set();
        const receive = e => {
          if (!e.isTrusted || typeof e.data !== 'string') return;
          const f = JSON.parse(e.data);
          if (live.get(f.streamId) === 'workspace/follow' && f.type === 'item' && f.value?.type === 'baseline') {
            const rows = f.value.value?.items, w = Array.isArray(rows) && rows.length === 1 && rows[0];
            workspace = w && uuid(w.workspaceId) && Array.isArray(w.sessionIds) && !w.sessionIds.length ? w.workspaceId : undefined;
          }
          if (f.type === 'end' || f.type === 'error') live.delete(f.streamId);
        };
        listeners.set(ws, { live, used, receive });
        ws.addEventListener('message', receive);
        return ws;
      } });
      swap(window, 'WebSocket', Guarded);
      swap(Native.prototype, 'constructor', Guarded);
      swap(Native.prototype, 'send', function (data) {
        if (active) {
          const state = listeners.get(this);
          if (!state || typeof data !== 'string' || data.length > 8192) stop();
          const f = JSON.parse(data);
          if (!uuid(f?.streamId)) stop();
          if (f.type === 'cancel' && keys(f, 'type', 'streamId') && state.live.delete(f.streamId)) { /* matching cancellation */ }
          else if (f.type === 'open' && keys(f, 'type', 'streamId', 'endpoint', 'payload') && !state.used.has(f.streamId)
            && keys(f.payload, 'args') && permit(f.endpoint, f.payload.args)) {
            state.used.add(f.streamId); state.live.set(f.streamId, f.endpoint);
          } else stop();
        }
        return send.call(this, data);
      });
      for (const key of ['Worker', 'SharedWorker']) if (typeof window[key] === 'function') {
        swap(window, key, new Proxy(window[key], { construct(t, args, n) { return active ? stop() : Reflect.construct(t, args, n); } }));
      }
      // Publish the blank id before the native client can open its activating follow stream.
      swap(window, 'fetch', async function (input, init) {
        if (!active || typeof input !== 'string' || new URL(input, document.baseURI).href !== root + 'api/session/create')
          return fetch.apply(this, arguments);
        if (!main() || spent || !workspace || init?.method !== 'POST' || typeof init.body !== 'string' || init.body.length > 1024) stop();
        const m = JSON.parse(init.body), a = m.payload?.args;
        if (!keys(m, 'type', 'method', 'rpcId', 'payload') || m.type !== 'client-request' || m.method !== 'session/create'
          || !uuid(m.rpcId) || !keys(m.payload, 'args') || !keys(a, 'request') || !keys(a.request, 'workspaceId')
          || a.request.workspaceId !== workspace) stop();
        spent = true; ticket = init.body;
        const res = await fetch.call(this, input, { ...init, redirect: 'error' });
        if (ticket !== undefined || res.status !== 200 || res.redirected || res.url !== root + 'api/session/create') stop();
        const ack = await res.clone().json(), id = ack.result?.value?.sessionId;
        if (!keys(ack, 'type', 'rpcId', 'result') || ack.type !== 'server-response' || ack.rpcId !== m.rpcId
          || !keys(ack.result, 'ok', 'value') || ack.result.ok !== true || typeof id !== 'string'
          || !id.startsWith('session-') || !uuid(id.slice(8))) stop();
        blank = id;
        return res;
      });
      Object.defineProperty(window, tag, { configurable: true, value: {
        claim(body) { if (ticket === undefined || body !== ticket) return false; ticket = undefined; return true; },
        ownsBlank(id) { return active && main() && blank !== undefined && id === blank; },
        restore() {
          active = false;
          for (const [ws, { receive }] of listeners) ws.removeEventListener('message', receive);
          listeners.clear();
          for (const restore of undo.reverse()) restore();
          delete window[tag];
          return true;
        },
      } });
    }, { root, mux: base.replace('http:', 'ws:') + '/api/remote.mux' });

    const pkg = '(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*';
    const entry = pkg + '/client\\.js', rev = '[a-f0-9]{12}';
    const combo = new RegExp('^/plugins/\\?\\?' + entry + '(?:,' + entry + ')*&rev=' + rev + '$');
    const chunk = new RegExp('^/plugins/' + pkg + '/client\\.(?!node\\.)[a-zA-Z0-9][a-zA-Z0-9._-]*\\.js\\?rev=' + rev + '$');
    const image = new RegExp('^/plugins/' + pkg + '/assets/(?:[a-zA-Z0-9_-]+/)*(?:[a-zA-Z0-9._@-]|%40|%20)+-' + rev + '\\.(?:svg|png|webp|jpe?g)$');
    const staticPath = p => combo.test(p) || chunk.test(p) || image.test(p)
      || /^\/assets\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9][A-Za-z0-9_.-]*\.(?:js|css|woff2?|png|svg|webp|jpe?g)(?:\?rev=[a-f0-9]{12})?$/.test(p)
      || /^\/(?:manifest\.webmanifest|favicon(?:-dark)?\.svg|favicon\.ico|apple-touch-icon\.png|icon-(?:192|512|maskable-512)\.png)$/.test(p);
    const reads = new Set(['settings/describe', 'agentPresets/list', 'dynamicCordisRunner/inventory',
      'web/listProviders', 'permissionPresets/catalog', 'llm/listProviders', 'llm/listConfigurableProviders']);
    const ownsBlank = id => typeof id === 'string' && trial.evaluate(value => window[Symbol.for('agy.trial.handoff')]?.ownsBlank(value) === true, id);
    const admitted = new WeakSet();
    let firstStatus, visited = false;
    const statusResponse = res => res.url() === statusUrl && admitted.has(res.request());
    const remember = res => { if (!firstStatus && statusResponse(res)) firstStatus = res; };
    trial.on('response', remember);
    await ctx.route('**/*', async route => {
      const req = route.request(), dest = req.url();
      try {
        check(dest.startsWith(root) && req.frame() === trial.mainFrame() && !req.redirectedFrom());
        const path = dest.slice(base.length);
        if (req.method() === 'GET') {
          if (req.isNavigationRequest()) { check(!visited && dest === root); visited = true; }
          else if (path === '/plugins/events') check(visited && req.frame().url() === root && req.resourceType() === 'eventsource'
            && req.postData() === null && await req.headerValue('accept') === 'text/event-stream');
          else check(staticPath(path));
        } else {
          check(req.method() === 'POST' && !req.isNavigationRequest() && req.resourceType() === 'fetch'
            && req.frame().url() === root && await req.headerValue('content-type') === 'application/json');
          if (dest === statusUrl) {
            check(req.postData() === '{"action":"status"}'); admitted.add(req);
          } else {
            check(path.startsWith('/api/'));
            const ep = path.slice(5);
            check(reads.has(ep) || ['session/list', 'session/modelCatalog', 'commands/list', 'credentials/describe', 'session/create'].includes(ep));
            const body = req.postData(); check(typeof body === 'string' && body.length <= 16384);
            const m = JSON.parse(body), a = m.payload?.args;
            check(keys(m, 'type', 'method', 'rpcId', 'payload') && m.type === 'client-request' && m.method === ep && uuid(m.rpcId) && keys(m.payload, 'args'));
            if (ep === 'session/create') check(await trial.evaluate(text => window[Symbol.for('agy.trial.handoff')]?.claim(text), body));
            else if (ep === 'session/list') check(keys(a, '_request') && keys(a._request));
            else if (ep === 'session/modelCatalog') check(keys(a) || (keys(a, 'request') && keys(a.request, 'audience', 'sessionId')
              && a.request.audience === 'conversation' && await ownsBlank(a.request.sessionId)));
            else if (ep === 'commands/list') check(keys(a, 'agentId') && await ownsBlank(a.agentId));
            else if (ep === 'credentials/describe') check(keys(a, 'refs') && Array.isArray(a.refs) && a.refs.length <= 64
              && a.refs.every(ref => typeof ref === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/.test(ref)));
            else check(keys(a));
          }
        }
        await route.continue(); // Chromium supplies its own cookies, Origin and Fetch Metadata.
      } catch (_denied) { await route.abort('blockedbyclient').catch(() => {}); }
    });

    stage = 'ROOT';
    const document = await trial.goto(root, { waitUntil: 'domcontentloaded' });
    check(document?.status() === 200 && document.url() === root && !document.request().redirectedFrom() && trial.url() === root);
    check(await trial.evaluate(() => !!window[Symbol.for('agy.trial.handoff')] && navigator.language === 'zh-CN'));
    stage = 'MENU';
    await trial.getByRole('button', { name: '账号菜单', exact: true }).click();
    stage = 'SETTINGS';
    await trial.getByRole('menuitem', { name: '设置', exact: true }).click();
    const dialog = trial.getByRole('dialog', { name: '设置', exact: true });
    await dialog.waitFor();
    stage = 'MODELS';
    await dialog.getByRole('button', { name: '模型', exact: true }).click();
    stage = 'STATUS';
    const res = firstStatus ?? await trial.waitForResponse(statusResponse);
    check(!res.fromServiceWorker() && res.status() === 200 && /^application\/json\b/i.test(await res.headerValue('content-type')));
    const status = await res.json();
    check(status.status === 'signed-out' && status.canLogin === true);
    stage = 'CARD';
    const card = dialog.getByRole('region', { name: 'Gemini（Google Antigravity）', exact: true });
    const note = card.getByRole('status').getByText('尚未连接官方 agy。', { exact: true });
    const login = card.getByRole('button', { name: '使用 Google 登录', exact: true, disabled: false });
    await note.waitFor(); await login.waitFor(); await card.scrollIntoViewIfNeeded();
    const inView = el => { const r = el.getBoundingClientRect(); return el.contains(el.ownerDocument.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); };
    check(await login.isEnabled() && await note.evaluate(inView) && await login.evaluate(inView));

    stage = 'HANDOFF';
    for (const c of browser.contexts()) {
      if (c !== ctx) await c.close();
      else for (const p of c.pages()) if (p !== trial) await p.close();
    }
    await trial.bringToFront();
    check(ctx.pages().length === 1 && browser.contexts().length === 1 && trial.url() === root);
    await preload.dispose();
    for (const frame of trial.frames()) check(await frame.evaluate(() => window[Symbol.for('agy.trial.handoff')]?.restore() === true));
    trial.off('response', remember);
    await ctx.unrouteAll({ behavior: 'wait' });
    return 'READY';
  } catch (_failure) {
    if (browser) await browser.close().catch(() => {});
    return stage;
  }
}
