const state = {
  tasks: [],
  plan: null,
  weekPlan: null,
  accounts: [],
  busyBlocks: [],
  calendar: null,
  calendarPlanSync: null,
  gemini: null,
  activeView: localStorage.getItem('gestor-active-view') || 'today',
  filter: 'active',
  accountFilter: 'all',
  checkinTaskId: null,
  recognition: null,
  listening: false,
  voiceBaseText: '',
  voiceFinalText: ''
};

const els = {
  todayLabel: document.querySelector('#todayLabel'),
  saveStatus: document.querySelector('#saveStatus'),
  viewTitle: document.querySelector('#viewTitle'),
  viewSubtitle: document.querySelector('#viewSubtitle'),
  navItems: document.querySelectorAll('.nav-item'),
  viewPanels: document.querySelectorAll('[data-view-panel]'),
  taskForm: document.querySelector('#taskForm'),
  rawText: document.querySelector('#rawText'),
  accountSelect: document.querySelector('#accountSelect'),
  voiceButton: document.querySelector('#voiceButton'),
  voiceStatus: document.querySelector('#voiceStatus'),
  geminiStatus: document.querySelector('#geminiStatus'),
  statsStrip: document.querySelector('#statsStrip'),
  nextFocus: document.querySelector('#nextFocus'),
  weekPlan: document.querySelector('#weekPlan'),
  timeline: document.querySelector('#timeline'),
  taskList: document.querySelector('#taskList'),
  accountFilters: document.querySelector('#accountFilters'),
  tabs: document.querySelectorAll('.tab'),
  urgencyPills: document.querySelectorAll('.urgency-pill'),
  busyForm: document.querySelector('#busyForm'),
  busyTitleInput: document.querySelector('#busyTitleInput'),
  busyDateInput: document.querySelector('#busyDateInput'),
  busyStartInput: document.querySelector('#busyStartInput'),
  busyEndInput: document.querySelector('#busyEndInput'),
  busyList: document.querySelector('#busyList'),
  calendarPanel: document.querySelector('#calendarPanel'),
  calendarStatus: document.querySelector('#calendarStatus'),
  calendarError: document.querySelector('#calendarError'),
  connectCalendar: document.querySelector('#connectCalendar'),
  pushCalendar: document.querySelector('#pushCalendar'),
  syncCalendar: document.querySelector('#syncCalendar'),
  watchCalendar: document.querySelector('#watchCalendar'),
  disconnectCalendar: document.querySelector('#disconnectCalendar'),
  checkinDialog: document.querySelector('#checkinDialog'),
  checkinTask: document.querySelector('#checkinTask'),
  checkinReason: document.querySelector('#checkinReason'),
  checkinForm: document.querySelector('#checkinForm')
};

const urgencyLabels = {
  fire: 'Muito urgente',
  high: 'Alta',
  later: 'Alta depois',
  normal: 'Normal',
  low: 'Baixa',
  auto: 'Auto'
};

const formatter = new Intl.DateTimeFormat('pt-BR', {
  weekday: 'long',
  day: '2-digit',
  month: '2-digit'
});

const shortDateFormatter = new Intl.DateTimeFormat('pt-BR', {
  weekday: 'short',
  day: '2-digit',
  month: '2-digit'
});

function todayISO() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function dueClass(status = '') {
  return status.replace(/\s+/g, '-').replace('amanha', 'amanha');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || 'Falha na operacao.');
  return payload;
}

function setStatus(text) {
  els.saveStatus.textContent = text;
}

function applyStatePayload(payload) {
  state.tasks = payload.tasks || [];
  state.plan = payload.plan || null;
  state.weekPlan = payload.weekPlan || null;
  state.accounts = payload.accounts || [];
  state.busyBlocks = payload.busyBlocks || [];
  state.calendar = payload.calendar || null;
  state.calendarPlanSync = payload.calendarPlanSync || null;
  state.gemini = payload.gemini || null;
}

async function loadState() {
  setStatus('Carregando');
  const payload = await api(`/api/state?date=${todayISO()}`);
  applyStatePayload(payload);
  setStatus('Local');
  render();
}

