async (page) => {
  const handoff = /* HANDOFF */ null;
  if (handoff === null || !/^http:\/\/127\.0\.0\.1:\d+$/.test(handoff.base)
    || !handoff.url.startsWith(`${handoff.base}/?`)) throw new Error('Use the isolated browser program created by the fixture');
  const browser = page.context().browser();
  if (browser === null) throw new Error('Playwright must allow an isolated browser context');
  const context = await browser.newContext({ viewport: { width: 1480, height: 900 }, locale: 'en-US',
    timezoneId: 'UTC', colorScheme: 'light', serviceWorkers: 'block' });
  let step = 'open';
  const verified = [];
  const failures = [];
  const blockedOrigins = new Set();
  try {
    // Top-level navigation, fonts, media and Client RPC may reach only the fixture listener.
    await context.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith(`${handoff.base}/`)) return route.continue();
      blockedOrigins.add(url.match(/^\w+:\/\/[^/]+/)?.[0] ?? url.split(':', 1)[0]);
      return route.abort();
    });
    const app = await context.newPage();
    app.setDefaultTimeout(12000);
    app.on('pageerror', error => failures.push(error.message));
    const observed = { prompt: 0, select: 0, cancel: 0, create: 0, upload: 0 };
    app.on('request', request => {
      const url = request.url();
      if (!url.startsWith(`${handoff.base}/`) || request.method() !== 'POST') return;
      const pathname = url.slice(handoff.base.length).split('?', 1)[0];
      const paths = { '/api/session/prompt': 'prompt', '/api/session/selectModel': 'select',
        '/api/session/cancel': 'cancel', '/api/session/create': 'create' };
      const event = paths[pathname];
      if (event !== undefined) ++observed[event];
      if (/upload/i.test(pathname)) ++observed.upload;
    });
    const expect = (condition, label) => { if (!condition) throw new Error(label); };
    const poll = async (test, label) => {
      const deadline = Date.now() + 15000;
      do {
        if (await test()) return;
        await app.waitForTimeout(120);
      } while (Date.now() < deadline);
      throw new Error(label);
    };
    const read = async () => {
      const response = await app.request.get(`${handoff.base}${handoff.controlPath}`);
      if (!response.ok()) throw new Error(`Fixture observation failed: ${response.status()}`);
      return response.json();
    };
    const button = name => app.getByRole('button', { name, exact: typeof name === 'string' });
    const menuitem = name => app.getByRole('menuitem', { name, exact: typeof name === 'string' });
    const chat = app.locator('[data-conversation-session]').first();
    const input = app.locator('[data-composer-input][contenteditable="true"]').first();
    const trigger = button(/^Select model/);
    const model = provider => trigger.locator(`[data-provider-id="${provider}"]`);
    const activeModel = provider => model(provider).waitFor();
    const ordinary = 'Synthetic ordinary';
    const antigravity = 'Synthetic Antigravity';
    const acp = 'turn:antigravity';
    const stock = 'ordinary-fixture';
    const stop = button('Stop generating');
    const idle = () => poll(async () => (await read()).agent?.status === 'idle' && !(await stop.isVisible()), 'Turn did not settle');
    const text = value => chat.getByText(value, { exact: true }).waitFor();
    const type = async message => {
      await input.click();
      await app.keyboard.press('ControlOrMeta+A');
      await app.keyboard.type(message);
      await poll(async () => (await input.textContent()).trim() === message, 'Composer did not retain typed text');
    };
    const send = async message => { await type(message); await input.press('Enter'); };
    const menuSelect = async (name, provider) => {
      await trigger.click();
      await menuitem(/^Model\b/).click();
      const target = app.getByRole('menuitemradio', { name, exact: true });
      await target.click();
      await activeModel(provider);
      await target.waitFor({ state: 'hidden' });
      expect(await app.getByRole('dialog').count() === 0, 'Switching opened a confirmation dialog');
    };
    const slashSelect = async (name, provider) => {
      const prompts = observed.prompt;
      await type('/model');
      await app.getByRole('option', { name: /^model\b/i }).first().waitFor();
      await input.press('Enter');
      const popup = app.locator('[aria-label="/model options"]');
      const option = popup.getByRole('option', { name, exact: true });
      await option.waitFor();
      await option.click();
      await activeModel(provider);
      await popup.waitFor({ state: 'hidden' });
      expect(observed.prompt === prompts, '/model was sent as a message');
      expect(await app.getByRole('dialog').count() === 0, '/model opened a confirmation dialog');
    };

    await app.goto(handoff.url, { waitUntil: 'load', timeout: 45000 });
    await input.waitFor({ timeout: 30000 });
    await activeModel(stock);
    const id = await chat.getAttribute('data-conversation-session');
    const same = async () => {
      const state = await read();
      expect((await chat.getAttribute('data-conversation-session')) === id && state.agent?.id === id
        && state.members.length === 1 && state.members[0] === id, 'Model switch changed the Session');
    };
    expect(id?.length > 0, 'No real conversation ID');
    step = 'send ordinary message by keyboard';
    await send('Start in the native conversation');
    await text('Fixture ordinary answer 1');
    await idle();
    await same();
    verified.push('ordinary message by Enter in the native conversation');

    step = 'keep a draft and its staged file while switching';
    await type('Send via native Antigravity');
    await app.evaluate(() => {
      const target = document.querySelector('[data-composer-card]');
      const data = new DataTransfer();
      data.items.add(new File(['Synthetic fixture, no user files.'], 'agy-fixture.txt', { type: 'text/plain' }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    });
    const attachment = app.getByRole('group', { name: 'Pending attachments' }).getByTitle('agy-fixture.txt');
    await attachment.waitFor();
    await menuSelect(antigravity, acp);
    await same();
    await button('Open command menu').waitFor();
    expect(!(await button('Add files or run commands').isVisible()), 'Text-only launcher still advertises files');
    expect((await input.textContent()).trim() === 'Send via native Antigravity', 'Switching erased the draft');
    const promptsBeforeAttachment = observed.prompt;
    await input.press('Enter');
    await app.getByRole('alert').filter({ hasText: 'The selected model only accepts text' }).waitFor();
    expect(await attachment.isVisible() && (await input.textContent()).trim() === 'Send via native Antigravity', 'Rejected draft or attachment disappeared');
    expect(observed.prompt === promptsBeforeAttachment && (await read()).acpPrompts === 0, 'Rejected draft dispatched a prompt');
    await button(/^Remove .*agy-fixture\.txt/).click();
    await attachment.waitFor({ state: 'hidden' });
    step = 'pick the synthetic effort from the native menu and send the preserved draft';
    await trigger.click();
    await menuitem(/^Effort\b/).click();
    await app.getByRole('menuitemradio', { name: 'High', exact: true }).click();
    await button(/^Select model, current Synthetic Antigravity, reasoning effort High$/).waitFor();
    expect((await input.textContent()).trim() === 'Send via native Antigravity', 'Effort selection erased the draft');
    await input.press('Enter');
    await text('Fixture answer aldertrail');
    await idle();
    await same();
    expect((await read()).efforts[0] === 'high', 'Native effort selection did not reach synthetic ACP');
    verified.push('native model and effort selection keep the Session and draft; text-only submissions keep rejected attachments');

    step = 'refuse a typed /file without submitting it as a message';
    const promptsBeforeFile = observed.prompt;
    const uploadsBeforeFile = observed.upload;
    const fileRefusal = app.getByRole('alert').filter({ hasText: 'The selected model only accepts text' });
    await fileRefusal.waitFor({ state: 'hidden' });
    await send('/file');
    await poll(async () => await fileRefusal.isVisible() || observed.prompt !== promptsBeforeFile, 'No response to /file');
    expect(observed.prompt === promptsBeforeFile && observed.upload === uploadsBeforeFile, '/file escaped as a model request or upload');
    expect((await input.textContent()).trim() === '/file', 'Refusal erased the /file draft');
    verified.push('a typed /file was refused locally without sending, uploading, or erasing its draft');

    step = 'switch back using the native /model picker';
    await slashSelect(ordinary, stock);
    await same();
    await send('Run one more ordinary turn');
    await text('Fixture ordinary answer 2');
    await idle();
    await same();
    verified.push('/model keyboard invocation returns to the ordinary model in the same Session');

    step = 'hold ACP open, enqueue a message, and retain queue on a rejected switch';
    await app.emulateMedia({ colorScheme: 'dark' });
    await slashSelect(antigravity, acp);
    await send('Hold the synthetic turn');
    await text('Fixture partial before Stop');
    await stop.waitFor();
    await send('Keep this in the native queue');
    const queue = app.locator('[data-queue-dock]');
    await queue.getByText('Keep this in the native queue', { exact: true }).waitFor();
    expect((await read()).agent.queue === 1 && (await read()).acpPrompts === 2, 'Queue entry was dispatched early');
    expect(await queue.getByRole('button', { name: 'Steer queued message' }).count() === 0, 'Queue offered to steer a whole-turn executor');
    await trigger.click();
    await menuitem(/^Model\b/).click();
    await app.getByRole('menuitemradio', { name: ordinary, exact: true }).click();
    await activeModel(acp);
    await app.getByRole('alert').filter({ hasText: /queue|queued/i }).waitFor();
    await app.keyboard.press('Escape');
    await app.keyboard.press('Escape');
    await queue.getByRole('button', { name: 'Remove queued message', exact: true }).click();
    await queue.waitFor({ state: 'hidden' });
    verified.push('while ACP streams, native queue does not steer or let a model change retarget a queued message');

    step = 'switch while streaming and stop the original ACP turn';
    await menuSelect(ordinary, stock);
    expect((await read()).agent.running === acp, 'Model switch moved the running turn');
    await same();
    await stop.click();
    await idle();
    await text('Fixture partial before Stop');
    expect((await read()).cancellations === 1 && observed.cancel === 1, 'Stop did not cancel the original ACP prompt exactly once');
    await send('Continue in the ordinary model after Stop');
    await text('Fixture ordinary answer 3');
    await idle();
    await same();
    verified.push('switching while streaming keeps Stop with ACP and preserves partial text; the next prompt goes to the ordinary model');

    step = 'find the ACP text and pin and archive the existing Session';
    await button('Search sessions').click();
    await app.getByRole('textbox', { name: 'Search session names', exact: true }).fill('aldertrail');
    const hit = app.getByRole('tree', { name: 'Search results' }).getByRole('treeitem');
    await hit.waitFor();
    expect(await hit.count() === 1, 'Search did not return exactly one Session');
    await hit.click();
    await same();
    await text('Fixture answer aldertrail');
    // Return to the ordinary sidebar list if selecting the result leaves the search expanded.
    const clear = button('Clear search');
    if (await clear.isVisible()) await clear.click();
    const row = app.locator(`[data-row-key="session:${id}"]`).first();
    const actions = row.getByRole('button', { name: /^Session actions for / });
    await row.hover();
    await actions.click();
    await menuitem('Pin session').click();
    await poll(async () => (await read()).pinned.includes(id), 'Host did not pin the exact Session');
    await row.hover();
    await actions.click();
    await menuitem('Archive session').click();
    await poll(async () => (await read()).archived.includes(id), 'Host did not archive the exact Session');
    await row.waitFor({ state: 'hidden' });
    await button('View options').click();
    await menuitem('All conversations (show archived)').click();
    await row.waitFor();
    verified.push('assistant-body search found the exact Session; native pin, archive and archived filter worked');

    step = 'verify trace';
    const trace = await read();
    expect(trace.bound === 1 && trace.ordinaryPrompts === 3 && trace.acpPrompts === 2 && trace.handoff, 'Routing, context handoff, or official Session reuse differs');
    expect(failures.length === 0, 'Browser reported a JavaScript exception');
    expect(blockedOrigins.size === 0, 'Browser attempted to leave the isolated test origin');
    expect(observed.create === 1, 'Native page created another Session');
    return { passed: true, verified, trace, observed, pageErrors: failures, blockedOrigins: [...blockedOrigins] };
  } catch (error) {
    const message = String(error.message).split(handoff.url).join(handoff.base);
    const app = context.pages().at(-1);
    const snapshot = await app?.locator('body').ariaSnapshot({ timeout: 1500 }).catch(() => '') ?? '';
    return { passed: false, step, verified, message: message.slice(0, 1400),
      snapshot: snapshot.split(handoff.url).join(handoff.base).slice(-9000), pageErrors: failures, blockedOrigins: [...blockedOrigins] };
  } finally {
    await context.close();
  }
}
