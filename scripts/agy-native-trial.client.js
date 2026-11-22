window.__ModuleLoader__.load({
  id: 'dsh-agy-native-trial',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const namespace = 'agy-native-trial';
    const pollMs = 1_000;
    const loginMs = 10 * 60_000;
    const requestMs = 15_000;
    const copy = {
      zh: {
        title: 'Gemini（Google Antigravity）',
        checking: '正在检查官方 agy 登录状态…',
        signedOut: '尚未连接官方 agy。',
        signingIn: '请在官方 agy 打开的浏览器中完成 Google 登录，完成后这里会自动更新。',
        connected: '已连接官方 agy',
        nextStep: '关闭设置后，在模型菜单中选择 Antigravity。',
        consent: '官方 agy 可能与 Windows 上其他 Antigravity 共用登录状态。点击“使用 Google 登录”即表示你同意由官方 agy 发起登录。',
        privacy: '官方 agy 会自行打开浏览器；无需在 DSH 输入密码或 token。',
        login: '使用 Google 登录',
        retryLogin: '重试 Google 登录',
        starting: '正在启动官方登录…',
        cancel: '取消登录',
        cancelling: '正在取消登录…',
        checkAgain: '重新检查状态',
        unavailable: '当前无法启动官方 agy 登录，请重新检查状态后重试。',
        failed: '暂时无法确认官方 agy 的登录状态，请重新检查状态。',
        retryFailed: '官方 agy 登录失败，请重试 Google 登录。',
        timedOut: '登录等待已达 10 分钟，已停止自动检查。可重新检查状态，或取消登录后重试。',
        hostTimeout: '官方 agy 登录超时，请重试登录。',
      },
      en: {
        title: 'Gemini (Google Antigravity)',
        checking: 'Checking official agy sign-in status…',
        signedOut: 'Not connected to official agy.',
        signingIn: 'Complete Google sign-in in the browser opened by official agy. This card will update automatically.',
        connected: 'Connected to official agy',
        nextStep: 'Close Settings, then select Antigravity from the model menu.',
        consent: 'Official agy may share sign-in with other Antigravity apps on Windows. Clicking “Log in with Google” authorizes official agy to start sign-in.',
        privacy: 'Official agy opens the browser itself. No password or token is entered in DSH.',
        login: 'Log in with Google',
        retryLogin: 'Retry Google sign-in',
        starting: 'Starting official sign-in…',
        cancel: 'Cancel sign-in',
        cancelling: 'Cancelling sign-in…',
        checkAgain: 'Check status again',
        unavailable: 'Official agy sign-in cannot start right now. Check the status again to retry.',
        failed: 'Could not confirm the official agy sign-in status. Check the status again.',
        retryFailed: 'Official agy sign-in failed. Try signing in with Google again.',
        timedOut: 'Stopped automatic checks after 10 minutes. Check the status again, or cancel sign-in and retry.',
        hostTimeout: 'Official agy sign-in timed out. Try signing in again.',
      },
    };
    const css = `
      .dsh-agy-native-trial {
        display: flex; flex-direction: column; gap: 10px; min-width: 0;
        padding: 16px; margin-top: 12px; overflow-wrap: anywhere;
        color: var(--dsw-alias-label-primary);
        background: var(--dsw-alias-settings-card-fill);
        border: .5px solid var(--dsw-alias-settings-card-stroke);
        border-radius: var(--dsw-radius-xl); font: inherit;
      }
      .dsh-agy-native-trial p { margin: 0; font-size: 13px; line-height: 1.6; }
      .dsh-agy-native-trial__note { color: var(--dsw-alias-label-secondary); }
      .dsh-agy-native-trial__error, .dsh-agy-native-trial__connected {
        color: var(--dsw-alias-label-primary); padding-inline-start: 8px;
        border-inline-start: 3px solid var(--dsw-alias-state-error-primary);
      }
      .dsh-agy-native-trial__connected { border-inline-start-color: var(--dsw-alias-state-success-primary); }
      .dsh-agy-native-trial__actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .dsh-agy-native-trial button {
        appearance: none; font: inherit; font-size: 13px; font-weight: 500;
        padding: 7px 12px; min-height: 32px; max-width: 100%; white-space: normal;
        border-radius: var(--dsw-radius-md); cursor: pointer;
        color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2);
        border: 1px solid var(--dsw-alias-border-l3);
      }
      .dsh-agy-native-trial button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-solid); }
      .dsh-agy-native-trial button.dsh-agy-native-trial__login {
        color: var(--dsw-alias-label-primary-foreground); background: var(--dsw-alias-button-primary-fill); border-color: transparent;
      }
      .dsh-agy-native-trial button.dsh-agy-native-trial__login:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
      .dsh-agy-native-trial button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
      .dsh-agy-native-trial button:disabled { cursor: default; opacity: .5; }
    `;

    // Accept only the public status fields; never retain or display raw errors.
    async function request(action, signal) {
      const response = await fetch('/__agy_trial_auth', {
        method: 'POST', mode: 'same-origin', credentials: 'same-origin',
        cache: 'no-store', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ action }), signal,
      });
      if (!response.ok) throw new Error('unavailable');
      const value = await response.json();
      if (!value || !['signed-out', 'signing-in', 'connected', 'error'].includes(value.status)
        || typeof value.canLogin !== 'boolean') throw new Error('unavailable');
      return {
        status: value.status, canLogin: value.canLogin,
        error: value.error === 'TIMEOUT' ? 'hostTimeout' : 'failed',
      };
    }

    function SignInCard({ t }) {
      const [view, setView] = React.useState({ status: 'loading', canLogin: false });
      const [pending, setPending] = React.useState(null);
      const [notice, setNotice] = React.useState(null);
      const actions = React.useRef(null);
      React.useEffect(() => {
        let live = true;
        let current = { status: 'loading', canLogin: false };
        let operation;
        let pollTimer;
        let loginTimer;
        let deadline = 0;
        const clearPoll = () => { clearTimeout(pollTimer); pollTimer = undefined; };
        const stopWindow = () => {
          clearPoll(); clearTimeout(loginTimer); loginTimer = undefined; deadline = 0;
        };
        const abortOperation = () => {
          if (!operation) return;
          clearTimeout(operation.timer);
          operation.controller.abort();
          operation = undefined;
        };
        const expire = () => {
          clearPoll(); clearTimeout(loginTimer); loginTimer = undefined;
          if (!live || current.status !== 'signing-in') return;
          if (operation?.action === 'status') { abortOperation(); setPending(null); }
          setNotice('timedOut');
        };
        const watchWindow = () => {
          if (current.status !== 'signing-in') { stopWindow(); return; }
          if (!deadline) deadline = Date.now() + loginMs;
          if (Date.now() >= deadline) { expire(); return; }
          if (loginTimer === undefined) loginTimer = setTimeout(expire, deadline - Date.now());
        };
        const schedulePoll = () => {
          clearPoll();
          if (live && current.status === 'signing-in' && deadline > Date.now()) {
            pollTimer = setTimeout(() => { void perform('status', true); }, pollMs);
          }
        };
        async function perform(action, polling = false) {
          if (!live || (operation && (operation.action !== 'status' || action === 'status'))) return;
          if (action === 'login' && (!current.canLogin || current.status === 'signing-in' || current.status === 'connected')) return;
          if (action === 'cancel' && current.status !== 'signing-in') return;
          clearPoll();
          // Explicit cancellation may supersede an in-flight read, never a mutation.
          abortOperation();
          const active = { action, controller: new AbortController(), timer: undefined };
          operation = active;
          setPending(action);
          if (!polling) setNotice(null);
          if (action === 'login') {
            stopWindow();
            current = { status: 'signing-in', canLogin: false };
            setView(current);
            watchWindow();
          }
          active.timer = setTimeout(() => { active.controller.abort(); }, requestMs);
          try {
            const result = await request(action, active.controller.signal);
            if (!live || operation !== active || active.controller.signal.aborted) return;
            current = result;
            setView(result);
            setNotice(result.status === 'error' ? result.error : null);
            watchWindow();
          } catch (error) {
            // Transport failures and unrecognized codes use local copy, never error.message.
            if (!live || operation !== active) return;
            if (current.status === 'loading') {
              current = { status: 'error', canLogin: false };
              setView(current);
            }
            setNotice(deadline && Date.now() >= deadline ? 'timedOut' : 'failed');
          } finally {
            clearTimeout(active.timer);
            if (live && operation === active) {
              operation = undefined;
              setPending(null);
              schedulePoll();
            }
          }
        }
        actions.current = perform;
        // Opening Settings only reads in-memory Host status, with no implicit sign-in.
        void perform('status');
        return () => {
          live = false;
          actions.current = null;
          stopWindow();
          abortOperation();
        };
      }, []);

      const signingIn = view.status === 'signing-in';
      const connected = view.status === 'connected';
      const mutationPending = pending === 'login' || pending === 'cancel';
      const noticeKey = notice === 'failed' && view.status === 'error' && view.canLogin ? 'retryFailed' : notice;
      const button = (key, action, disabled) => h('button', {
        type: 'button', disabled, className: action === 'login' ? 'dsh-agy-native-trial__login' : undefined,
        onClick: () => { void actions.current?.(action); },
      }, t(key));
      return h('section', { className: 'dsh-agy-native-trial', 'aria-label': t('title') },
        h('style', null, css),
        h('strong', null, t('title')),
        h('div', { role: 'status', 'aria-live': 'polite', 'aria-atomic': true },
          view.status === 'loading' && h('p', { className: 'dsh-agy-native-trial__note' }, t('checking')),
          view.status === 'signed-out' && h('p', { className: 'dsh-agy-native-trial__note' }, t('signedOut')),
          signingIn && notice !== 'timedOut' && h('p', { className: 'dsh-agy-native-trial__note' },
            t(pending === 'login' ? 'starting' : pending === 'cancel' ? 'cancelling' : 'signingIn')),
          connected && h('p', { className: 'dsh-agy-native-trial__connected' }, t('connected'))),
        noticeKey && h('p', { className: 'dsh-agy-native-trial__error', role: 'alert' }, t(noticeKey)),
        connected ? h('p', { className: 'dsh-agy-native-trial__note' }, t('nextStep'))
          : h(React.Fragment, null,
            h('p', { className: 'dsh-agy-native-trial__note' }, t('consent')),
            h('p', { className: 'dsh-agy-native-trial__note' }, t('privacy'))),
        !signingIn && !connected && view.status !== 'loading' && !view.canLogin && !notice
          && h('p', { className: 'dsh-agy-native-trial__note' }, t('unavailable')),
        !connected && h('div', { className: 'dsh-agy-native-trial__actions' },
          signingIn ? button(pending === 'cancel' ? 'cancelling' : 'cancel', 'cancel', mutationPending)
            : button(view.status === 'error' ? 'retryLogin' : 'login', 'login', !view.canLogin || pending !== null),
          button('checkAgain', 'status', pending !== null)));
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(namespace, copy), 'agy-native-trial: locale');
        ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
          name: 'settings.models.footer', id: namespace, order: 30, locale: namespace,
        }, SignInCard));
      },
    };
  },
});