function render() {
  els.todayLabel.textContent = formatter.format(new Date(`${todayISO()}T12:00:00`));
  renderViewShell();
  renderAccountOptions();
  renderAccountFilters();
  renderStats();
  renderNextFocus();
  renderWeekPlan();
  renderTimeline();
  renderTasks();
  renderCalendar();
  renderGeminiStatus();
  renderBusyBlocks();
}

function renderViewShell() {
  if (![...els.navItems].some((button) => button.dataset.view === state.activeView)) {
    state.activeView = 'today';
  }
  let activeButton = null;
  els.navItems.forEach((button) => {
    const active = button.dataset.view === state.activeView;
    button.classList.toggle('active', active);
    button.setAttribute('aria-current', active ? 'page' : 'false');
    if (active) activeButton = button;
  });
  els.viewPanels.forEach((panel) => {
    const active = panel.dataset.viewPanel === state.activeView;
    panel.classList.toggle('active', active);
  });
  if (activeButton) {
    els.viewTitle.textContent = activeButton.dataset.title || activeButton.textContent.trim();
    els.viewSubtitle.textContent = activeButton.dataset.subtitle || '';
  }
}

function setActiveView(view) {
  state.activeView = view || 'today';
  localStorage.setItem('gestor-active-view', state.activeView);
  renderViewShell();
}

function renderStats() {
  const stats = state.plan?.stats || {};
  els.statsStrip.innerHTML = [
    stat(`${stats.ready || 0} no plano`),
    stat(`${stats.later || 0} planejadas`),
    stat(`${stats.dueToday || 0} hoje`),
    stat(`${stats.overdue || 0} atrasadas`),
    stat(`${stats.doneToday || 0} feitas`)
  ].join('');
}

function stat(label) {
  return `<span class="stat">${escapeHtml(label)}</span>`;
}

function renderAccountOptions() {
  if (!els.accountSelect || els.accountSelect.dataset.ready === 'true') return;
  els.accountSelect.innerHTML = [
    '<option value="auto">Auto</option>',
    ...state.accounts.map((account) => `<option value="${escapeHtml(account.id)}">${escapeHtml(account.label)}</option>`)
  ].join('');
  els.accountSelect.dataset.ready = 'true';
  if (els.busyDateInput && !els.busyDateInput.value) els.busyDateInput.value = todayISO();
}

function renderAccountFilters() {
  if (!els.accountFilters) return;
  const accountRows = state.plan?.stats?.accounts || [];
  const buttons = [
    accountFilterButton({ id: 'all', label: 'Todas', active: state.tasks.filter((task) => task.status === 'active').length }),
    ...accountRows.map((account) => accountFilterButton(account))
  ];
  els.accountFilters.innerHTML = buttons.join('');
}

function accountFilterButton(account) {
  const active = state.accountFilter === account.id ? ' active' : '';
  const count = account.active ?? 0;
  return `<button class="account-filter${active}" type="button" data-account-filter="${escapeHtml(account.id)}">${escapeHtml(account.label)} · ${count}</button>`;
}

function renderNextFocus() {
  const block = state.plan?.next;
  if (!block) {
    els.nextFocus.className = 'next-focus empty';
    els.nextFocus.innerHTML = `
      <h3>Nenhuma demanda ativa</h3>
      <p class="decision">Quando voce lancar algo, o primeiro bloco aparece aqui.</p>
    `;
    return;
  }

  els.nextFocus.className = `next-focus urgency-${block.urgency}`;
  els.nextFocus.innerHTML = `
    <p class="eyebrow">Agora</p>
    <h3>${escapeHtml(block.title)}</h3>
    <div class="focus-meta">
      ${pill(`${block.start} - ${block.end}`)}
      ${pill(block.accountLabel || block.project)}
      ${pill(`${block.duration} min`)}
      ${pill(urgencyLabels[block.urgency], block.urgency)}
      ${pill(block.dueStatus, dueClass(block.dueStatus))}
    </div>
    <p class="decision">${escapeHtml(decisionLine(block))}</p>
    ${enhancementHtml(block, true)}
    <div class="block-actions">
      <button type="button" data-kind="done" data-task="${block.taskId}">Concluir</button>
      <button type="button" data-kind="checkin" data-task="${block.taskId}">Nao rolou</button>
      <button type="button" data-kind="nextWeek" data-task="${block.taskId}">Proxima semana</button>
    </div>
  `;
}

