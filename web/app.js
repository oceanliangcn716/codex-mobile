(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    app: $('app'),
    menu: $('menu'),
    heading: $('heading'),
    title: $('title'),
    connection: $('connection'),
    newButton: $('new'),
    more: $('more'),
    banner: $('banner'),
    messages: $('messages'),
    bottom: $('bottom'),
    requests: $('requests'),
    composer: $('composer'),
    prompt: $('prompt'),
    modelButton: $('model-button'),
    draftStatus: $('draft-status'),
    keyboard: $('keyboard'),
    send: $('send'),
    stop: $('stop'),
    usageBar: $('usage-bar'),
    usageOpen: $('usage-open'),
    usageFiveValue: $('usage-five-value'),
    usageFiveFill: $('usage-five-fill'),
    usageWeeklyValue: $('usage-weekly-value'),
    usageWeeklyFill: $('usage-weekly-fill'),
    usageDialog: $('usage-dialog'),
    usageClose: $('usage-close'),
    usageFiveDetailValue: $('usage-five-detail-value'),
    usageFiveDetailFill: $('usage-five-detail-fill'),
    usageFiveReset: $('usage-five-reset'),
    usageWeeklyDetailValue: $('usage-weekly-detail-value'),
    usageWeeklyDetailFill: $('usage-weekly-detail-fill'),
    usageWeeklyReset: $('usage-weekly-reset'),
    usageUpdated: $('usage-updated'),
    usageStatus: $('usage-status'),
    usageRefresh: $('usage-refresh'),
    backdrop: $('backdrop'),
    drawer: $('drawer'),
    closeDrawer: $('close-drawer'),
    search: $('search'),
    drawerNew: $('drawer-new'),
    threads: $('threads'),
    projectFilter: $('project-filter'),
    attach: $('attach'), attachments: $('attachments'), attachmentMenu:$('attachment-menu'),
    addPhoto:$('add-photo'), addFile:$('add-file'), photoInput:$('photo-input'), fileInput:$('file-input'),
    loadMore: $('load-more'),
    hostLabel: $('host-label'),
    refresh: $('refresh'),
    settings: $('settings'),
    project: $('project'),
    model: $('model'),
    effort: $('effort'),
    providerNote: $('provider-note'),
    applySettings: $('apply-settings'),
    pairing: $('pairing'),
    pairForm: $('pair-form'),
    pairUrl: $('pair-url'),
    pairSubmit: $('pair-submit'),
    pairError: $('pair-error'),
    toast: $('toast')
  };

  const appState = {
    currentId: null,
    currentThread: null,
    threads: [],
    projects: [],
    models: [],
    config: { model: '', effort: '', provider: '' },
    connected: { desktop: false, engine: false },
    cursor: null,
    threadCache: new Map(),
    dirtyThreads: new Set(),
    olderCursors: new Map(),
    selected: { model: '', effort: '', cwd: '' },
    requestAnswers: new Map(),
    requestsSignature:'',
    submittedRequests:new Set(), submittingRequests:new Set(),
    attachmentDrafts:new Map(), projectFilter:'',
    uploadCount:0,
    sendBusy: false,
    stopBusy: false,
    settingsBusy: false,
    pairBusy: false,
    stateBusy: false,
    stateReloadPending:false,
    listBusy: false,
    eventSource: null,
    eventOpen: false,
    eventAuthProbeDone: false,
    usage: null,
    usagePromise: null,
    usageReloadPending: false,
    usageReloadForce: false,
    threadRefreshTimer: 0,
    stateRefreshTimer: 0,
    toastTimer: 0,
    isInitialRender: true,
    draftTimer: 0,
    wideLayout: null
  };

  const DRAFT_PREFIX = 'codex-mobile-draft:';

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }

  function jsonHeaders() {
    return { Accept: 'application/json', 'Content-Type': 'application/json' };
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...options,
      headers: { ...jsonHeaders(), ...(options.headers || {}) }
    });

    let data = null;
    const text = await response.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (_error) {
        data = { message: text };
      }
    }

    if (response.status === 401) {
      showPairing();
      throw new ApiError('需要配对', 401);
    }
    if (!response.ok) {
      const message = data && typeof data.message === 'string'
        ? data.message
        : data && typeof data.error === 'string'
          ? data.error
          : `请求失败（${response.status}）`;
      throw new ApiError(message, response.status);
    }
    return data;
  }

  function encodeQuery(params) {
    const query = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== '') query.set(key, value);
    });
    const text = query.toString();
    return text ? `?${text}` : '';
  }

  function showToast(message, duration = 3200) {
    if (!message) return;
    els.toast.textContent = message;
    els.toast.hidden = false;
    window.clearTimeout(appState.toastTimer);
    appState.toastTimer = window.setTimeout(() => {
      els.toast.hidden = true;
    }, duration);
  }

  function apiErrorMessage(error, fallback) {
    return error instanceof ApiError && error.status !== 401 && error.message ? error.message : fallback;
  }

  function usageGateOpen() {
    return appState.config && appState.config.officialQuotaEligible === true;
  }

  function closeUsageDialog() {
    if (!els.usageDialog) return;
    if (els.usageDialog.open) {
      try { els.usageDialog.close(); } catch (_error) { els.usageDialog.removeAttribute('open'); }
    } else {
      els.usageDialog.removeAttribute('open');
    }
    if (els.usageOpen) els.usageOpen.setAttribute('aria-expanded', 'false');
  }

  function hideUsage() {
    if (els.usageBar) els.usageBar.hidden = true;
    closeUsageDialog();
  }

  function normalizeUsageWindow(value) {
    const source = value && typeof value === 'object' ? value : {};
    const rawPercent = source.remainingPercent;
    const remainingPercent = typeof rawPercent === 'number' && Number.isFinite(rawPercent)
      ? Math.max(0, Math.min(100, rawPercent))
      : null;
    const rawReset = source.resetsAt;
    const resetsAt = typeof rawReset === 'number' && Number.isFinite(rawReset) ? rawReset : null;
    return { remainingPercent, resetsAt };
  }

  function normalizeUsage(data) {
    if (!data || typeof data !== 'object' || data.visible !== true) {
      const reason = ['relay', 'api-key', 'not-signed-in', 'unavailable'].includes(data && data.reason)
        ? data.reason
        : 'unavailable';
      return { visible: false, reason, status: 'unavailable', updatedAt: null, windows: { fiveHour: null, weekly: null } };
    }
    const status = data.status === 'ready' ? 'ready' : 'unavailable';
    const windows = data.windows && typeof data.windows === 'object' ? data.windows : {};
    const rawUpdated = data.updatedAt;
    const updatedAt = typeof rawUpdated === 'number' && Number.isFinite(rawUpdated) ? rawUpdated : null;
    return {
      visible: true,
      status,
      updatedAt,
      windows: {
        fiveHour: windows.fiveHour ? normalizeUsageWindow(windows.fiveHour) : null,
        weekly: windows.weekly ? normalizeUsageWindow(windows.weekly) : null
      }
    };
  }

  function formatBeijingTime(value, unit = 'ms') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
    const milliseconds = unit === 's' ? value * 1000 : value;
    const date = new Date(milliseconds);
    if (Number.isNaN(date.getTime())) return '—';
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric', month: 'numeric', day: 'numeric',
        hour: '2-digit', minute: '2-digit'
      }).format(date);
    } catch (_error) {
      return date.toISOString().slice(0, 16).replace('T', ' ');
    }
  }

  function renderUsageWindow(value, valueElement, fillElement, label) {
    const percent = value && typeof value.remainingPercent === 'number' ? value.remainingPercent : null;
    const text = percent === null ? '—' : `${percent}%`;
    valueElement.textContent = text;
    fillElement.style.width = percent === null ? '0%' : `${percent}%`;
    const windowElement = valueElement.closest('.usage-window');
    if (windowElement) {
      windowElement.classList.toggle('unavailable', percent === null);
      windowElement.setAttribute('aria-label', `${label}剩余${text}`);
    }
  }

  function renderUsage() {
    const usage = appState.usage;
    if (!usageGateOpen() || !usage || usage.visible !== true) {
      hideUsage();
      return;
    }
    els.usageBar.hidden = false;
    renderUsageWindow(usage.windows.fiveHour, els.usageFiveValue, els.usageFiveFill, '5小时');
    renderUsageWindow(usage.windows.weekly, els.usageWeeklyValue, els.usageWeeklyFill, '每周');
    renderUsageWindow(usage.windows.fiveHour, els.usageFiveDetailValue, els.usageFiveDetailFill, '5小时');
    renderUsageWindow(usage.windows.weekly, els.usageWeeklyDetailValue, els.usageWeeklyDetailFill, '每周');
    const fiveHour = usage.windows.fiveHour;
    const weekly = usage.windows.weekly;
    els.usageFiveDetailValue.textContent = fiveHour && fiveHour.remainingPercent !== null ? `${fiveHour.remainingPercent}%` : '—';
    els.usageWeeklyDetailValue.textContent = weekly && weekly.remainingPercent !== null ? `${weekly.remainingPercent}%` : '—';
    els.usageFiveReset.textContent = `重置：${fiveHour ? formatBeijingTime(fiveHour.resetsAt, 's') : '—'}（北京时间）`;
    els.usageWeeklyReset.textContent = `重置：${weekly ? formatBeijingTime(weekly.resetsAt, 's') : '—'}（北京时间）`;
    els.usageUpdated.textContent = usage.updatedAt === null
      ? '更新时间：—'
      : `更新时间：${formatBeijingTime(usage.updatedAt)}（北京时间）`;
    els.usageStatus.textContent = usage.status === 'ready' ? '' : '额度暂时不可用，请稍后重试。';
  }

  function syncUsageGate() {
    if (!usageGateOpen()) {
      appState.usage = null;
      hideUsage();
      return;
    }
    if (appState.usage && appState.usage.visible === true) renderUsage();
  }

  function applyUsage(data) {
    appState.usage = normalizeUsage(data);
    if (!usageGateOpen()) {
      appState.usage = null;
      hideUsage();
      return;
    }
    renderUsage();
  }

  function updateUsageRefreshUi(busy) {
    if (!els.usageRefresh) return;
    els.usageRefresh.disabled = busy;
    els.usageRefresh.textContent = busy ? '刷新中…' : '手动刷新';
  }

  async function loadUsage(force = false) {
    if (!usageGateOpen()) {
      appState.usage = null;
      hideUsage();
      return;
    }
    if (appState.usagePromise) {
      appState.usageReloadPending = true;
      appState.usageReloadForce = appState.usageReloadForce || force;
      return appState.usagePromise;
    }
    updateUsageRefreshUi(true);
    const request = (async () => {
      try {
        const data = await api(`/api/usage${force ? '?refresh=1' : ''}`);
        applyUsage(data);
      } catch (error) {
        if (error.status === 401) {
          appState.usage = null;
          hideUsage();
          return;
        }
        if (!usageGateOpen()) {
          appState.usage = null;
          hideUsage();
          return;
        }
        appState.usage = {
          visible: true,
          status: 'unavailable',
          updatedAt: null,
          windows: { fiveHour: null, weekly: null }
        };
        renderUsage();
        if (force) showToast('额度暂时不可用，请稍后重试。');
      }
    })();
    appState.usagePromise = request;
    try {
      await request;
    } finally {
      if (appState.usagePromise === request) appState.usagePromise = null;
      updateUsageRefreshUi(false);
      if (appState.usageReloadPending) {
        const nextForce = appState.usageReloadForce;
        appState.usageReloadPending = false;
        appState.usageReloadForce = false;
        void loadUsage(nextForce);
      }
    }
  }

  function openUsageDialog() {
    if (!usageGateOpen()) {
      appState.usage = null;
      hideUsage();
      return;
    }
    renderUsage();
    try {
      els.usageDialog.showModal();
    } catch (_error) {
      els.usageDialog.setAttribute('open', '');
    }
    els.usageOpen.setAttribute('aria-expanded', 'true');
    void loadUsage();
  }

  function closeUsageDialogFromUi() {
    closeUsageDialog();
  }

  function setBanner(message, visible = Boolean(message)) {
    els.banner.textContent = message || '';
    els.banner.hidden = !visible;
  }

  function showPairing(message = '') {
    els.pairError.textContent = message;
    if (!els.pairing.open) {
      try {
        els.pairing.showModal();
      } catch (_error) {
        els.pairing.setAttribute('open', '');
      }
    }
  }

  function hidePairing() {
    if (els.pairing.open) els.pairing.close();
    els.pairError.textContent = '';
  }

  function pairTokenFromHash(hash) {
    const value = String(hash || '').replace(/^#/, '');
    if (!value) return '';
    const token = new URLSearchParams(value).get('pair');
    return token ? token.trim() : '';
  }

  function consumePairToken() {
    const token = pairTokenFromHash(window.location.hash);
    if (!token) return '';
    const cleanUrl = `${window.location.pathname}${window.location.search}`;
    window.history.replaceState(null, document.title, cleanUrl);
    return token;
  }

  function pairTokenFromUrl(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    let url;
    try {
      url = new URL(text);
    } catch (_error) {
      return '';
    }
    if (url.origin !== window.location.origin) return '';
    return pairTokenFromHash(url.hash);
  }

  async function pairWithToken(token) {
    if (!token) return false;
    try {
      await api('/api/pair', {
        method: 'POST',
        body: JSON.stringify({ token })
      });
      hidePairing();
      return true;
    } catch (error) {
      if (error.status !== 401) {
        els.pairError.textContent = '链接无效或已失效，请从 Mac 重新生成。';
      } else {
        els.pairError.textContent = '链接无效或已失效，请从 Mac 重新生成。';
      }
      showPairing(els.pairError.textContent);
      return false;
    }
  }

  async function submitPairing(event) {
    event.preventDefault();
    if (appState.pairBusy) return;
    const token = pairTokenFromUrl(els.pairUrl.value);
    els.pairUrl.value = '';
    if (!token) {
      showPairing('请粘贴这台 Mac 生成的 Codex 专属配对链接。');
      return;
    }
    appState.pairBusy = true;
    els.pairSubmit.disabled = true;
    try {
      if (!await pairWithToken(token)) return;
      await loadState();
      connectEvents();
      const initial = appState.threads.find((thread) => thread.active) || appState.threads[0];
      if (initial) await selectThread(initial.id, { keepDrawer: true });
    } catch (error) {
      if (error.status === 401) {
        showPairing('当前页面仍未授权，请从 Mac 重新获取配对链接。');
      } else {
        showPairing('配对后暂时无法恢复 Codex，请稍后重新配对。');
      }
    } finally {
      appState.pairBusy = false;
      els.pairSubmit.disabled = false;
      els.pairUrl.value = '';
    }
  }

  function formatDate(value) {
    if (!value) return '';
    const numeric = typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() && Number.isFinite(Number(value))
        ? Number(value)
        : null;
    const date = new Date(numeric === null ? value : Math.abs(numeric) < 1e12 ? numeric * 1000 : numeric);
    if (Number.isNaN(date.getTime())) return '';
    const now = new Date();
    const sameDay = date.toDateString() === now.toDateString();
    if (sameDay) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString([], { month: 'numeric', day: 'numeric' });
  }

  function shortPath(value) {
    if (!value) return '';
    const parts = String(value).split('/').filter(Boolean);
    return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : String(value);
  }

  function currentSourceLabel(thread = appState.currentThread) {
    if (thread && thread.source === 'mobile') return thread.active ? 'Mac 正在处理 · 共享历史' : 'Mac 上的对话 · 共享历史';
    if (!thread && (appState.connected.desktop || appState.connected.engine)) return '已连接你的 Mac';
    if (thread && thread.source === 'desktop' && appState.connected.desktop) return '与电脑实时同步';
    if (appState.connected.desktop) return '电脑已连接，等待 Codex';
    if (appState.eventOpen) return '正在连接电脑…';
    return '等待电脑连接';
  }

  function updateConnectionUi() {
    const label = currentSourceLabel();
    els.connection.textContent = label;
    els.hostLabel.textContent = appState.connected.desktop ? '已连接电脑' : '本机 Codex';
    syncUsageGate();
    const dot = document.querySelector('.status-dot');
    if (dot) dot.style.background = appState.connected.desktop ? 'var(--accent)' : '#b3b7ae';
  }

  function updateEventBanner() {
    if (!appState.eventOpen) {
      setBanner('与电脑的实时连接已断开，正在重连…');
    } else if (els.banner.textContent.startsWith('与电脑的实时连接')) {
      setBanner('', false);
    }
    updateConnectionUi();
  }

  function normalizeThreads(threads) {
    return Array.isArray(threads) ? threads.filter((thread) => thread && thread.id) : [];
  }

  function mergeThreads(existing, incoming) {
    const map = new Map();
    [...existing, ...incoming].forEach((thread) => {
      if (thread && thread.id) map.set(thread.id, { ...map.get(thread.id), ...thread });
    });
    return [...map.values()];
  }

  async function loadState() {
    if (appState.stateBusy) {appState.stateReloadPending=true;return;}
    appState.stateBusy = true;
    try {
      const requestedProject=appState.projectFilter;
      const data = await api('/api/state'+encodeQuery({project:requestedProject}));
      if(requestedProject!==appState.projectFilter){appState.stateReloadPending=true;return;}
      appState.threads = normalizeThreads(data && data.threads);
      appState.projects = Array.isArray(data && data.projects) ? data.projects : [];
      appState.models = Array.isArray(data && data.models) ? data.models : [];
      appState.config = { ...appState.config, ...(data && data.config ? data.config : {}) };
      appState.connected = { ...appState.connected, ...(data && data.connected ? data.connected : {}) };
      appState.cursor = data && data.cursor ? data.cursor : null;
      if (!appState.selected.model) appState.selected.model = appState.config.model || '';
      if (!appState.selected.effort) appState.selected.effort = appState.config.effort || '';
      if (!appState.selected.cwd && appState.projects[0]) appState.selected.cwd = appState.projects[0].path || '';
      renderThreadList();
      updateConnectionUi();
      if (appState.currentId) {
        const summary = appState.threads.find((thread) => thread.id === appState.currentId);
        if (summary && appState.currentThread) {
          appState.currentThread = { ...appState.currentThread, title: summary.title };
          updateCurrentHeader();
        }
      }
      if (!appState.isInitialRender && usageGateOpen() && (!appState.usage || appState.usage.visible !== true)) void loadUsage();
    } finally {
      appState.stateBusy = false;
      if(appState.stateReloadPending){appState.stateReloadPending=false;scheduleStateRefresh();}
    }
  }

  function scheduleStateRefresh() {
    window.clearTimeout(appState.stateRefreshTimer);
    appState.stateRefreshTimer = window.setTimeout(() => {
      loadState().catch(() => {});
    }, 150);
  }

  async function loadMoreThreads() {
    if (!appState.cursor || appState.listBusy) return;
    appState.listBusy = true;
    const oldLabel = els.loadMore.textContent;
    els.loadMore.disabled = true;
    els.loadMore.textContent = '正在加载…';
    try {
      const requestedProject=appState.projectFilter;
      const data = await api(`/api/threads${encodeQuery({ cursor: appState.cursor, project:requestedProject })}`);
      if(requestedProject!==appState.projectFilter)return;
      appState.threads = mergeThreads(appState.threads, normalizeThreads(data && data.threads));
      appState.cursor = data && data.cursor ? data.cursor : null;
      renderThreadList();
    } catch (error) {
      if (error.status !== 401) showToast(apiErrorMessage(error, '更早的对话加载失败'));
    } finally {
      appState.listBusy = false;
      els.loadMore.disabled = false;
      els.loadMore.textContent = oldLabel;
    }
  }

  function renderThreadList() {
    const filterValue=appState.projectFilter;
    els.projectFilter.replaceChildren();
    [{id:'',label:'全部项目'},{id:'__none',label:'未归类'},...appState.projects.filter(p=>p.kind!=='directory')].forEach(p=>{
      const option=document.createElement('option');option.value=p.id;option.textContent=p.label;els.projectFilter.append(option);
    });
    els.projectFilter.value=filterValue;
    const query=els.search.value.trim().toLocaleLowerCase();
    const threads=appState.threads.filter(t=>(!filterValue||(filterValue==='__none'?!t.projectId:t.projectId===filterValue))&&(!query||`${t.title||''} ${t.cwd||''} ${t.projectLabel||''}`.toLocaleLowerCase().includes(query)));
    els.threads.replaceChildren();
    const groups=new Map();
    threads.forEach(t=>{const key=t.projectId||'__none';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(t);});
    if(!threads.length){const empty=document.createElement('div');empty.className='empty-list';empty.textContent=query?'没有匹配的对话':'此分类暂无对话';els.threads.append(empty);}
    groups.forEach((rows,key)=>{
      const project=appState.projects.find(p=>p.id===key);
      const group=document.createElement('details');group.className='project-group';group.open=true;
      const summary=document.createElement('summary');summary.textContent=`${project?.label||rows[0].projectLabel||'未归类'} · ${rows.length}`;group.append(summary);
      if(project?.path){const add=document.createElement('button');add.className='project-new';add.textContent='＋ 在此项目新建';add.onclick=()=>{appState.selected.cwd=project.path;newDraft(true);};group.append(add);}
      rows.forEach(thread=>{
        const row=document.createElement('button');row.type='button';row.className=`thread-row${thread.id===appState.currentId?' active':''}`;
        row.setAttribute('aria-label',`打开对话 ${thread.title||'未命名对话'}`);row.onclick=()=>selectThread(thread.id);
        if(thread.active){const running=document.createElement('span');running.className='thread-running';running.setAttribute('aria-label','正在运行');row.append(running);}
        const text=document.createElement('span');text.className='thread-label';
        const title=document.createElement('strong');title.textContent=thread.title||'未命名对话';
        const meta=document.createElement('small');meta.textContent=[shortPath(thread.cwd),formatDate(thread.updatedAt)].filter(Boolean).join(' · ');
        text.append(title,meta);row.append(text);group.append(row);
      });els.threads.append(group);
    });
    if(!threads.length&&filterValue){const project=appState.projects.find(p=>p.id===filterValue);if(project?.path){const add=document.createElement('button');add.className='new-chat';add.textContent='＋ 在此项目新建';add.onclick=()=>{appState.selected.cwd=project.path;newDraft(true);};els.threads.append(add);}}
    els.loadMore.hidden=!appState.cursor;
  }

  function openDrawer() {
    document.body.classList.add('drawer-open');
    els.menu.setAttribute('aria-expanded', 'true');
    els.drawer.removeAttribute('inert');
  }

  function closeDrawer() {
    document.body.classList.remove('drawer-open');
    els.menu.setAttribute('aria-expanded', 'false');
    syncDrawerLayout();
  }

  function syncDrawerLayout() {
    const wide = window.matchMedia('(min-width: 800px)').matches;
    const changed = appState.wideLayout !== wide;
    appState.wideLayout = wide;
    if (wide) {
      document.body.classList.remove('drawer-open');
      els.menu.setAttribute('aria-expanded', 'false');
      els.drawer.removeAttribute('inert');
      return;
    }
    if (changed || !document.body.classList.contains('drawer-open')) {
      document.body.classList.remove('drawer-open');
      els.menu.setAttribute('aria-expanded', 'false');
      els.drawer.setAttribute('inert', '');
    }
  }

  function draftKey(id) {
    return `${DRAFT_PREFIX}${id || 'new'}`;
  }

  function readDraft(id) {
    try {
      return window.localStorage.getItem(draftKey(id)) || '';
    } catch (_error) {
      return '';
    }
  }

  function writeDraft(id, value) {
    try {
      if (value) window.localStorage.setItem(draftKey(id), value);
      else window.localStorage.removeItem(draftKey(id));
    } catch (_error) {
      // Private browsing may disable local storage; the composer still works in memory.
    }
  }

  function saveCurrentDraft() {
    writeDraft(appState.currentId, els.prompt.value);
  }

  function loadCurrentDraft() {
    els.prompt.value = readDraft(appState.currentId);
    resizePrompt();
    updateComposerState();
  }

  function updateDraftStatus() {
    els.draftStatus.textContent = els.prompt.value ? '草稿已保存' : '';
  }

  function scheduleDraftSave() {
    updateDraftStatus();
    window.clearTimeout(appState.draftTimer);
    appState.draftTimer = window.setTimeout(saveCurrentDraft, 160);
  }

  function resizePrompt() {
    els.prompt.style.height = 'auto';
    const height = Math.min(Math.max(els.prompt.scrollHeight, 39), 150);
    els.prompt.style.height = `${height}px`;
    els.prompt.style.overflowY = els.prompt.scrollHeight > 150 ? 'auto' : 'hidden';
  }

  function isNearBottom() {
    const node = els.messages;
    return node.scrollHeight - node.scrollTop - node.clientHeight < 120;
  }

  function updateJumpButton() {
    els.bottom.hidden = isNearBottom();
  }

  function scrollToBottom(behavior = 'auto') {
    els.messages.scrollTo({ top: els.messages.scrollHeight, behavior });
    updateJumpButton();
  }

  function updateCurrentHeader() {
    els.title.textContent = appState.currentThread && appState.currentThread.title
      ? appState.currentThread.title
      : 'Codex';
    updateConnectionUi();
    updateComposerState();
  }

  function safeUrl(value) {
    try {
      const url = new URL(value, window.location.href);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
    } catch (_error) {
      return '';
    }
    return '';
  }

  function appendTextWithBreaks(parent, text) {
    String(text).split('\n').forEach((line, index) => {
      if (index) parent.append(document.createElement('br'));
      parent.append(document.createTextNode(line));
    });
  }

  function appendInline(parent, text) {
    const pattern = /(`[^`\n]+`|\[[^\]\n]+\]\([^\)\n]+\)|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_)/g;
    let cursor = 0;
    let match;
    while ((match = pattern.exec(String(text)))) {
      if (match.index > cursor) appendTextWithBreaks(parent, text.slice(cursor, match.index));
      const token = match[0];
      // Underscores inside identifiers are literal, as in CommonMark.
      if (token.startsWith('_') && (/\w/.test(String(text)[match.index - 1] || '') || /\w/.test(String(text)[match.index + token.length] || ''))) {
        appendTextWithBreaks(parent, token);
        cursor = match.index + token.length;
        continue;
      }
      if (token.startsWith('`')) {
        const code = document.createElement('code');
        code.textContent = token.slice(1, -1);
        parent.append(code);
      } else if (token.startsWith('[')) {
        const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        const href = linkMatch ? safeUrl(linkMatch[2]) : '';
        if (href) {
          const link = document.createElement('a');
          link.href = href;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = linkMatch[1];
          parent.append(link);
        } else {
          parent.append(document.createTextNode(token));
        }
      } else if (token.startsWith('**') || token.startsWith('__')) {
        const strong = document.createElement('strong');
        strong.textContent = token.slice(2, -2);
        parent.append(strong);
      } else {
        const emphasis = document.createElement('em');
        emphasis.textContent = token.slice(1, -1);
        parent.append(emphasis);
      }
      cursor = match.index + token.length;
    }
    if (cursor < String(text).length) appendTextWithBreaks(parent, String(text).slice(cursor));
  }

  function renderMarkdown(text, parent) {
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    let inFence = false;
    let codeLines = [];
    let list = null;
    let listType = '';

    const closeList = () => {
      list = null;
      listType = '';
    };

    const flushCode = () => {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = codeLines.join('\n');
      pre.append(code);
      parent.append(pre);
      codeLines = [];
    };

    lines.forEach((line) => {
      if (/^\s*```/.test(line)) {
        if (inFence) flushCode();
        inFence = !inFence;
        closeList();
        return;
      }
      if (inFence) {
        codeLines.push(line);
        return;
      }

      const heading = line.match(/^\s*(#{1,3})\s+(.+?)\s*#*\s*$/);
      const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      const quote = line.match(/^\s*>\s?(.*)$/);
      if (unordered || ordered) {
        const nextType = unordered ? 'ul' : 'ol';
        if (!list || listType !== nextType) {
          closeList();
          listType = nextType;
          list = document.createElement(nextType);
          parent.append(list);
        }
        const item = document.createElement('li');
        appendInline(item, (unordered || ordered)[1]);
        list.append(item);
        return;
      }
      closeList();
      if (!line.trim()) return;
      if (heading) {
        const node = document.createElement(`h${heading[1].length}`);
        appendInline(node, heading[2]);
        parent.append(node);
      } else if (quote) {
        const node = document.createElement('blockquote');
        appendInline(node, quote[1]);
        parent.append(node);
      } else {
        const node = document.createElement('p');
        appendInline(node, line);
        parent.append(node);
      }
    });
    if (inFence) flushCode();
  }

  function itemKind(item) {
    if (item && item.kind === 'question') return 'question';
    if (item && item.kind === 'user') return 'user';
    if (item && item.kind === 'tool') return 'tool';
    if (item && item.kind === 'error') return 'error';
    return 'agent';
  }

  function appendMessageMeta(parent, item) {
    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const phaseLabels = { commentary: '回复中', final_answer: '最终答复' };
    const visiblePhase = item && phaseLabels[item.phase];
    if (visiblePhase) {
      const phase = document.createElement('span');
      phase.textContent = visiblePhase;
      meta.append(phase);
    }
    const text = item && typeof item.text === 'string' ? item.text : '';
    if (text && itemKind(item) === 'agent') {
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'copy-message';
      copy.setAttribute('aria-label', '复制这条消息');
      copy.textContent = '复制';
      copy.addEventListener('click', async () => {
        if (await copyText(text)) {
          showToast('已复制');
        } else {
          showToast('复制失败');
        }
      });
      meta.append(copy);
    }
    if (meta.childNodes.length) parent.append(meta);
  }

  async function copyText(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (_error) {
        // Fall through to the selection-based method on HTTP or older browsers.
      }
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '-9999px';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch (_error) {
      copied = false;
    }
    textarea.remove();
    return copied;
  }

  function toolValueText(value) {
    if (typeof value === 'string') return value;
    if (value == null) return '';
    try {
      const serialized = JSON.stringify(value);
      return typeof serialized === 'string' ? serialized : '';
    } catch (_error) {
      return '';
    }
  }

  function toolPreview(item, text) {
    const title = toolValueText(item && item.title).trim();
    const explicit = [item && item.preview, item && item.command, item && item.path,
      item && item.filePath, item && item.file, item && item.query]
      .map(toolValueText)
      .find((value) => value.trim());
    const titleSuggestsInput = /^(?:正在)?执行命令$|^修改文件$|^搜索资料$|^(?:command execution|file change|web search)$/i.test(title);
    const candidate = explicit || (titleSuggestsInput ? text : '');
    const firstLine = toolValueText(candidate).split(/\r?\n/, 1)[0].trim().replace(/\s+/g, ' ');
    if (firstLine.length <= 120) return firstLine;
    return `${firstLine.slice(0, 117)}…`;
  }

  const TOOL_ICON_SHAPES = Object.freeze({
    command: Object.freeze([
      ['rect', { x: '3', y: '4', width: '18', height: '16', rx: '2' }],
      ['path', { d: 'm7 9 3 3-3 3M13 15h4' }]
    ]),
    file: Object.freeze([
      ['path', { d: 'M6 3h8l4 4v14H6zM14 3v5h5M9 13h6M9 17h6' }]
    ]),
    search: Object.freeze([
      ['circle', { cx: '10.5', cy: '10.5', r: '5.5' }],
      ['path', { d: 'm15 15 5 5' }]
    ]),
    other: Object.freeze([
      ['path', { d: 'm12 3 1.6 6.4L20 11l-6.4 1.6L12 19l-1.6-6.4L4 11l6.4-1.6z' }]
    ]),
    chevron: Object.freeze([
      ['path', { d: 'm9 5 7 7-7 7' }]
    ])
  });
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function toolIconKind(title) {
    if (/命令|终端|执行|command|terminal|shell/i.test(title)) return 'command';
    if (/文件|修改|读取|写入|file|edit|read|write|patch/i.test(title)) return 'file';
    if (/搜索|查找|search|web/i.test(title)) return 'search';
    return 'other';
  }

  function createStaticToolSvg(kind) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    for (const [tagName, attributes] of TOOL_ICON_SHAPES[kind] || TOOL_ICON_SHAPES.other) {
      const shape = document.createElementNS(SVG_NS, tagName);
      for (const [name, value] of Object.entries(attributes)) shape.setAttribute(name, value);
      svg.append(shape);
    }
    return svg;
  }

  function renderItem(item) {
    const kind = itemKind(item);
    const node = document.createElement('article');
    node.className = `message ${kind}`;
    node.dataset.itemId = item && item.id ? item.id : '';
    const text = item && typeof item.text === 'string' ? item.text : '';
    if (kind === 'question') {
      node.append(renderRequest(item.request));
    } else if (kind === 'tool') {
      const details = document.createElement('details');
      details.className = 'tool';
      const summary = document.createElement('summary');
      const titleText = toolValueText(item && item.title).trim() || '工具调用';
      const previewText = toolPreview(item, text);
      const icon = document.createElement('span');
      icon.className = 'tool-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.append(createStaticToolSvg(toolIconKind(titleText)));
      const heading = document.createElement('span');
      heading.className = 'tool-heading';
      const title = document.createElement('span');
      title.className = 'tool-title';
      title.textContent = titleText;
      heading.append(title);
      if (previewText) {
        const preview = document.createElement('span');
        preview.className = 'tool-preview';
        preview.textContent = previewText;
        heading.append(preview);
      }
      const chevron = document.createElement('span');
      chevron.className = 'tool-chevron';
      chevron.setAttribute('aria-hidden', 'true');
      chevron.append(createStaticToolSvg('chevron'));
      summary.append(icon, heading, chevron);
      summary.setAttribute('aria-label', [titleText, previewText].filter(Boolean).join(' '));
      if (/^正在/.test(titleText)) details.classList.add('is-running');
      const pre = document.createElement('pre');
      pre.textContent = text || (item.output ? JSON.stringify(item.output, null, 2) : '');
      const output = document.createElement('div');
      output.className = 'tool-output';
      output.append(pre);
      details.append(summary, output);
      node.append(details);
    } else if (kind === 'error') {
      node.className = 'error-note';
      node.textContent = text || '发生了一个错误。';
    } else if (kind === 'user') {
      node.textContent = text;
      for(const file of item.attachments||[]){const link=document.createElement('a');link.href=file.url;link.target='_blank';link.rel='noopener';link.className='sent-attachment';if(file.kind==='image'){const img=document.createElement('img');img.src=file.url;img.alt=file.name;img.loading='lazy';link.append(img);}else link.textContent='📎 '+file.name;node.append(link);}
    } else {
      renderMarkdown(text, node);
      appendMessageMeta(node, item);
    }
    return node;
  }

  function renderWelcome() {
    const welcome = document.createElement('div');
    welcome.className = 'welcome';
    const brand = document.createElement('div');
    brand.className = 'brand';
    brand.textContent = '✳';
    const heading = document.createElement('h1');
    heading.textContent = '把事情交给 Codex';
    const description = document.createElement('p');
    description.textContent = '选择电脑上的对话，或开始一件新事。';
    welcome.append(brand, heading, description);
    els.messages.append(welcome);
  }

  function mergeOlderThread(current, older) {
    if (!older) return current;
    const existing = Array.isArray(current.items) ? current.items : [];
    const incoming = Array.isArray(older.items) ? older.items : [];
    const seen = new Set();
    const items = [...incoming, ...existing].filter((item) => {
      const key = item && item.id ? item.id : JSON.stringify(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { ...current, ...older, items, olderCursor: older.olderCursor || null };
  }

  function renderThread(thread, options = {}) {
    const initial = Boolean(options.initial);
    const preservePosition = Boolean(options.preservePosition);
    const wasNearBottom = isNearBottom();
    const oldHeight = els.messages.scrollHeight;
    const oldScrollTop = els.messages.scrollTop;
    const openToolIds = new Set(
      [...els.messages.querySelectorAll('[data-item-id] details[open]')]
        .map((details) => details.closest('[data-item-id]')?.dataset.itemId)
        .filter(Boolean)
    );
    els.messages.replaceChildren();
    if (!thread || !Array.isArray(thread.items) || !thread.items.length) {
      renderWelcome();
    } else {
      if (thread.olderCursor) {
        const history = document.createElement('button');
        history.type = 'button';
        history.className = 'secondary load-history';
        history.textContent = '加载更早的消息';
        history.addEventListener('click', () => loadOlderMessages(thread.id));
        els.messages.append(history);
      }
      thread.items.forEach((item) => {
        const rendered = renderItem(item);
        if (item && item.id && openToolIds.has(String(item.id))) {
          const details = rendered.querySelector('details.tool');
          if (details) details.open = true;
        }
        els.messages.append(rendered);
      });
      if (thread.active) {
        const running = document.createElement('div');
        running.className = 'running-note';
        const pulse = document.createElement('span');
        pulse.className = 'pulse';
        pulse.setAttribute('aria-hidden', 'true');
        running.append(pulse, document.createTextNode('Codex 正在工作…'));
        els.messages.append(running);
      }
    }
    renderRequests(thread);
    updateCurrentHeader();
    updateComposerState();
    window.requestAnimationFrame(() => {
      if (preservePosition) {
        els.messages.scrollTop += els.messages.scrollHeight - oldHeight;
      } else if (initial || wasNearBottom) {
        scrollToBottom();
      } else {
        els.messages.scrollTop = oldScrollTop;
      }
      updateJumpButton();
    });
  }

  async function fetchThread(id, cursor = '') {
    const data = await api(`/api/thread${encodeQuery({ id, cursor })}`);
    if (!data || !data.id) return null;
    const previous = appState.threadCache.get(id);
    const merged = cursor && previous ? mergeOlderThread(previous, data) : data;
    appState.threadCache.set(id, merged);
    appState.olderCursors.set(id, merged.olderCursor || null);
    appState.dirtyThreads.delete(id);
    return merged;
  }

  async function refreshCurrentThread() {
    if (!appState.currentId) return;
    const id = appState.currentId;
    try {
      const thread = await fetchThread(id);
      if (id !== appState.currentId || !thread) return;
      appState.currentThread = thread;
      renderThread(thread);
      renderThreadList();
    } catch (error) {
      if (error.status !== 401) showToast(apiErrorMessage(error, '对话刷新失败'));
    }
  }

  function scheduleThreadRefresh(id) {
    if (!id || id !== appState.currentId) return;
    appState.dirtyThreads.add(id);
    window.clearTimeout(appState.threadRefreshTimer);
    appState.threadRefreshTimer = window.setTimeout(() => {
      refreshCurrentThread();
    }, 150);
  }

  async function loadOlderMessages(id) {
    const thread = appState.threadCache.get(id);
    const cursor = thread && thread.olderCursor;
    if (!id || !cursor) return;
    const button = els.messages.querySelector('.load-history');
    if (button) {
      button.disabled = true;
      button.textContent = '正在加载…';
    }
    try {
      const older = await fetchThread(id, cursor);
      if (id === appState.currentId && older) {
        appState.currentThread = older;
        renderThread(older, { preservePosition: true });
      }
    } catch (error) {
      if (error.status !== 401) showToast(apiErrorMessage(error, '历史消息加载失败'));
    }
  }

  async function selectThread(id, options = {}) {
    if (!id) return;
    saveCurrentDraft();
    appState.currentId = id;
    appState.currentThread = appState.threadCache.get(id) || null;
    appState.requestAnswers.clear();
    loadCurrentDraft();
    updateCurrentHeader();
    const cached = appState.currentThread;
    if (cached) renderThread(cached, { initial: true });
    else renderThread(null, { initial: true });
    if (!options.keepDrawer) closeDrawer();
    try {
      const thread = await fetchThread(id);
      if (id !== appState.currentId || !thread) return;
      appState.currentThread = thread;
      renderThread(thread, { initial: !cached });
      renderThreadList();
      if (usageGateOpen() && (!appState.usage || appState.usage.visible !== true)) void loadUsage();
    } catch (error) {
      if (error.status !== 401) showToast(apiErrorMessage(error, '对话加载失败'));
    }
  }

  function newDraft(keepProject = false) {
    saveCurrentDraft();
    writeDraft(null, '');
    appState.currentId = null;
    appState.currentThread = null;
    appState.requestAnswers.clear();
    appState.selected.model = appState.config.model || appState.selected.model || '';
    appState.selected.effort = appState.config.effort || appState.selected.effort || '';
    if (!keepProject) appState.selected.cwd = appState.projects.find(p=>p.id===appState.projectFilter)?.path || appState.selected.cwd || appState.projects[0]?.path || '';
    els.prompt.value = '';
    updateDraftStatus();
    renderThread(null, { initial: true });
    renderThreadList();
    updateCurrentHeader();
    closeDrawer();
    els.prompt.focus();
  }

  function modelRecord(model) {
    return appState.models.find((entry) => entry && entry.model === model) || null;
  }

  function modelLabel(model) {
    const record = modelRecord(model);
    return record && record.displayName ? record.displayName : model || '当前配置';
  }

  function effortsForModel(model) {
    const record = modelRecord(model);
    if (!record || !Array.isArray(record.supportedReasoningEfforts)) return [];
    return record.supportedReasoningEfforts
      .map((entry) => typeof entry === 'string' ? entry : entry && entry.reasoningEffort)
      .filter(Boolean);
  }

  function effortLabel(value) {return ({none:'关闭',minimal:'最少',low:'低',medium:'中',high:'高',xhigh:'很高',max:'最大',ultra:'极高'})[value] || value || '跟随默认';}
  function populateEfforts(model, preferred = '') {
    const options=['',...effortsForModel(model)];
    if(preferred&&!options.includes(preferred))options.push(preferred);
    els.effort.replaceChildren();
    options.forEach(effort=>{const option=document.createElement('option');option.value=effort;option.textContent=effortLabel(effort);els.effort.append(option);});
    els.effort.value=preferred||'';
  }

  function populateSettings() {
    const thread = appState.currentThread;
    const model = (thread && thread.model) || appState.selected.model || appState.config.model || '';
    const effort = thread ? (thread.effort ?? '') : (appState.selected.effort || appState.config.effort || '');
    els.project.replaceChildren();
    const projects = [...appState.projects];
    if (thread && thread.cwd && !projects.some((project) => project.path === thread.cwd)) {
      projects.unshift({ path: thread.cwd, label: shortPath(thread.cwd) });
    }
    if (!projects.length) projects.push({ path: '', label: '沿用当前目录' });
    projects.forEach((project) => {
      const option = document.createElement('option');
      option.value = project.path || '';
      option.textContent = project.label || project.path || '沿用当前目录';
      els.project.append(option);
    });
    els.project.value = (thread && thread.cwd) || appState.selected.cwd || projects[0].path || '';
    els.project.disabled = Boolean(thread);

    els.model.replaceChildren();
    const models = [...appState.models];
    if (model && !models.some((entry) => entry && entry.model === model)) {
      models.unshift({ model, displayName: model });
    }
    if (!models.length) models.push({ model: '', displayName: '当前配置' });
    models.forEach((entry) => {
      const option = document.createElement('option');
      option.value = entry.model || '';
      option.textContent = entry.displayName || entry.model || '当前配置';
      els.model.append(option);
    });
    els.model.value = model;
    populateEfforts(model, effort);
    els.effort.previousSibling.textContent = thread?.active ? '后续思考深度' : '思考深度';
    els.providerNote.textContent = appState.config.provider
      ? `沿用 Mac 上的 ${appState.config.provider} 配置与连接设置。`
      : '沿用 Mac 上的 Codex 配置与连接设置。';
    if(thread?.active) els.providerNote.textContent += ` 当前轮次：${modelLabel(thread.activeModel||thread.model)} · ${effortLabel(thread.activeEffort)}。设置修改用于下一轮。`;
  }

  function openSettings() {
    populateSettings();
    try {
      els.settings.showModal();
    } catch (_error) {
      els.settings.setAttribute('open', '');
    }
  }

  async function applySettings() {
    if (appState.settingsBusy) return;
    const model = els.model.value;
    const effort = els.effort.value;
    appState.selected.model = model;
    appState.selected.effort = effort;
    appState.selected.cwd = els.project.value;
    if (!appState.currentId) {
      els.settings.close();
      updateComposerState();
      showToast('新对话会使用这组配置');
      return;
    }
    appState.settingsBusy = true;
    els.applySettings.disabled = true;
    try {
      const updated = await api('/api/settings', {
        method: 'POST',
        body: JSON.stringify({ id: appState.currentId, model, effort })
      });
      if (appState.currentThread) {
        appState.currentThread = updated;
        appState.threadCache.set(appState.currentId, appState.currentThread);
      }
      els.settings.close();
      updateComposerState();
      renderThreadList();
      showToast('对话设置已更新');
    } catch (error) {
      if (error.status !== 401) showToast(apiErrorMessage(error, '设置更新失败'));
    } finally {
      appState.settingsBusy = false;
      els.applySettings.disabled = false;
    }
  }

  function currentAttachments(){return appState.attachmentDrafts.get(appState.currentId||'new')||[];}
  function renderAttachments(){
    const files=currentAttachments();els.attachments.replaceChildren();els.attachments.hidden=!files.length;
    files.forEach(file=>{const chip=document.createElement('div');chip.className='attachment-chip';
      if(file.kind==='image'){const img=document.createElement('img');img.src=file.url;img.alt='';chip.append(img);}
      const label=document.createElement('span');label.textContent=file.name;chip.append(label);
      const remove=document.createElement('button');remove.type='button';remove.textContent='×';remove.setAttribute('aria-label','移除 '+file.name);remove.disabled=appState.sendBusy;
      remove.onclick=()=>{appState.attachmentDrafts.set(appState.currentId||'new',files.filter(f=>f.id!==file.id));updateComposerState();};chip.append(remove);els.attachments.append(chip);
    });
  }
  async function uploadFiles(list,kind){
    const draftKey=appState.currentId||'new';const files=Array.from(list||[]);if(!files.length)return;
    if((appState.attachmentDrafts.get(draftKey)||[]).length+files.length>8){showToast('一条消息最多添加 8 个附件');return;}
    appState.uploadCount++;updateComposerState();
    try{for(const file of files){if(file.size>16*1024*1024)throw Error('单个附件限 16 MB');
      const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('文件读取失败'));reader.readAsDataURL(file);});
      const uploaded=await api('/api/upload',{method:'POST',body:JSON.stringify({name:file.name,data,kind})});
      appState.attachmentDrafts.set(draftKey,[...(appState.attachmentDrafts.get(draftKey)||[]),uploaded]);updateComposerState();
    }showToast('附件已就绪，点击发送');}catch(error){showToast(error.message||'附件上传失败');}
    finally{appState.uploadCount--;els.photoInput.value='';els.fileInput.value='';updateComposerState();}
  }
  function updateComposerState() {
    const t=appState.currentThread;
    const model=t?(t.active?t.activeModel||t.model:t.model):appState.selected.model||appState.config.model;
    const effort=t?(t.active?t.activeEffort:t.effort):appState.selected.effort||appState.config.effort;
    els.modelButton.firstChild.textContent=(model?modelLabel(model):'当前模型')+' · '+effortLabel(effort)+' ';
    els.modelButton.setAttribute('aria-label','模型与思考深度：'+els.modelButton.textContent);
    els.send.disabled=(!els.prompt.value.trim()&&!currentAttachments().length)||appState.sendBusy||appState.uploadCount>0;
    els.attach.disabled=appState.sendBusy||appState.uploadCount>0;
    els.attach.textContent=appState.uploadCount?'…':'＋';
    els.stop.hidden=!(t&&t.active);els.stop.disabled=appState.stopBusy;
    renderAttachments();updateDraftStatus();
  }

  async function sendMessage() {
    if (appState.sendBusy) return;
    const text = els.prompt.value;
    if (!text.trim() && !currentAttachments().length) return;
    appState.sendBusy = true;
    updateComposerState();
    const attachmentKey=appState.currentId||'new';
    const payload = {
      text,attachments:currentAttachments().map(f=>f.id),
      cwd: appState.currentId ? undefined : (els.project.value || appState.selected.cwd || undefined),
      model: appState.currentId ? undefined : (appState.selected.model || appState.config.model || undefined),
      effort: appState.currentId ? undefined : (appState.selected.effort || appState.config.effort || undefined)
    };
    if (appState.currentId) payload.id = appState.currentId;
    try {
      const result = await api('/api/send', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      const id = result && result.id ? result.id : appState.currentId;
      writeDraft(appState.currentId, '');
      appState.attachmentDrafts.delete(attachmentKey);
      els.prompt.value = '';
      resizePrompt();
      if (id && id !== appState.currentId) {
        appState.currentId = id;
        appState.currentThread = null;
        appState.requestAnswers.clear();
      }
      updateCurrentHeader();
      if (id) {
        await refreshCurrentThread();
        if (!appState.currentThread) {
          appState.currentThread = { id, title: '新对话', items: [], active: true, source: 'desktop' };
          renderThread(appState.currentThread, { initial: true });
        }
      }
      renderThreadList();
    } catch (error) {
      if (error.status !== 401) showToast(apiErrorMessage(error, '消息发送失败，请稍后重试'));
    } finally {
      appState.sendBusy = false;
      updateComposerState();
    }
  }

  async function stopCurrentThread() {
    if (!appState.currentId || appState.stopBusy) return;
    appState.stopBusy = true;
    updateComposerState();
    try {
      await api('/api/stop', {
        method: 'POST',
        body: JSON.stringify({ id: appState.currentId })
      });
      await refreshCurrentThread();
    } catch (error) {
      if (error.status !== 401) showToast(apiErrorMessage(error, '停止任务失败'));
    } finally {
      appState.stopBusy = false;
      updateComposerState();
    }
  }

  function requestQuestions(request) {
    const params = request && request.params;
    return params && Array.isArray(params.questions) ? params.questions : [];
  }

  function requestLabel(request) {
    const params = request && request.params;
    if (params && typeof params.message === 'string') return params.message;
    if (params && typeof params.reason === 'string') return params.reason;
    if (params && typeof params.command === 'string') return params.command;
    if (params && typeof params.title === 'string') return params.title;
    return 'Codex 请求你的确认';
  }

  function requestIsApproval(request) {
    const method = String(request && request.method || '').toLocaleLowerCase();
    return method.includes('approval') || method.includes('permission') || method.includes('confirm');
  }

  function requestAnswersFor(id) {
    const key=requestKey(id);
    if (!appState.requestAnswers.has(key)) appState.requestAnswers.set(key, {});
    return appState.requestAnswers.get(key);
  }

  function captureRequestFocus() {
    const active = document.activeElement;
    if (!active || !els.requests.contains(active) || !active.dataset.requestId) return null;
    const requestId = active.dataset.requestId;
    const questionId = active.dataset.questionId || '';
    return {
      requestId,
      questionId,
      optionLabel: active.dataset.optionLabel || '',
      tagName:active.tagName,
      selectionStart: typeof active.selectionStart === 'number' ? active.selectionStart : null,
      selectionEnd: typeof active.selectionEnd === 'number' ? active.selectionEnd : null
    };
  }

  function restoreRequestFocus(focus) {
    if (!focus) return;
    const target = [...els.requests.querySelectorAll('[data-request-id]')]
      .find((node) => node.tagName===focus.tagName && node.dataset.requestId === focus.requestId
        && (node.dataset.questionId || '') === focus.questionId
        && (!focus.optionLabel || node.dataset.optionLabel === focus.optionLabel));
    if (!target) return;
    target.focus({preventScroll:true});
    if (target.tagName === 'TEXTAREA' && focus.selectionStart !== null) {
      target.setSelectionRange(focus.selectionStart, focus.selectionEnd);
    }
  }

  function requestKey(id,threadId=appState.currentId){return threadId+':'+id;}
  function renderRequest(request) {
    const section=document.createElement('section');section.className='request-card';
    const heading=document.createElement('h3');heading.textContent=request.submitted?'✓ 已回答':requestIsApproval(request)?'需要确认':'需要你的回答';section.append(heading);
    const questions=requestQuestions(request);
    if(request.submitted){for(const q of questions){const p=document.createElement('p');p.textContent=q.question||q.header;section.append(p);}const a=document.createElement('p');a.className='submitted-answer';a.textContent=request.answer||'已提交';section.append(a);return section;}
    const method=String(request.method||'').toLowerCase();
    if(!questions.length&&!method.includes('command')&&!method.includes('file')){const note=document.createElement('p');note.textContent='这类请求请在电脑上的 Codex 中处理。';section.append(note);return section;}
    const busy=appState.submittingRequests.has(requestKey(request.id));
    if(questions.length){
      const answers=requestAnswersFor(request.id);
      questions.forEach((question,index)=>{
        const qid=question.id||`question-${index}`;const paragraph=document.createElement('p');paragraph.textContent=question.question||question.title||question.header||'请选择一个答案';section.append(paragraph);
        const options=(question.options||[]).map(o=>typeof o==='string'?{label:o}:o);
        const actions=document.createElement('div');actions.className='question-options';
        options.forEach(option=>{const label=option.label||option.description||'';const button=document.createElement('button');button.type='button';button.dataset.requestId=request.id;button.dataset.questionId=qid;button.dataset.optionLabel=label;
          const title=document.createElement('strong');title.textContent=label;button.append(title);if(option.description&&option.description!==label){const desc=document.createElement('small');desc.textContent=option.description;button.append(desc);}
          const selected=answers[qid]?.answers?.[0]===label;button.setAttribute('aria-pressed',String(selected));button.classList.toggle('approve',selected);button.disabled=busy;
          button.onclick=()=>{answers[qid]={answers:[label]};renderRequests(appState.currentThread,{force:true});};actions.append(button);
        });section.append(actions);
        const input=document.createElement('textarea');input.rows=2;input.dataset.requestId=request.id;input.dataset.questionId=qid;input.placeholder=options.length?'或填写自己的答案…':'输入回答…';input.setAttribute('aria-label','自填答案：'+paragraph.textContent);input.disabled=busy;
        const value=answers[qid]?.answers?.[0]||'';input.value=options.some(o=>o.label===value)?'':value;
        input.oninput=()=>{answers[qid]={answers:[input.value]};actions.querySelectorAll('button').forEach(b=>{b.classList.remove('approve');b.setAttribute('aria-pressed','false');});};section.append(input);
      });
      const submit=document.createElement('button');submit.type='button';submit.className='approve';submit.textContent=busy?'提交中…':'提交回答';submit.disabled=busy;
      submit.onclick=()=>{if(questions.some((q,i)=>!answers[q.id||`question-${i}`]?.answers?.some(v=>v.trim()))){showToast('请选择或填写每一道问题的答案');return;}submitRequest(request,'accept',answers);};section.append(submit);
    }else{const paragraph=document.createElement('p');paragraph.textContent=requestLabel(request);section.append(paragraph);const actions=document.createElement('div');actions.className='request-actions';
      ['accept','decline','cancel'].forEach(decision=>{const button=document.createElement('button');button.type='button';button.textContent={accept:'允许',decline:'拒绝',cancel:'取消'}[decision];button.disabled=busy;button.onclick=()=>submitRequest(request,decision);actions.append(button);});section.append(actions);
    }return section;
  }

  async function submitRequest(request, decision, answers) {
    if (!request || request.id == null || !appState.currentId || appState.submittingRequests.has(requestKey(request.id))) return;
    const targetId=appState.currentId;appState.submittingRequests.add(requestKey(request.id,targetId));
    renderRequests(appState.currentThread,{force:true});
    try {
      await api('/api/approval', {
        method: 'POST',
        body: JSON.stringify({
          id: targetId,
          requestId: request.id,
          decision,
          ...(answers ? { answers } : {})
        })
      });
      appState.requestAnswers.delete(requestKey(request.id,targetId));
      appState.submittedRequests.add(requestKey(request.id,targetId));
      showToast(decision === 'accept' ? '已提交' : '已处理');
      if(appState.currentId===targetId)await refreshCurrentThread();
      else appState.dirtyThreads.add(targetId);
    } catch (error) {
      if (error.status !== 401) showToast(apiErrorMessage(error, '请求处理失败'));
    } finally {appState.submittingRequests.delete(requestKey(request.id,targetId));if(appState.currentId===targetId)renderRequests(appState.currentThread);}
  }

  function renderRequests(thread,options={}) {
    const requests = (thread && Array.isArray(thread.requests) ? thread.requests : [])
      .filter(r=>!appState.submittedRequests.has(requestKey(r.id)));
    const signature=JSON.stringify([appState.currentId,requests,requests.map(r=>appState.submittingRequests.has(requestKey(r.id)))]);
    if(!options.force&&signature===appState.requestsSignature)return;
    const previousScroll=els.requests.scrollTop;
    const previousIds=els.requests.dataset.requestIds;
    const requestIds=JSON.stringify(requests.map(r=>String(r.id)));
    appState.requestsSignature=signature;
    els.requests.dataset.requestIds=requestIds;
    const focus = captureRequestFocus();
    els.requests.replaceChildren();
    if (!requests.length) {
      els.requests.hidden = true;
      return;
    }
    requests.forEach((request) => els.requests.append(renderRequest(request)));
    if(!els.requests.childNodes.length){els.requests.hidden=true;return;}
    els.requests.hidden = false;
    restoreRequestFocus(focus);
    els.requests.scrollTop=previousIds===requestIds?previousScroll:0;
  }

  function handleEvent(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (payload.type === 'thread' && payload.threadId) {
      if (payload.threadId === appState.currentId) scheduleThreadRefresh(payload.threadId);
      else scheduleStateRefresh();
    } else if (payload.type === 'usage') {
      void loadUsage();
    } else if (payload.type === 'state' || payload.type === 'connection') {
      scheduleStateRefresh();
    }
  }

  function connectEvents() {
    if (appState.eventSource) appState.eventSource.close();
    appState.eventAuthProbeDone = false;
    const source = new EventSource('/api/events', { withCredentials: true });
    appState.eventSource = source;
    source.onopen = () => {
      if (appState.eventSource !== source) return;
      appState.eventAuthProbeDone = false;
      appState.eventOpen = true;
      updateEventBanner();
    };
    source.onmessage = (event) => {
      if (appState.eventSource !== source) return;
      try {
        handleEvent(JSON.parse(event.data));
      } catch (_error) {
        // Ignore malformed event payloads and keep the stream alive.
      }
    };
    source.onerror = () => {
      if (appState.eventSource !== source) return;
      appState.eventOpen = false;
      updateEventBanner();
      if (appState.eventAuthProbeDone) return;
      appState.eventAuthProbeDone = true;
      void loadState().catch((error) => {
        if (appState.eventSource !== source || error.status !== 401) return;
        source.close();
        appState.eventSource = null;
        appState.eventOpen = false;
        setBanner('', false);
        showPairing();
      });
    };
  }

  function updateViewport() {
    const viewport = window.visualViewport;
    const height = viewport ? viewport.height : window.innerHeight;
    document.documentElement.style.setProperty('--vh', `${height}px`);
    const offset = viewport ? viewport.offsetTop : 0;
    document.documentElement.style.setProperty('--top', `${offset}px`);
    const keyboardOpen = Boolean(viewport && window.innerHeight - viewport.height > 120);
    els.keyboard.hidden = !keyboardOpen;
  }

  function handleWindowResize() {
    syncDrawerLayout();
    updateViewport();
  }

  function bindEvents() {
    els.menu.addEventListener('click', openDrawer);
    els.closeDrawer.addEventListener('click', closeDrawer);
    els.backdrop.addEventListener('click', closeDrawer);
    els.drawerNew.addEventListener('click', ()=>newDraft());
    els.newButton.addEventListener('click', ()=>newDraft());
    els.more.addEventListener('click', openSettings);
    els.modelButton.addEventListener('click', openSettings);
    els.refresh.addEventListener('click', () => loadState().catch((error) => {
      if (error.status !== 401) showToast(apiErrorMessage(error, '对话列表刷新失败'));
    }));
    els.loadMore.addEventListener('click', loadMoreThreads);
    els.search.addEventListener('input', renderThreadList);
    els.attach.onclick=()=>{els.attachmentMenu.hidden=!els.attachmentMenu.hidden;els.attach.setAttribute('aria-expanded',String(!els.attachmentMenu.hidden));};
    els.addPhoto.onclick=()=>{els.attachmentMenu.hidden=true;els.attach.setAttribute('aria-expanded','false');els.photoInput.click();};
    els.addFile.onclick=()=>{els.attachmentMenu.hidden=true;els.attach.setAttribute('aria-expanded','false');els.fileInput.click();};
    els.photoInput.onchange=()=>uploadFiles(els.photoInput.files,'image');els.fileInput.onchange=()=>uploadFiles(els.fileInput.files,'file');
    els.projectFilter.onchange=async()=>{appState.projectFilter=els.projectFilter.value;try{await loadState();}catch(e){showToast(e.message||'项目加载失败');}};
    els.send.addEventListener('click', sendMessage);
    els.stop.addEventListener('click', stopCurrentThread);
    els.keyboard.addEventListener('click', () => {
      document.activeElement && document.activeElement.blur();
      updateViewport();
    });
    els.prompt.addEventListener('input', () => {
      resizePrompt();
      scheduleDraftSave();
      updateComposerState();
    });
    els.prompt.addEventListener('focus', updateViewport);
    els.prompt.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
        event.preventDefault();
        if (!els.send.disabled) sendMessage();
      }
    });
    els.messages.addEventListener('scroll', updateJumpButton, { passive: true });
    els.bottom.addEventListener('click', () => scrollToBottom('smooth'));
    els.model.addEventListener('change', () => populateEfforts(els.model.value, ''));
    els.applySettings.addEventListener('click', applySettings);
    els.pairForm.addEventListener('submit', submitPairing);
    els.pairing.addEventListener('cancel', (event) => event.preventDefault());
    document.querySelectorAll('.close-sheet').forEach((button) => {
      button.addEventListener('click', () => els.settings.close());
    });
    els.settings.addEventListener('cancel', (event) => event.preventDefault());
    els.usageOpen.addEventListener('click', openUsageDialog);
    els.usageClose.addEventListener('click', closeUsageDialogFromUi);
    els.usageDialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      closeUsageDialogFromUi();
    });
    els.usageDialog.addEventListener('close', () => els.usageOpen.setAttribute('aria-expanded', 'false'));
    els.usageRefresh.addEventListener('click', () => { void loadUsage(true); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void loadUsage();
    });
    syncDrawerLayout();
    window.addEventListener('resize', handleWindowResize, { passive: true });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', updateViewport, { passive: true });
      window.visualViewport.addEventListener('scroll', updateViewport, { passive: true });
    }
  }

  async function init() {
    bindEvents();
    updateViewport();
    renderThread(null, { initial: true });
    const token = consumePairToken();
    if (token) await pairWithToken(token);
    try {
      await loadState();
      void loadUsage();
      const initial = appState.threads.find((thread) => thread.active) || appState.threads[0];
      if (initial) await selectThread(initial.id, { keepDrawer: true });
    } catch (error) {
      if (error.status !== 401) {
        setBanner(apiErrorMessage(error, '暂时无法连接 Codex，请检查 Mac 上的桥接状态。'));
      }
    }
    connectEvents();
    appState.isInitialRender = false;
    updateComposerState();
  }

  void init();
})();
