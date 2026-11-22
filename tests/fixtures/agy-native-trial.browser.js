async (page) => {
  // Only these numeric counters leave the private context, including on failure.
  // Steps: 1 handoff, 2 context, 3 exchange, 4 clean document, 5 Settings/Models,
  // 6 signed out, 7 manual check, 8 reopen, 9 reload, 10 waiting, 11 automatic
  // poll, 12 cancel, 13 error, 14 retry/connected, 15 layout/contrast, 16 teardown.
  // Guards: 20 outside, 21 HTTP, 22 static response, 23 unary, 24 mux, 25 action,
  // 26 native status, 27 actual request headers, 28 browser error, 29 unexpected page/dialog.
  const r = { ok: 0, failedStep: 0, contexts: 0, exchanges: 0, cleanLoads: 0, assets: 0,
    realStatus: 0, signedOutResponses: 0, wireChecks: 0, rpc: 0, streams: 0,
    mockStatus: 0, mockLogin: 0, mockCancel: 0, autoPolls: 0, manualChecks: 0,
    reopens: 0, reloads: 0, connected: 0, verifiedCards: 0, narrowChecks: 0, darkContrastX100: 0,
    layoutCheck: 0, layoutNode: 0, layoutContrastX100: 0,
    outside: 0, blocked: 0, prompts: 0, unexpectedActions: 0, browserErrors: 0, unexpectedPages: 0,
    eventSources: 0, httpStep: 0, httpKind: 0, httpType: 0, httpSuffix: 0, httpFlags: 0,
    rpcStep: 0, rpcNamespace: 0, rpcOp: 0, rpcIndex: 0, rpcShape: 0, rpcArgs: 0 };
  let step = 1, ctx, closing = false;
  const check = value => { if (!value) throw 0; };
  const fault = code => { if (!r.failedStep) r.failedStep = code; };
  const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const keys = (v, ...names) => record(v) && Object.keys(v).length === names.length && names.every(n => Object.hasOwn(v, n));
  const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
  const named = v => keys(v, 'args') && record(v.args) && Object.keys(v.args).every(k => /^[A-Za-z][A-Za-z0-9]*$/.test(k) && k !== 'constructor');
  const text = {
    en: { lang: 'en', account: 'Account menu', settings: 'Settings', models: 'Models', open: 'Open sidebar',
      title: 'Gemini (Google Antigravity)', out: 'Not connected to official agy.', login: 'Log in with Google',
      check: 'Check status again', cancel: 'Cancel sign-in', retry: 'Retry Google sign-in',
      wait: 'Complete Google sign-in in the browser opened by official agy. This card will update automatically.',
      error: 'Official agy sign-in failed. Try signing in with Google again.',
      connected: 'Connected to official agy', next: 'Close Settings, then select Antigravity from the model menu.',
      consent: 'Official agy may share sign-in with other Antigravity apps on Windows. Clicking “Log in with Google” authorizes official agy to start sign-in.',
      privacy: 'Official agy opens the browser itself. No password or token is entered in DSH.' },
    zh: { lang: 'zh-CN', account: '账号菜单', settings: '设置', models: '模型', open: '打开侧边栏',
      title: 'Gemini（Google Antigravity）', out: '尚未连接官方 agy。', login: '使用 Google 登录',
      check: '重新检查状态', cancel: '取消登录', retry: '重试 Google 登录',
      wait: '请在官方 agy 打开的浏览器中完成 Google 登录，完成后这里会自动更新。', error: '官方 agy 登录超时，请重试登录。',
      connected: '已连接官方 agy', next: '关闭设置后，在模型菜单中选择 Antigravity。',
      consent: '官方 agy 可能与 Windows 上其他 Antigravity 共用登录状态。点击“使用 Google 登录”即表示你同意由官方 agy 发起登录。',
      privacy: '官方 agy 会自行打开浏览器；无需在 DSH 输入密码或 token。' },
  };
  const endpoints = {
    'session/list': { items: [] }, 'workspace/initializeDefault': undefined,
    'settings/describe': { writable: true, hasDocument: true, namespaces: [{ ns: 'ui-settings-general',
      schema: { type: 'object', dict: { welcomeNoticeVersion: { type: 'string', meta: {} } } },
      value: { welcomeNoticeVersion: '2026-09-28.1' }, autoGenerate: true, applies: 'live', secrets: [], revision: 1 }] },
    'session/modelCatalog': { default: { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, routableProviders: [], groups: [], failures: [] },
    'agentPresets/list': { presets: [] }, 'dynamicCordisRunner/syncInspectManifest': null, 'dynamicCordisRunner/inventory': [],
    'credentials/describe': {}, 'web/listProviders': { search: [], fetch: [] }, 'permissionPresets/catalog': { options: [] },
    'llm/listProviders': [], 'llm/listConfigurableProviders': [],
    'account/getProfile': null, 'account/getBalance': null, 'account/getNotifications': null,
  };
  const streamItems = {
    '$events': [{ type: 'ready', clientId: '00000000-0000-4000-8000-000000000001', host: { home: '/trial' } }],
    'session/control': [{ type: 'baseline', value: { projections: {} } }], 'session/follow': [],
    'workspace/follow': [{ type: 'baseline', value: { items: [], archivedSessionIds: [], pinnedSessionIds: [] } }],
    'remoteAccess/follow': [{ type: 'baseline', owner: true }],
    'account/watch': [{ type: 'snapshot', state: { status: 'signed-out', attempt: null, links: { usageUrl: 'about:blank', topUpUrl: 'about:blank' } } }],
    'terminal/watch': [[]], 'productAnalytics/watchPolicy': [false], 'job/list': [{ type: 'rows', jobs: [] }],
  };
  // No arbitrary same-origin GET, query string, path traversal, redirects, or source maps.
  const pkg = '(?:@deepseek-ai/dsh-[a-z0-9-]+|dsh-agy-native-trial)';
  const combo = new RegExp('^/plugins/\\?\\?' + pkg + '/client\\.js(?:,' + pkg + '/client\\.js)*&rev=[a-f0-9]{12}$');
  const chunk = new RegExp('^/plugins/' + pkg + '/client\\.[A-Za-z0-9_-]+\\.js\\?rev=[a-f0-9]{12}$');
  const image = new RegExp('^/plugins/' + pkg + '/assets/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_.-]+\\.(?:png|svg|webp|jpe?g)$');
  function staticMime(path, type) {
    if (path === '/' && type === 'document') return /^text\/html\b/i;
    if (path === '/manifest.webmanifest' && ['manifest', 'other'].includes(type)) return /^(?:application\/(?:manifest\+json|json)|text\/json)\b/i;
    if ((/^\/(?:favicon(?:-dark)?\.svg|apple-touch-icon\.png|icon-(?:192|512|maskable-512)\.png)$/.test(path) || image.test(path)) && ['image', 'other', 'fetch'].includes(type)) return /^image\//i;
    if (/^\/assets\/(?:langs\/)?[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.js$/.test(path) || combo.test(path) || chunk.test(path)) {
      if (['script', 'fetch', 'other'].includes(type)) return /^(?:text|application)\/(?:javascript|ecmascript)\b/i;
    }
    if (/^\/assets\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.css$/.test(path) && type === 'stylesheet') return /^text\/css\b/i;
    if (/^\/assets\/fonts\/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.woff2$/.test(path) && type === 'font') return /^(?:font\/woff2|application\/(?:font-woff2|octet-stream))\b/i;
    return null;
  }
  try {
    const handoff = /* HANDOFF */ null;
    check(keys(handoff, 'base', 'url') && typeof handoff.base === 'string' && typeof handoff.url === 'string');
    const { base, url } = handoff, port = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.exec(base);
    check(port && port[0] === base && +port[1] <= 65535 && +port[1] !== 80);
    const root = base + '/', prefix = root + '?token=', statusUrl = base + '/__agy_trial_auth';
    check(url.startsWith(prefix) && url.length === prefix.length + 43 && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(url.slice(prefix.length)));
    const browser = page.context().browser();
    check(browser);
    for (const locale of ['en', 'zh']) {
      step = 2; closing = false;
      const zh = locale === 'zh', t = text[locale];
      ctx = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false,
        viewport: { width: zh ? 320 : 1160, height: zh ? 740 : 840 }, locale: zh ? 'zh-CN' : 'en-US', colorScheme: zh ? 'dark' : 'light' });
      r.contexts++;
      check((await ctx.cookies()).length === 0);
      const context = ctx, native = new WeakSet(), rpcIds = new Set();
      let p, entryOpen = true, issued = false, ticket = '', simulated = false, mock = 'signed-out', seenPages = 0;
      // Check metadata only. The real status endpoint authenticates the authority-specific cookie.
      const cookieOK = c => c && c.httpOnly && c.domain === '127.0.0.1' && c.path === '/' && c.sameSite === 'Strict'
        && !c.secure && c.expires > Date.now() / 1000;
      const quietClose = async route => { try { await route.abort('blockedbyclient'); } catch (_) { /* context closed */ } };
      const deny = async (route, code) => { r.blocked++; fault(code); await quietClose(route); };
      context.on('page', () => { if (++seenPages > 1) { r.unexpectedPages++; fault(29); } });
      context.on('dialog', dlg => { r.prompts++; fault(29); void dlg.dismiss().catch(() => {}); });
      context.on('weberror', () => { if (!closing) { r.browserErrors++; fault(28); } });
      context.on('console', message => { if (!closing && ['error', 'assert'].includes(message.type())) { r.browserErrors++; fault(28); } });
      context.on('response', res => {
        if (!native.has(res.request())) return;
        void (async () => {
          check(res.status() === 200 && res.url() === statusUrl && /^application\/json\b/i.test((await res.headerValue('content-type')) || ''));
          const value = await res.json();
          check(keys(value, 'status', 'canLogin') && value.status === 'signed-out' && value.canLogin === true);
          r.signedOutResponses++;
        })().catch(() => fault(26));
      });
      await context.routeWebSocket('**/*', socket => {
        const wsBase = base.replace('http:', 'ws:');
        const reject = code => { r.blocked++; fault(code); void socket.close({ code: 1008 }).catch(() => {}); };
        if (socket.url() !== wsBase + '/api/remote.mux') {
          const outside = !socket.url().startsWith(wsBase + '/'); if (outside) r.outside++;
          reject(outside ? 20 : 24); return;
        }
        const used = new Set(), live = new Map();
        socket.onMessage(message => {
          try {
            check(typeof message === 'string' && message.length <= 65536);
            const f = JSON.parse(message); check(record(f) && uuid(f.streamId));
            if (f.type === 'end' || f.type === 'cancel') {
              check(keys(f, 'type', 'streamId') && live.has(f.streamId));
              if (f.type === 'cancel') live.delete(f.streamId);
              else { check(!live.get(f.streamId)); live.set(f.streamId, true); }
              return;
            }
            if (typeof f.endpoint === 'string' && /prompt|sendMessage|runTurn/i.test(f.endpoint)) r.prompts++;
            check(keys(f, 'type', 'streamId', 'endpoint', 'payload') && f.type === 'open' && !used.has(f.streamId)
              && typeof f.endpoint === 'string' && Object.hasOwn(streamItems, f.endpoint) && named(f.payload)
              && (f.endpoint !== '$events' || keys(f.payload.args)));
            used.add(f.streamId); live.set(f.streamId, false); r.streams++;
            for (const value of streamItems[f.endpoint]) socket.send(JSON.stringify({ type: 'item', streamId: f.streamId, value }));
          } catch (_) { reject(24); }
        });
      });
      await context.route('**/*', async route => {
        const req = route.request(), dest = req.url(), method = req.method(), type = req.resourceType();
        let reason = 21;
        try {
          if (closing) { await quietClose(route); return; }
          if (!dest.startsWith(root)) { r.outside++; await deny(route, 20); return; }
          const path = dest.slice(base.length);
          check(p && req.frame().page() === p && !req.redirectedFrom());
          if (dest === url) {
            reason = 3;
            check(entryOpen && !issued && method === 'GET' && type === 'document' && req.isNavigationRequest() && !req.frame().parentFrame());
            entryOpen = false;
            const res = await route.fetch({ maxRedirects: 0, timeout: 15000 });
            try {
              const h = res.headers(), jar = await context.cookies(root);
              check(res.status() === 303 && h.location === './' && h['referrer-policy'] === 'no-referrer' && h['cache-control'] === 'no-store'
                && Object.hasOwn(h, 'set-cookie') && jar.length === 1 && cookieOK(jar[0]));
            } finally { await res.dispose(); }
            // A Chromium-followed redirect can bypass the route callback. Consume the validated
            // 303 privately and start an independent, guarded navigation to its exact clean target.
            await route.fulfill({ status: 204 });
            issued = true; r.exchanges++;
            return;
          }
          check(issued);
          if (dest === statusUrl) {
            reason = 25;
            check(method === 'POST' && type === 'fetch' && req.frame() === p.mainFrame() && req.frame().url() === root
              && req.headers()['content-type'] === 'application/json');
            const body = req.postData();
            if (body === '{"action":"status"}' && !simulated) {
              reason = 26;
              const jar = await context.cookies(root);
              check(jar.length === 1 && cookieOK(jar[0]));
              // The only native continuation: exact read-only bytes, real browser origin/fetch metadata/cookie.
              native.add(req); r.realStatus++; await route.continue(); return;
            }
            const reply = value => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(value) });
            if (body === '{"action":"status"}' && simulated) r.mockStatus++;
            else if (body === '{"action":"login"}' && simulated && ['wait', 'error', 'connected'].includes(ticket)) {
              mock = ticket === 'wait' ? 'signing-in' : ticket; ticket = ''; r.mockLogin++;
            } else if (body === '{"action":"cancel"}' && simulated && ticket === 'cancel' && mock === 'signing-in') {
              mock = 'signed-out'; ticket = ''; r.mockCancel++;
            } else { r.unexpectedActions++; await deny(route, 25); return; }
            await reply({ status: mock, canLogin: mock === 'signed-out' || mock === 'error', ...(mock === 'error' ? { error: zh ? 'TIMEOUT' : 'unavailable' } : {}) });
            return;
          }
          // The bundled client-hmr opens this exact EventSource. This test holds the
          // built graph fixed: 204 is the standard instruction not to reconnect.
          if (path === '/plugins/events') {
            check(method === 'GET' && type === 'eventsource' && req.postData() === null
              && req.frame() === p.mainFrame() && req.frame().url() === root && req.headers().accept === 'text/event-stream');
            r.eventSources++; await route.fulfill({ status: 204 }); return;
          }
          if (path.startsWith('/api/')) {
            reason = 23;
            const endpoint = path.slice(5);
            if (/prompt|sendMessage|runTurn/i.test(endpoint)) r.prompts++;
            check(method === 'POST' && type === 'fetch' && Object.hasOwn(endpoints, endpoint) && req.headers()['content-type'] === 'application/json');
            const body = req.postData(); check(typeof body === 'string' && body.length <= 1024 * 1024);
            const f = JSON.parse(body);
            check(keys(f, 'type', 'rpcId', 'method', 'payload') && f.type === 'client-request' && uuid(f.rpcId)
              && !rpcIds.has(f.rpcId) && f.method === endpoint && (endpoint === 'session/list'
                ? keys(f.payload, 'args') && keys(f.payload.args, '_request') && keys(f.payload.args._request) : named(f.payload)));
            rpcIds.add(f.rpcId); r.rpc++;
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ type: 'server-response', rpcId: f.rpcId, result: { ok: true, value: endpoints[endpoint] } }) });
            return;
          }
          const mime = staticMime(path, type);
          check(method === 'GET' && mime && req.postData() === null && (path !== '/' || (req.isNavigationRequest() && !req.frame().parentFrame())));
          reason = 22;
          const res = await route.fetch({ maxRedirects: 0, timeout: 20000 });
          try {
            check(res.status() === 200 && mime.test(res.headers()['content-type'] || '') && !Object.hasOwn(res.headers(), 'set-cookie'));
            if (path === '/') r.cleanLoads++; else r.assets++;
            await route.fulfill({ response: res });
          } finally { await res.dispose(); }
        } catch (_) {
          // Fixed diagnostic enums only: never report or hash an unchecked request URL or payload.
          if (reason === 21 && !closing && !r.httpStep) {
            const rel = dest.startsWith(root) ? dest.slice(base.length) : '', path = rel.split('?', 1)[0];
            r.httpStep = step;
            r.httpKind = ['/assets/fonts/', '/assets/', '/plugins/??', '/plugins/', '/api/', '/@', '/fonts/', '/icons/'].findIndex(s => rel.startsWith(s)) + 1;
            r.httpType = ['document', 'script', 'stylesheet', 'image', 'font', 'fetch', 'xhr', 'other', 'manifest', 'media'].indexOf(type) + 1;
            r.httpSuffix = ['.css', '.js', '.svg', '.png', '.webp', '.ico', '.woff2', '.woff', '.json', '.js.map', '.webmanifest'].findIndex(s => path.endsWith(s)) + 1;
            r.httpFlags = +rel.includes('?') + 2 * +(method === 'GET') + 4 * +!!req.redirectedFrom() + 8 * +!!issued + 16 * +!!staticMime(rel, type);
          }
          if (reason === 23 && !closing && !r.rpcStep) {
            const ep = dest.slice((base + '/api/').length), [ns, op] = ep.split('/');
            r.rpcStep = step;
            r.rpcNamespace = ['settings','credentials','llm','session','workspace','account','web','remoteAccess','terminal','dynamicCordisRunner','agentPresets','job','permissionPresets','pluginManager','productAnalytics','model','subagent','subagents','app','webServer','theme','uiSettings','connection','sandbox','directoryPicker','feedback','workspaceController','sessionQuery','schedule','goal'].indexOf(ns) + 1;
            r.rpcOp = ['list','get','catalog','describe','status','inspect','getState','listProviders','getProfile','watch','query','listModels','getSettings','capabilities','hasRunningAccountTasks','getPolicy','getStatus','getCapabilities'].indexOf(op) + 1;
            r.rpcIndex = Object.keys(endpoints).indexOf(ep) + 1;
            r.rpcShape = +(method === 'POST') + 2 * +(type === 'fetch') + 4 * +(req.headers()['content-type'] === 'application/json');
            try { const f = JSON.parse(req.postData()); r.rpcArgs = +keys(f,'type','rpcId','method','payload') + 2 * +uuid(f.rpcId) + 4 * +(f.method === ep) + 8 * +named(f.payload) + 16 * +rpcIds.has(f.rpcId); } catch (_) { /* no diagnostic content */ }
          }
          if (!closing) await deny(route, reason); else await quietClose(route);
        }
      });
      p = await context.newPage();
      p.setDefaultTimeout(12000); p.setDefaultNavigationTimeout(20000);
      p.on('download', file => { r.blocked++; fault(21); void file.cancel().catch(() => {}); });
      const cdp = await context.newCDPSession(p);
      // ExtraInfo can arrive before requestWillBeSent. Store only the comparison result,
      // never a header/cookie/body, for either ordering. Mocked fetches are not wire evidence.
      const wanted = new Set(), before = new Map(), other = new Set();
      const take = valid => { if (valid) r.wireChecks++; else fault(27); };
      cdp.on('Network.requestWillBeSent', e => {
        if (!simulated && e.request.url === statusUrl && e.request.method === 'POST') {
          if (before.has(e.requestId)) { take(before.get(e.requestId)); before.delete(e.requestId); } else wanted.add(e.requestId);
        } else if (!before.delete(e.requestId)) other.add(e.requestId);
      });
      cdp.on('Network.requestWillBeSentExtraInfo', e => {
        if (other.delete(e.requestId)) return;
        const h = e.headers, get = name => h[Object.keys(h).find(k => k.toLowerCase() === name)];
        const valid = !!issued && get('origin') === base && get('sec-fetch-site') === 'same-origin'
          && (get('host') || get(':authority')) === base.slice(7) && Object.keys(h).some(k => k.toLowerCase() === 'cookie');
        if (wanted.delete(e.requestId)) take(valid); else before.set(e.requestId, valid);
      });
      await cdp.send('Network.enable');
      const until = async test => {
        const end = Date.now() + 12000;
        while (!(await test())) { check(!r.failedStep && Date.now() < end); await p.waitForTimeout(40); }
        check(!r.failedStep);
      };
      step = 3;
      // A no-content navigation may reject in Chromium. It must leave about:blank intact.
      let entryResponse;
      try { entryResponse = await p.goto(url, { waitUntil: 'commit' }); }
      catch (error) { check(typeof error.message === 'string' && error.message.includes('net::ERR_ABORTED')); }
      await until(() => issued);
      check((!entryResponse || entryResponse.status() === 204) && p.url() === 'about:blank');
      step = 4;
      const gotoClean = async reload => {
        const res = reload ? await p.reload({ waitUntil: 'domcontentloaded' }) : await p.goto(root, { waitUntil: 'domcontentloaded' });
        check(res && res.status() === 200 && res.url() === root && p.url() === root);
      };
      await gotoClean(false);
      const button = (scope, name) => scope.getByRole('button', { name, exact: true });
      const dialog = p.locator('[role="dialog"][data-shortcut-modal="settings"]');
      const card = dialog.getByRole('region', { name: t.title, exact: true });
      const visible = async locator => { await locator.waitFor({ state: 'visible' }); check(await locator.count() === 1); };
      const say = (scope, name) => visible(scope.getByText(name, { exact: true }));
      const open = async () => {
        const account = p.getByRole('button', { name: t.account, exact: true, includeHidden: true });
        await account.waitFor({ state: 'attached' });
        const collapsed = p.locator('[data-sidebar-drawer][data-sidebar-collapsed]');
        if (await collapsed.count()) { await button(p.locator('[data-shell-leading]'), t.open).click(); await collapsed.waitFor({ state: 'detached' }); }
        else if (!await account.isVisible()) await button(p, t.open).click();
        await account.click(); await p.getByRole('menuitem', { name: t.settings, exact: true }).click();
        await visible(dialog);
        const models = button(dialog.getByRole('navigation'), t.models);
        await models.click(); check(await models.getAttribute('aria-current') === 'true');
        await visible(card); check(await card.getAttribute('class').then(s => (s || '').split(/\s+/).includes('dsh-agy-native-trial')));
      };
      const out = async baseline => {
        await say(card.getByRole('status'), t.out);
        await until(() => r.realStatus > baseline && r.signedOutResponses === r.realStatus && r.wireChecks === r.realStatus);
        await visible(button(card, t.login)); await visible(button(card, t.check));
        check(await button(card, t.login).isEnabled() && await button(card, t.check).isEnabled()
          && await card.getByRole('button').count() === 2 && await dialog.getByRole('button', { name: /Google/i }).count() === 1
          && await card.locator('input,textarea,[contenteditable=true]').count() === 0 && await dialog.locator('input[type=password]').count() === 0);
        await say(card, t.consent); await say(card, t.privacy);
        check((await p.locator('html').getAttribute('lang')) === t.lang);
      };
      const layout = async () => {
        step = 15; r.layoutCheck = 1;
        await card.scrollIntoViewIfNeeded(); r.layoutCheck = 2;
        const v = await card.evaluate((el, dark) => {
          const bounds = el.getBoundingClientRect(), buttons = [...el.querySelectorAll('button')], tol = 1;
          const rects = buttons.map(b => b.getBoundingClientRect());
          const parts = [bounds.width > 0 && bounds.left >= -tol && bounds.right <= innerWidth + tol && el.scrollWidth <= el.clientWidth + tol,
            buttons.every((b, i) => { const x = rects[i]; return x.width > 0 && x.height >= 31 && x.left >= bounds.left - tol && x.right <= bounds.right + tol
              && b.scrollWidth <= b.clientWidth + tol && b.scrollHeight <= b.clientHeight + tol; }),
            rects.every((a, i) => rects.slice(i + 1).every(b => a.right <= b.left + tol || b.right <= a.left + tol || a.bottom <= b.top + tol || b.bottom <= a.top + tol)),
            !buttons.length || getComputedStyle(buttons[0].parentElement).flexWrap === 'wrap',
            matchMedia('(prefers-color-scheme: dark)').matches === dark && document.body.hasAttribute('data-ds-dark-theme') === dark,
            dark ? innerWidth === 320 : innerWidth > 767];
          const failed = parts.indexOf(false), layoutError = failed < 0 ? 0 : 3 + failed;
          if (!dark) return { layoutError, contrast: 0, node: 0 };
          const rgba = s => s.match(/[\d.]+/g).map(Number);
          const blend = (c, bg) => c.slice(0, 3).map((v, i) => v * (c[3] ?? 1) + bg[i] * (1 - (c[3] ?? 1)));
          const background = n => { const nodes = []; for (; n; n = n.parentElement) nodes.unshift(n);
            return nodes.reduce((bg, a) => blend(rgba(getComputedStyle(a).backgroundColor), bg), [255, 255, 255]); };
          const lum = rgb => rgb.map(c => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }).reduce((n, c, i) => n + c * [0.2126, 0.7152, 0.0722][i], 0);
          const nodes = [...el.querySelectorAll('strong,p,button')].filter(n => n.getClientRects().length && !n.disabled);
          const ratios = nodes.map(n => { const bg = background(n), a = lum(bg), b = lum(blend(rgba(getComputedStyle(n).color), bg)); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); });
          const min = Math.min(...ratios), least = nodes[ratios.indexOf(min)];
          const node = !least ? 0 : least.matches('strong') ? 1 : least.matches('[role=alert]') ? 2 : least.matches('button') ? 3 : least.closest('[role=status]') ? 4 : 5;
          return { layoutError, node, contrast: document.body.hasAttribute('data-ds-dark-theme') && lum(background(el)) < 0.35 && ratios.length ? Math.floor(100 * min) : 0 };
        }, zh);
        r.layoutCheck = v.layoutError; check(!r.layoutCheck);
        if (zh) {
          r.narrowChecks++;
          if (!(v.contrast >= 450)) { r.layoutCheck = 9; r.layoutNode = v.node; r.layoutContrastX100 = v.contrast; }
          check(v.contrast >= 450); r.darkContrastX100 = Math.min(r.darkContrastX100 || v.contrast, v.contrast);
        }
      };
      step = 5; let baseline = r.realStatus; await open();
      step = 6; await out(baseline); await layout();
      // Keep the capture inside a verified, fully visible signed-out card. Return no DOM text.
      await p.evaluate(async () => { await document.fonts.ready; });
      await card.scrollIntoViewIfNeeded();
      check(await card.evaluate((el, expected) => {
        const kids = [...el.children];
        if (kids.map(n => n.tagName).join(',') !== 'STYLE,STRONG,DIV,P,P,DIV' || kids[0].getClientRects().length
          || kids[2].getAttribute('role') !== 'status' || kids[2].childElementCount !== 1 || kids[2].firstElementChild.tagName !== 'P'
          || kids[5].childElementCount !== 2 || ![...kids[5].children].every(n => n.matches('button[type="button"]:enabled'))) return false;
        const leaves = [kids[1], kids[2].firstElementChild, kids[3], kids[4], ...kids[5].children];
        if (leaves.some((n, i) => n.childElementCount || n.innerText !== expected[i] || n.isContentEditable)) return false;
        const allowed = new Set(leaves);
        const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n; (n = walk.nextNode());) if (n.parentElement !== kids[0] && !allowed.has(n.parentElement) && n.data.trim()) return false;
        const box = el.getBoundingClientRect(), dim = document.documentElement, tol = 0.75;
        const within = (a, b) => a.left >= b.left - tol && a.right <= b.right + tol && a.top >= b.top - tol && a.bottom <= b.bottom + tol;
        if (!within(box, { left: 0, top: 0, right: dim.clientWidth, bottom: dim.clientHeight })) return false;
        for (let a = el.parentElement; a; a = a.parentElement) {
          const s = getComputedStyle(a), b = a.getBoundingClientRect();
          if (['auto', 'hidden', 'scroll', 'clip'].includes(s.overflowY) && (box.top < b.top + a.clientTop - tol || box.bottom > b.top + a.clientTop + a.clientHeight + tol)) return false;
          if (['auto', 'hidden', 'scroll', 'clip'].includes(s.overflowX) && (box.left < b.left + a.clientLeft - tol || box.right > b.left + a.clientLeft + a.clientWidth + tol)) return false;
        }
        const drawn = [el, ...el.querySelectorAll(':not(style)')];
        if (drawn.some(n => !n.checkVisibility({ opacityProperty: true, visibilityProperty: true }) || n.shadowRoot || n.isContentEditable
          || n.hasAttribute('title') || getComputedStyle(n).backgroundImage !== 'none'
          || ['::before', '::after'].some(part => !['none', 'normal', '""'].includes(getComputedStyle(n, part).content)))) return false;
        // Include pointer-transparent overlays in hit tests, without changing what is painted.
        const probe = document.createElement('style');
        probe.textContent = '*, *::before, *::after { pointer-events: auto !important; }';
        document.head.append(probe);
        try {
          const hit = (x, y) => document.elementFromPoint(x, y);
          const radius = Math.max(...['TopLeft', 'TopRight', 'BottomLeft', 'BottomRight'].map(k => parseFloat(getComputedStyle(el)['border' + k + 'Radius']) || 0));
          const covered = (x, y) => {
            const at = hit(x, y);
            if (el.contains(at)) return true;
            const cx = Math.max(box.left + radius, Math.min(x, box.right - radius)), cy = Math.max(box.top + radius, Math.min(y, box.bottom - radius));
            return (x - cx) ** 2 + (y - cy) ** 2 >= (radius - 1) ** 2 && !!at && at.contains(el);
          };
          for (let y = box.top + 1; y < box.bottom; y += 6) for (let x = box.left + 1; x < box.right; x += 6) if (!covered(x, y)) return false;
          for (const n of leaves) {
            const b = n.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(n);
            const lines = [...range.getClientRects()];
            if (b.width <= 0 || b.height <= 0 || !within(b, box) || !lines.length || lines.some(q => q.width <= 0 || q.height <= 0 || !within(q, b)
              || [0.06, 0.5, 0.94].some(f => !n.contains(hit(q.left + q.width * f, q.top + q.height * 0.5))))) return false;
          }
          return true;
        } finally { probe.remove(); }
      }, [t.title, t.out, t.consent, t.privacy, t.login, t.check]));
      check(!r.failedStep && p.url() === root);
      r.verifiedCards++;
      /* VERIFIED_CARD */
      step = 7; baseline = r.realStatus; await button(card, t.check).click(); await out(baseline); r.manualChecks++;
      step = 8; await p.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
      baseline = r.realStatus; await open(); await out(baseline); r.reopens++;
      step = 9; baseline = r.realStatus; await gotoClean(true); await open(); await out(baseline); r.reloads++;
      simulated = true;
      step = 10; ticket = 'wait'; await button(card, t.login).click();
      await say(card.getByRole('status'), t.wait); await visible(button(card, t.cancel)); check(!ticket);
      step = 11; baseline = r.mockStatus; await until(() => r.mockStatus > baseline); r.autoPolls++;
      step = 12; ticket = 'cancel'; await button(card, t.cancel).click(); await say(card.getByRole('status'), t.out); check(!ticket);
      baseline = r.mockStatus; await p.waitForTimeout(1150); check(r.mockStatus === baseline && !r.failedStep);
      step = 13; ticket = 'error'; await button(card, t.login).click();
      const alert = card.getByRole('alert'); await visible(alert); check(await alert.evaluate((a, value) => a.innerText === value, t.error));
      await visible(button(card, t.retry)); check(!ticket && await button(card, t.retry).isEnabled()); await layout();
      step = 14; ticket = 'connected'; await button(card, t.retry).click(); await say(card.getByRole('status'), t.connected); await say(card, t.next);
      check(!ticket && await card.getByRole('button').count() === 0); r.connected++; await layout();
      step = 16; check(!r.failedStep && p.url() === root && seenPages === 1); closing = true; await context.close(); ctx = null;
    }
    check(!r.failedStep && r.exchanges === 2 && r.cleanLoads >= 4 && r.assets > 0 && r.rpc > 0 && r.streams > 0
      && r.realStatus >= 8 && r.signedOutResponses === r.realStatus && r.wireChecks === r.realStatus
      && r.manualChecks === 2 && r.reopens === 2 && r.reloads === 2 && r.autoPolls === 2
      && r.mockLogin === 6 && r.mockCancel === 2 && r.connected === 2 && r.verifiedCards === 2 && r.narrowChecks >= 3 && r.darkContrastX100 >= 450);
    r.ok = 1;
  } catch (_) { fault(step); }
  finally { if (ctx) { closing = true; try { await ctx.close(); } catch (_) { fault(16); } } }
  return r;
}