function renderWeekPlan() {
  if (!els.weekPlan) return;
  const weekPlan = state.weekPlan;
  if (!weekPlan?.days?.length) {
    els.weekPlan.innerHTML = '';
    return;
  }

  const total = weekPlan.stats?.scheduled || 0;
  const backlog = weekPlan.stats?.backlog || 0;
  els.weekPlan.innerHTML = `
    <div class="week-heading">
      <div>
        <p class="eyebrow">Semana</p>
        <h3>Alocacao automatica</h3>
      </div>
      <span>${escapeHtml(total)} blocos${backlog ? ` · ${escapeHtml(backlog)} sem horario` : ''}</span>
    </div>
    <div class="week-grid">
      ${weekPlan.days.map((day) => weekDayHtml(day)).join('')}
    </div>
  `;
}

function weekDayHtml(day) {
  const label = shortDateFormatter.format(new Date(`${day.date}T12:00:00`)).replace('.', '');
  const blocks = day.blocks || [];
  return `
    <article class="week-day">
      <div class="week-day-head">
        <strong>${escapeHtml(label)}</strong>
        <span>${blocks.length} bloco${blocks.length === 1 ? '' : 's'}</span>
      </div>
      <div class="week-day-list">
        ${
          blocks.length
            ? blocks.map((block) => weekBlockHtml(block)).join('')
            : '<p class="week-empty">Sem demandas alocadas</p>'
        }
      </div>
    </article>
  `;
}

function weekBlockHtml(block) {
  return `
    <div class="week-block urgency-${block.urgency}">
      <span>${escapeHtml(block.start)} - ${escapeHtml(block.end)}</span>
      <strong>${escapeHtml(block.title)}</strong>
      <small>${escapeHtml(block.accountLabel || block.project)} · ${escapeHtml(urgencyLabels[block.urgency] || block.urgency)}</small>
    </div>
  `;
}

function renderTimeline() {
  const blocks = state.plan?.blocks || [];
  const busy = state.plan?.busy || [];
  const items = [
    ...busy.map((block) => ({ ...block, kind: 'busy' })),
    ...blocks.map((block) => ({ ...block, kind: 'task' }))
  ].sort((a, b) => (a.start || '').localeCompare(b.start || ''));

  if (!items.length) {
    els.timeline.innerHTML = `<div class="empty-state time-block"><div class="block-content"><h3>Sem blocos no plano</h3><p class="decision">A fila esta limpa para hoje.</p></div></div>`;
    return;
  }

  els.timeline.innerHTML = items
    .map((block) => block.kind === 'busy' ? busyBlockHtml(block) : `
      <article class="time-block urgency-${block.urgency}">
        <div class="time-range">
          <span>${escapeHtml(block.start)}</span>
          <span>${escapeHtml(block.end)}</span>
        </div>
        <div class="block-content">
          <h3>${escapeHtml(block.title)}</h3>
          <div class="block-meta">
            ${pill(block.accountLabel || block.project)}
            ${pill(`${block.duration} min`)}
            ${pill(urgencyLabels[block.urgency], block.urgency)}
            ${pill(block.dueStatus, dueClass(block.dueStatus))}
          </div>
          <p class="decision">${escapeHtml(decisionLine(block))}</p>
          ${enhancementHtml(block, true)}
          <div class="block-actions">
            <button type="button" data-kind="done" data-task="${block.taskId}">Concluir</button>
            <button type="button" data-kind="checkin" data-task="${block.taskId}">Nao rolou</button>
            <button type="button" data-kind="nextWeek" data-task="${block.taskId}">Proxima semana</button>
          </div>
        </div>
      </article>
    `)
    .join('');
}

function busyBlockHtml(block) {
  return `
    <article class="time-block busy-block">
      <div class="time-range">
        <span>${escapeHtml(block.start)}</span>
        <span>${escapeHtml(block.end)}</span>
      </div>
      <div class="block-content">
        <h3>${escapeHtml(block.title)}</h3>
        <div class="block-meta">
          ${pill(block.source === 'google' ? 'Google Calendar' : 'Agenda ocupada')}
        </div>
      </div>
    </article>
  `;
}

function renderTasks() {
  const filtered = filteredTasks();
  if (!filtered.length) {
    els.taskList.innerHTML = `<div class="empty-state task-card"><h3>Fila vazia</h3><p>Nada nesse filtro.</p></div>`;
    return;
  }

  els.taskList.innerHTML = filtered
    .map((task) => `
      <article class="task-card urgency-${task.urgency} ${task.status === 'done' ? 'done' : ''}">
        <h3>${escapeHtml(task.title)}</h3>
        <div class="task-meta">
          ${pill(task.accountLabel || task.project)}
          ${pill(`${task.effortMinutes} min`)}
          ${pill(urgencyLabels[task.urgency], task.urgency)}
          ${aiPill(task)}
          ${googleSyncPill(task)}
          ${pill(task.dueStatus, dueClass(task.dueStatus))}
        </div>
        <p>${escapeHtml(task.raw)}</p>
        ${enhancementHtml(task)}
        <p>${escapeHtml(decisionLine(task))}</p>
        ${accountSelectHtml(task)}
        <div class="task-actions">
          ${taskActions(task)}
        </div>
      </article>
    `)
    .join('');
}

function renderBusyBlocks() {
  if (!els.busyList) return;
  if (els.busyDateInput && !els.busyDateInput.value) els.busyDateInput.value = todayISO();
  const blocks = state.busyBlocks || [];
  if (!blocks.length) {
    const calendarNote = state.calendar?.connected ? 'Google Calendar sincronizado, sem horarios ocupados hoje.' : 'O almoco 12:00-14:00 ja fica travado automaticamente.';
    els.busyList.innerHTML = `<div class="empty-state busy-item"><div><strong>Nenhum bloqueio hoje</strong><span>${escapeHtml(calendarNote)}</span></div></div>`;
    return;
  }
  els.busyList.innerHTML = blocks
    .map((block) => {
      const action = block.source === 'google'
        ? '<span class="busy-source">Google</span>'
        : `<button type="button" data-busy-delete="${escapeHtml(block.id)}">Remover</button>`;
      return `
        <div class="busy-item ${block.source === 'google' ? 'google-busy' : ''}">
          <div>
            <strong>${escapeHtml(block.title)}</strong>
            <span>${escapeHtml(block.start)} - ${escapeHtml(block.end)}</span>
          </div>
          ${action}
        </div>
      `;
    })
    .join('');
}

function accountSelectHtml(task) {
  if (!state.accounts.length || task.status === 'done') return '';
  const options = state.accounts
    .map((account) => {
      const selected = account.id === task.accountId ? ' selected' : '';
      return `<option value="${escapeHtml(account.id)}"${selected}>${escapeHtml(account.label)}</option>`;
    })
    .join('');
  return `<select class="task-account-select" data-account-task="${escapeHtml(task.id)}" aria-label="Conta da demanda">${options}</select>`;
}

function renderCalendar() {
  if (!els.calendarPanel) return;
  const calendar = state.calendar || {};
  const connected = Boolean(calendar.connected);
  const needsReconnect = Boolean(calendar.needsReconnect);
  const configured = Boolean(calendar.configured);
  const syncTime = calendar.syncedAt
    ? ` · sync ${new Date(calendar.syncedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
    : '';
  const planSync = state.calendarPlanSync
    ? ` · ${Number(state.calendarPlanSync.createdEvents || 0) + Number(state.calendarPlanSync.updatedEvents || 0)} blocos enviados`
    : '';
  const auto = calendar.autoReschedule || {};
  const autoLast = auto.last || {};
  const watch = calendar.watch || {};
  const backupMinutes = Math.max(1, Math.round((auto.intervalMs || 0) / 60000));
  const autoLabel = watch.active
    ? ' · notificacao ativa'
    : auto.enabled
    ? autoLast.moved
      ? ` · auto moveu ${autoLast.moved}`
      : ` · backup ${backupMinutes}min`
    : '';
  const calendarMessage = calendar.error || state.calendarPlanSync?.warning || '';

  els.calendarPanel.classList.toggle('connected', connected);
  els.calendarPanel.classList.toggle('error', Boolean(calendarMessage || needsReconnect));
  els.calendarStatus.textContent = !configured
    ? 'Credencial ausente'
    : connected
      ? `Conectado · ${calendar.busyCount || 0} bloqueios hoje${syncTime}${planSync}${autoLabel}`
      : needsReconnect
        ? 'Reconecte para criar blocos e tarefas'
        : 'Pronto para conectar';

  els.connectCalendar.hidden = connected;
  els.connectCalendar.textContent = needsReconnect ? 'Reconectar' : 'Conectar';
  els.connectCalendar.disabled = !configured;
  els.pushCalendar.hidden = !connected;
  els.syncCalendar.hidden = !connected;
  els.watchCalendar.hidden = !(connected && watch.configured && !watch.active);
  els.disconnectCalendar.hidden = !(connected || needsReconnect);
  els.calendarError.hidden = !(calendarMessage || needsReconnect);
  els.calendarError.textContent = calendarMessage || '';
}

function renderGeminiStatus() {
  if (!els.geminiStatus) return;
  const gemini = state.gemini || {};
  els.geminiStatus.textContent = gemini.enabled ? `Gemini · ${gemini.model}` : 'Texto local';
  els.geminiStatus.classList.toggle('active', Boolean(gemini.enabled));
}

function taskActions(task) {
  if (task.status === 'done') {
    return `<button type="button" data-kind="reopen" data-task="${task.id}">Reabrir</button>`;
  }

  const planButton = isLaterTask(task)
    ? `<button type="button" data-kind="thisWeek" data-task="${task.id}">Trazer pra semana</button>`
    : `<button type="button" data-kind="nextWeek" data-task="${task.id}">Proxima semana</button>`;

  return [
    `<button type="button" data-kind="done" data-task="${task.id}">Concluir</button>`,
    `<button type="button" data-kind="checkin" data-task="${task.id}">Nao rolou</button>`,
    planButton,
    `<button type="button" data-kind="archive" data-task="${task.id}">Arquivar</button>`
  ].join('');
}

function enhancementHtml(item, compact = false) {
  const steps = Array.isArray(item.steps) ? item.steps : [];
  if (!item.enhancedText && !steps.length) return '';
  const visibleSteps = compact ? steps.slice(0, 2) : steps;
  return `
    <div class="manager-note">
      <strong>Texto do gestor</strong>
      ${item.enhancedText ? `<p>${escapeHtml(item.enhancedText)}</p>` : ''}
      ${visibleSteps.length ? `<ol>${visibleSteps.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol>` : ''}
    </div>
  `;
}

function filteredTasks() {
  const tasks = [...state.tasks].filter((task) => state.accountFilter === 'all' || task.accountId === state.accountFilter);
  if (state.filter === 'done') {
    return tasks.filter((task) => task.status === 'done');
  }
  if (state.filter === 'later') {
    return tasks
      .filter((task) => task.status === 'active' && isLaterTask(task))
      .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  }
  if (state.filter === 'overdue') {
    return tasks.filter((task) => task.status === 'active' && task.dueStatus === 'atrasada');
  }
  return tasks
    .filter((task) => task.status === 'active' && !isLaterTask(task))
    .sort((a, b) => b.score - a.score);
}

function isLaterTask(task) {
  return task.urgency === 'later' || Boolean(task.plannedFor);
}

function pill(label, className = '') {
  return `<span class="meta-pill ${escapeHtml(className)}">${escapeHtml(label)}</span>`;
}

function googleSyncPill(task) {
  const labels = {
    synced: 'Google',
    completed: 'Google concluido',
    'calendar-only': 'Calendar ok',
    'needs-sync': 'Atualizar Google',
    error: 'Google erro',
    'needs-reconnect': 'Reconectar Google',
    'not-connected': 'Google offline'
  };
  return task.googleSyncStatus ? pill(labels[task.googleSyncStatus] || 'Google', `google-${task.googleSyncStatus}`) : '';
}

function aiPill(task) {
  if (task.aiProvider === 'gemini') return pill('Gemini', 'ai-gemini');
  if (task.aiStatus === 'error') return pill('IA erro', 'ai-error');
  return '';
}

function decisionLine(item) {
  const decision = item.decision || {};
  return [decision.account, decision.urgency, decision.due, decision.effort].filter(Boolean).join(' · ');
}

function selectedUrgency() {
  return new FormData(els.taskForm).get('urgency') || 'auto';
}

function setupVoiceInput() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition || !els.voiceButton) {
    if (els.voiceButton) els.voiceButton.disabled = true;
    if (els.voiceStatus) els.voiceStatus.textContent = 'Voz indisponivel';
    return;
  }

  state.recognition = new SpeechRecognition();
  state.recognition.lang = 'pt-BR';
  state.recognition.interimResults = true;
  state.recognition.continuous = true;

  state.recognition.addEventListener('start', () => {
    state.listening = true;
    state.voiceBaseText = els.rawText.value.trim();
    state.voiceFinalText = '';
    els.voiceButton.classList.add('listening');
    els.voiceStatus.textContent = 'Ouvindo...';
  });

  state.recognition.addEventListener('result', (event) => {
    let finalText = '';
    let interimText = '';
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const transcript = event.results[index][0]?.transcript || '';
      if (event.results[index].isFinal) finalText += transcript;
      else interimText += transcript;
    }
    if (finalText) state.voiceFinalText = `${state.voiceFinalText} ${finalText}`.trim();
    const parts = [state.voiceBaseText, state.voiceFinalText, interimText].map((part) => part.trim()).filter(Boolean);
    els.rawText.value = parts.join(' ');
  });

  state.recognition.addEventListener('error', (event) => {
    state.listening = false;
    els.voiceButton.classList.remove('listening');
    els.voiceStatus.textContent = event.error === 'not-allowed' ? 'Microfone bloqueado' : 'Voz pausada';
  });

  state.recognition.addEventListener('end', () => {
    state.listening = false;
    els.voiceButton.classList.remove('listening');
    els.voiceStatus.textContent = els.rawText.value.trim() ? 'Texto capturado' : 'Voz pronta';
  });
}

function toggleVoiceInput() {
  if (!state.recognition) return;
  if (state.listening) {
    state.recognition.stop();
    return;
  }
  try {
    state.recognition.start();
  } catch {
    els.voiceStatus.textContent = 'Voz ja ativa';
  }
}

async function createTask(event) {
  event.preventDefault();
  const rawText = els.rawText.value.trim();
  if (!rawText) {
    els.rawText.focus();
    return;
  }
  setStatus(state.gemini?.enabled ? 'Melhorando texto' : 'Salvando');
  await api('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ rawText, urgency: selectedUrgency(), accountId: selectedAccount() })
  });
  els.rawText.value = '';
  await loadState();
}

function selectedAccount() {
  return new FormData(els.taskForm).get('accountId') || 'auto';
}

async function handleAction(event) {
  const button = event.target.closest('button[data-kind]');
  if (!button) return;
  const id = button.dataset.task;
  const kind = button.dataset.kind;
  if (kind === 'checkin') {
    openCheckin(id);
    return;
  }
  setStatus('Atualizando');
  if (kind === 'done') {
    await api(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
  }
  if (kind === 'reopen') {
    await api(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'active' }) });
  }
  if (kind === 'archive') {
    await api(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'archived' }) });
  }
  if (kind === 'nextWeek') {
    await api(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ plan: 'next-week' }) });
  }
  if (kind === 'thisWeek') {
    await api(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ plan: 'this-week' }) });
  }
  await loadState();
}

async function handleAccountChange(event) {
  const select = event.target.closest('select[data-account-task]');
  if (!select) return;
  setStatus('Atualizando');
  await api(`/api/tasks/${select.dataset.accountTask}`, {
    method: 'PATCH',
    body: JSON.stringify({ accountId: select.value })
  });
  await loadState();
}

async function createBusyBlock(event) {
  event.preventDefault();
  const payload = {
    title: els.busyTitleInput.value.trim() || 'Agenda ocupada',
    date: els.busyDateInput.value || todayISO(),
    start: els.busyStartInput.value || '12:00',
    end: els.busyEndInput.value || '14:00'
  };
  setStatus('Bloqueando');
  await api('/api/busy-blocks', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
  els.busyTitleInput.value = '';
  await loadState();
}

async function syncCalendar() {
  setStatus('Sincronizando');
  const payload = await api(`/api/calendar/sync?date=${todayISO()}`, { method: 'POST' });
  applyStatePayload(payload);
  setStatus('Local');
  render();
}

async function pushPlanToCalendar() {
  setStatus('Criando semana');
  try {
    const payload = await api(`/api/calendar/plan?date=${todayISO()}`, { method: 'POST' });
    applyStatePayload(payload);
    const sync = payload.calendarPlanSync || {};
    const total = Number(sync.createdEvents || 0) + Number(sync.updatedEvents || 0);
    setStatus(`${total} blocos semana`);
    render();
  } catch (error) {
    state.calendar = { ...(state.calendar || {}), error: error.message };
    setStatus('Erro');
    renderCalendar();
  }
}

async function disconnectCalendar() {
  setStatus('Desconectando');
  const payload = await api(`/api/calendar/disconnect?date=${todayISO()}`, { method: 'POST' });
  applyStatePayload(payload);
  setStatus('Local');
  render();
}

async function activateCalendarWatch() {
  setStatus('Ativando notificacoes');
  try {
    const payload = await api(`/api/calendar/watch?date=${todayISO()}`, { method: 'POST' });
    applyStatePayload(payload);
    setStatus('Notificacao ativa');
    render();
  } catch (error) {
    state.calendar = { ...(state.calendar || {}), error: error.message };
    setStatus('Erro');
    renderCalendar();
  }
}

async function handleBusyAction(event) {
  const button = event.target.closest('button[data-busy-delete]');
  if (!button) return;
  setStatus('Atualizando');
  await api(`/api/busy-blocks/${button.dataset.busyDelete}`, { method: 'DELETE' });
  await loadState();
}

function openCheckin(id) {
  const task = state.tasks.find((item) => item.id === id);
  if (!task) return;
  state.checkinTaskId = id;
  els.checkinTask.textContent = task.title;
  els.checkinReason.value = '';
  els.checkinDialog.showModal();
  els.checkinReason.focus();
}

async function submitCheckin(event) {
  const button = event.target.closest('button[data-action]');
  if (!button || !state.checkinTaskId) return;
  const reason = els.checkinReason.value.trim();
  setStatus('Replanejando');
  await api(`/api/tasks/${state.checkinTaskId}/checkin`, {
    method: 'POST',
    body: JSON.stringify({ action: button.dataset.action, reason })
  });
  els.checkinDialog.close();
  await loadState();
}

function wireEvents() {
  setupVoiceInput();
  els.taskForm.addEventListener('submit', createTask);
  els.voiceButton?.addEventListener('click', toggleVoiceInput);
  document.body.addEventListener('click', handleAction);
  document.body.addEventListener('change', handleAccountChange);
  els.navItems.forEach((button) => {
    button.addEventListener('click', () => setActiveView(button.dataset.view));
  });
  els.checkinForm.addEventListener('click', submitCheckin);
  els.busyForm?.addEventListener('submit', createBusyBlock);
  els.busyList?.addEventListener('click', handleBusyAction);
  els.connectCalendar?.addEventListener('click', () => {
    window.location.href = '/auth/google';
  });
  els.pushCalendar?.addEventListener('click', pushPlanToCalendar);
  els.syncCalendar?.addEventListener('click', syncCalendar);
  els.watchCalendar?.addEventListener('click', activateCalendarWatch);
  els.disconnectCalendar?.addEventListener('click', disconnectCalendar);
  els.accountFilters?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-account-filter]');
    if (!button) return;
    state.accountFilter = button.dataset.accountFilter;
    renderAccountFilters();
    renderTasks();
  });

  els.urgencyPills.forEach((pillEl) => {
    pillEl.addEventListener('click', () => {
      els.urgencyPills.forEach((item) => item.classList.remove('active'));
      pillEl.classList.add('active');
    });
  });

  els.tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      els.tabs.forEach((item) => item.classList.remove('active'));
      tab.classList.add('active');
      state.filter = tab.dataset.filter;
      renderTasks();
    });
  });
}

wireEvents();
loadState().catch((error) => {
  setStatus('Erro');
  els.nextFocus.className = 'next-focus empty';
  els.nextFocus.innerHTML = `<h3>Erro ao carregar</h3><p class="decision">${escapeHtml(error.message)}</p>`;
});
