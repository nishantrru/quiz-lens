/* QuizLens AI: privacy-first browser workspace.
 * No captured image or API key is sent by this client. The storage layer uses IndexedDB.
 */
(() => {
  'use strict';

  const DB_NAME = 'quizlens-ai-v1';
  const DB_VERSION = 1;
  const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
  const FRAME_WIDTH = 960;
  const HASH_NEW_QUESTION_DISTANCE = 9;
  const HASH_DUPLICATE_DISTANCE = 4;
  const STABLE_FRAME_DISTANCE = 5;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const now = () => new Date().toISOString();
  const uid = () => (crypto?.randomUUID ? crypto.randomUUID() : `ql_${Date.now()}_${Math.random().toString(16).slice(2)}`);
  const escapeHtml = (value = '') => String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' })[char]);
  const sourceNames = { screen: 'Screen', camera: 'Camera', upload: 'Upload' };

  const state = {
    sessions: [],
    questions: [],
    currentSessionId: null,
    currentQuestionId: null,
    activeSource: 'screen',
    stream: null,
    uploadDataUrl: null,
    isCapturing: false,
    isPaused: false,
    sourceReady: false,
    autoTimer: null,
    isProcessingFrame: false,
    lastFrameHash: null,
    candidateHash: null,
    candidateDataUrl: null,
    candidateCount: 0,
    pendingConfirm: null,
    debounceSave: null,
  };

  const db = {
    instance: null,
    async open() {
      if (this.instance) return this.instance;
      this.instance = await new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains('sessions')) database.createObjectStore('sessions', { keyPath: 'id' });
          if (!database.objectStoreNames.contains('questions')) {
            const questions = database.createObjectStore('questions', { keyPath: 'id' });
            questions.createIndex('sessionId', 'sessionId', { unique: false });
            questions.createIndex('createdAt', 'createdAt', { unique: false });
          }
        };
        request.onsuccess = () => resolve(request.result);
      });
      return this.instance;
    },
    async getAll(storeName) {
      const database = await this.open();
      return new Promise((resolve, reject) => {
        const request = database.transaction(storeName, 'readonly').objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
      });
    },
    async put(storeName, value) {
      const database = await this.open();
      return new Promise((resolve, reject) => {
        const request = database.transaction(storeName, 'readwrite').objectStore(storeName).put(value);
        request.onsuccess = () => resolve(value);
        request.onerror = () => reject(request.error);
      });
    },
    async delete(storeName, id) {
      const database = await this.open();
      return new Promise((resolve, reject) => {
        const request = database.transaction(storeName, 'readwrite').objectStore(storeName).delete(id);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    },
    async clearAll() {
      const database = await this.open();
      await Promise.all(['sessions', 'questions'].map((storeName) => new Promise((resolve, reject) => {
        const request = database.transaction(storeName, 'readwrite').objectStore(storeName).clear();
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      })));
    },
  };

  const els = {
    pageEyebrow: $('#pageEyebrow'), pageTitle: $('#pageTitle'), toastStack: $('#toastStack'),
    mobileMenuButton: $('#mobileMenuButton'), sidebar: $('.sidebar'),
    sessionDialog: $('#sessionDialog'), sessionForm: $('#sessionForm'), sessionTitle: $('#sessionTitle'), sessionDescription: $('#sessionDescription'), authorizedCheck: $('#authorizedCheck'),
    helpDialog: $('#helpDialog'), confirmDialog: $('#confirmDialog'), confirmTitle: $('#confirmTitle'), confirmMessage: $('#confirmMessage'), confirmActionButton: $('#confirmActionButton'),
    recentSessions: $('#recentSessions'), statSessions: $('#statSessions'), statCaptured: $('#statCaptured'), statAnalyzed: $('#statAnalyzed'), statVerified: $('#statVerified'),
    statSessionText: $('#statSessionText'), statCapturedText: $('#statCapturedText'), statAnalyzedText: $('#statAnalyzedText'), statVerifiedText: $('#statVerifiedText'),
    captureSessionLabel: $('#captureSessionLabel'), captureStageChip: $('#captureStageChip'), captureNotice: $('#captureNotice'), capturePermission: $('#capturePermission'),
    previewFrame: $('#previewFrame'), captureVideo: $('#captureVideo'), captureImage: $('#captureImage'), captureCanvas: $('#captureCanvas'), previewPlaceholder: $('#previewPlaceholder'), previewOverlay: $('#previewOverlay'), imageUpload: $('#imageUpload'),
    captureInterval: $('#captureInterval'), captureCrop: $('#captureCrop'), startCaptureButton: $('#startCaptureButton'), pauseCaptureButton: $('#pauseCaptureButton'), manualCaptureButton: $('#manualCaptureButton'), stopCaptureButton: $('#stopCaptureButton'), detectionDot: $('#detectionDot'), detectionStatus: $('#detectionStatus'), duplicateStatus: $('#duplicateStatus'), liveNavState: $('#liveNavState'),
    questionTitle: $('#questionTitle'), emptyQuestion: $('#emptyQuestion'), questionWorkspace: $('#questionWorkspace'), questionMeta: $('#questionMeta'), questionText: $('#questionText'), optionsList: $('#optionsList'), addOptionButton: $('#addOptionButton'), optionTemplate: $('#optionTemplate'),
    analysisCard: $('#analysisCard'), analysisTitle: $('#analysisTitle'), analysisBadge: $('#analysisBadge'), analysisBody: $('#analysisBody'), analysisDetails: $('#analysisDetails'), analyzeButton: $('#analyzeButton'), googleSearchButton: $('#googleSearchButton'), copyQuestionButton: $('#copyQuestionButton'), flagQuestionButton: $('#flagQuestionButton'), saveNextButton: $('#saveNextButton'), saveHint: $('#saveHint'),
    questionRail: $('#questionRail'), questionRailList: $('#questionRailList'), toggleQuestionRail: $('#toggleQuestionRail'), previousQuestionButton: $('#previousQuestionButton'), nextQuestionButton: $('#nextQuestionButton'),
    historySearch: $('#historySearch'), historySessionFilter: $('#historySessionFilter'), historyStatusFilter: $('#historyStatusFilter'), clearFiltersButton: $('#clearFiltersButton'), historyList: $('#historyList'), flaggedList: $('#flaggedList'),
    reportSessionSelect: $('#reportSessionSelect'), reportSessionName: $('#reportSessionName'), reportSummary: $('#reportSummary'), includeNotes: $('#includeNotes'),
    exportCsvButton: $('#exportCsvButton'), exportJsonButton: $('#exportJsonButton'), exportPdfButton: $('#exportPdfButton'), settingsExportButton: $('#settingsExportButton'), clearDataButton: $('#clearDataButton'),
  };

  function toast(message, type = 'info') {
    const item = document.createElement('div');
    item.className = `toast ${type}`;
    const symbol = type === 'success' ? '✓' : type === 'error' ? '!' : '⌁';
    item.innerHTML = `<span>${symbol}</span><div>${escapeHtml(message)}</div>`;
    els.toastStack.append(item);
    window.setTimeout(() => item.remove(), 4600);
  }

  function formatDate(value, style = 'short') {
    if (!value) return '—';
    const date = new Date(value);
    return new Intl.DateTimeFormat(undefined, style === 'long'
      ? { dateStyle: 'medium', timeStyle: 'short' }
      : { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
  }

  function normalizedText(text) { return String(text || '').toLowerCase().replace(/\s+/g, ' ').replace(/[^\p{L}\p{N} ]/gu, '').trim(); }
  function questionSort(a, b) { return new Date(b.createdAt) - new Date(a.createdAt); }
  function sessionSort(a, b) { return new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt); }
  function currentSession() { return state.sessions.find((session) => session.id === state.currentSessionId) || null; }
  function currentQuestion() { return state.questions.find((question) => question.id === state.currentQuestionId) || null; }
  function questionsForSession(sessionId = state.currentSessionId) { return state.questions.filter((question) => question.sessionId === sessionId).sort((a, b) => a.questionNumber - b.questionNumber); }
  function sourceName(source) { return sourceNames[source] || 'Capture'; }

  async function persistQuestion(question, { render = false } = {}) {
    question.updatedAt = now();
    await db.put('questions', question);
    const index = state.questions.findIndex((item) => item.id === question.id);
    if (index >= 0) state.questions[index] = question; else state.questions.push(question);
    const session = state.sessions.find((item) => item.id === question.sessionId);
    if (session) {
      session.updatedAt = question.updatedAt;
      await db.put('sessions', session);
    }
    if (render) renderEverything();
  }

  async function persistSession(session) {
    session.updatedAt = now();
    await db.put('sessions', session);
    const index = state.sessions.findIndex((item) => item.id === session.id);
    if (index >= 0) state.sessions[index] = session; else state.sessions.push(session);
  }

  async function init() {
    try {
      state.sessions = (await db.getAll('sessions')).sort(sessionSort);
      state.questions = (await db.getAll('questions')).sort(questionSort);
      state.currentSessionId = state.sessions[0]?.id || null;
      renderEverything();
    } catch (error) {
      console.error(error);
      toast('Browser storage is unavailable. Captures cannot be persisted in this session.', 'error');
    }
    bindEvents();
  }

  function renderEverything() {
    renderStats();
    renderRecentSessions();
    renderSessionOptions();
    renderCaptureState();
    renderQuestion();
    renderQuestionRail();
    renderHistory();
    renderFlagged();
    renderReports();
  }

  function renderStats() {
    const captured = state.questions.length;
    const analyzed = state.questions.filter((question) => question.analysis?.status === 'ready').length;
    const verified = state.questions.filter((question) => question.verificationStatus === 'verified').length;
    els.statSessions.textContent = String(state.sessions.length);
    els.statCaptured.textContent = String(captured);
    els.statAnalyzed.textContent = String(analyzed);
    els.statVerified.textContent = String(verified);
    els.statSessionText.textContent = state.sessions.length ? 'Sessions stored on this device' : 'Create your first session';
    els.statCapturedText.textContent = captured ? `${captured} saved privately in browser` : 'Waiting for capture';
    els.statAnalyzedText.textContent = analyzed ? 'Analysis complete' : 'Secure service not connected';
    els.statVerifiedText.textContent = verified ? 'Marked with independent evidence' : 'Independent verification only';
  }

  function renderRecentSessions() {
    const sessions = [...state.sessions].sort(sessionSort).slice(0, 4);
    if (!sessions.length) {
      els.recentSessions.className = 'empty-state compact';
      els.recentSessions.innerHTML = '<span class="empty-icon">◌</span><h3>No audit sessions yet</h3><p>Start a private session, then explicitly choose a capture source.</p><button class="button secondary" data-action="open-session" type="button">Create your first audit</button>';
      return;
    }
    els.recentSessions.className = 'session-list';
    els.recentSessions.innerHTML = sessions.map((session) => {
      const questions = questionsForSession(session.id);
      const flagged = questions.filter((question) => question.flags?.length).length;
      return `<button class="session-row ${session.id === state.currentSessionId ? 'selected' : ''}" data-action="resume-session" data-session-id="${session.id}" type="button">
        <span class="session-row-icon">◌</span><span class="session-row-copy"><b>${escapeHtml(session.title)}</b><small>${questions.length} question${questions.length === 1 ? '' : 's'} · ${flagged ? `${flagged} flagged` : 'no flags'} · ${formatDate(session.updatedAt || session.createdAt)}</small></span><span class="session-arrow">›</span>
      </button>`;
    }).join('');
  }

  function renderSessionOptions() {
    const selectedHistory = els.historySessionFilter.value || 'all';
    const selectedReport = els.reportSessionSelect.value || 'all';
    const options = `<option value="all">All sessions</option>${[...state.sessions].sort(sessionSort).map((session) => `<option value="${session.id}">${escapeHtml(session.title)}</option>`).join('')}`;
    els.historySessionFilter.innerHTML = options;
    els.reportSessionSelect.innerHTML = options;
    els.historySessionFilter.value = state.sessions.some((session) => session.id === selectedHistory) ? selectedHistory : 'all';
    els.reportSessionSelect.value = state.sessions.some((session) => session.id === selectedReport) ? selectedReport : 'all';
  }

  function renderCaptureState() {
    const session = currentSession();
    els.captureSessionLabel.textContent = session ? `${session.title} · ${questionsForSession(session.id).length} saved question${questionsForSession(session.id).length === 1 ? '' : 's'}` : 'Create an audit session to begin.';
    const chip = els.captureStageChip;
    chip.classList.toggle('capturing', state.isCapturing && !state.isPaused);
    chip.classList.toggle('paused', state.isPaused);
    chip.classList.remove('error');
    const chipText = state.isPaused ? ['Paused', 'capture is held'] : state.isCapturing ? ['Capturing', `${sourceName(state.activeSource).toLowerCase()} source active`] : ['Ready', state.sourceReady ? 'source selected' : 'no source active'];
    chip.querySelector('b').textContent = chipText[0];
    chip.querySelector('small').textContent = chipText[1];
    els.capturePermission.className = `permission-label ${state.sourceReady ? 'granted' : ''}`;
    els.capturePermission.textContent = state.sourceReady ? 'Permission granted' : 'Permission required';
    els.previewOverlay.hidden = !state.isCapturing || state.isPaused;
    els.startCaptureButton.disabled = !session || (state.activeSource === 'upload' && !state.sourceReady);
    els.startCaptureButton.textContent = state.isPaused ? 'Resume capture' : state.isCapturing ? 'Capturing…' : state.activeSource === 'upload' ? 'Start with upload' : 'Start auto capture';
    els.pauseCaptureButton.disabled = !state.isCapturing && !state.isPaused;
    els.pauseCaptureButton.textContent = state.isPaused ? 'Resume' : 'Pause';
    els.manualCaptureButton.disabled = !state.sourceReady || !session || state.isProcessingFrame;
    els.stopCaptureButton.disabled = !state.isCapturing && !state.sourceReady;
    els.detectionDot.classList.toggle('active', state.isCapturing && !state.isPaused);
    els.liveNavState.textContent = state.isCapturing ? (state.isPaused ? 'Paused' : 'Live') : 'Idle';
  }

  function renderQuestion() {
    const question = currentQuestion();
    const session = currentSession();
    if (!question) {
      els.questionTitle.textContent = 'Nothing captured yet';
      els.emptyQuestion.hidden = false;
      els.questionWorkspace.hidden = true;
      return;
    }
    els.emptyQuestion.hidden = true;
    els.questionWorkspace.hidden = false;
    els.questionTitle.textContent = `Question ${question.questionNumber}`;
    els.questionMeta.innerHTML = `<span class="meta-chip">${escapeHtml(sourceName(question.captureSource))}</span><span class="meta-chip">${formatDate(question.createdAt)}</span>${question.isDuplicate ? '<span class="meta-chip">Possible duplicate</span>' : ''}${session ? `<span class="meta-chip">${escapeHtml(session.title)}</span>` : ''}`;
    els.questionText.value = question.questionText || '';
    renderOptions(question);
    renderAnalysis(question);
    els.flagQuestionButton.innerHTML = question.flags?.length ? '⚑ Unflag' : '⚑ Flag';
    els.saveHint.innerHTML = '<span class="status-dot local"></span> Saved locally as you work';
  }

  function renderOptions(question) {
    const options = question.options || [];
    els.optionsList.innerHTML = '';
    if (!options.length) {
      const helper = document.createElement('p');
      helper.className = 'empty-options';
      helper.textContent = 'Add visible answer options to make this record easier to review.';
      els.optionsList.append(helper);
      return;
    }
    options.forEach((option, index) => {
      const fragment = els.optionTemplate.content.cloneNode(true);
      $('.option-label', fragment).textContent = String.fromCharCode(65 + index);
      const input = $('.option-input', fragment);
      input.value = option.text || '';
      input.dataset.optionIndex = String(index);
      const remove = $('.remove-option', fragment);
      remove.dataset.optionIndex = String(index);
      els.optionsList.append(fragment);
    });
  }

  function renderAnalysis(question) {
    const analysis = question.analysis || { status: 'not_configured' };
    const ready = analysis.status === 'ready';
    if (ready) {
      els.analysisTitle.textContent = 'AI-suggested answer — not independently verified';
      els.analysisBadge.className = 'state-chip ready';
      els.analysisBadge.textContent = analysis.confidence ? `${analysis.confidence} confidence` : 'AI suggested';
      const suggested = (analysis.suggestedAnswer || []).join(', ') || 'No option suggested';
      els.analysisBody.innerHTML = `<strong class="analysis-suggestion">Suggested: ${escapeHtml(suggested)}</strong><span>${escapeHtml(analysis.answerText || '')}</span><span>${escapeHtml(analysis.explanation || 'A suggestion is available. Verify against appropriate independent sources.')}</span>`;
      const details = [
        analysis.ambiguityDetected ? 'Potential ambiguity detected' : '',
        analysis.needsVerification ? 'Independent verification recommended' : '',
        ...(analysis.auditFlags || []),
      ].filter(Boolean);
      els.analysisDetails.innerHTML = `<summary>Audit details</summary><p>${escapeHtml(details.join(' · ') || 'No automatic flags reported.')}</p>`;
    } else if (analysis.status === 'analyzing') {
      els.analysisTitle.textContent = 'Analyzing securely…';
      els.analysisBadge.className = 'state-chip muted';
      els.analysisBadge.textContent = 'Processing';
      els.analysisBody.textContent = 'The capture is being sent only to the configured server-side analysis service. It remains an AI suggestion, not independent verification.';
      els.analysisDetails.innerHTML = '<summary>What happens next</summary><p>The service validates a structured answer and preserves this capture even if analysis fails.</p>';
    } else {
      els.analysisTitle.textContent = 'Awaiting secure analysis';
      els.analysisBadge.className = 'state-chip muted';
      els.analysisBadge.textContent = 'Not configured';
      els.analysisBody.textContent = 'A server-side OpenAI connection has not been configured for this deployment. Your capture is still saved privately in this browser and can be verified through independent sources.';
      els.analysisDetails.innerHTML = '<summary>Why no suggestion is shown</summary><p>AI credentials must stay on a secure server. This public client never asks for or stores an API key in your browser.</p>';
    }
  }

  function renderQuestionRail() {
    const questions = questionsForSession();
    if (!questions.length) {
      els.questionRail.hidden = true;
      return;
    }
    els.questionRailList.innerHTML = questions.map((question) => `<button class="rail-item ${question.id === state.currentQuestionId ? 'active' : ''}" type="button" data-question-id="${question.id}"><b>Question ${question.questionNumber}</b><span>${escapeHtml(question.questionText || 'Awaiting transcription')}</span></button>`).join('');
    els.previousQuestionButton.disabled = !state.currentQuestionId || questions.findIndex((question) => question.id === state.currentQuestionId) <= 0;
    const currentIndex = questions.findIndex((question) => question.id === state.currentQuestionId);
    els.nextQuestionButton.disabled = !state.currentQuestionId || currentIndex === -1 || currentIndex >= questions.length - 1;
  }

  function statusChip(question) {
    if (question.flags?.length) return '<span class="tiny-chip flagged">Flagged</span>';
    if (question.verificationStatus === 'verified') return '<span class="tiny-chip verified">Verified</span>';
    if (question.isDuplicate) return '<span class="tiny-chip duplicate">Possible duplicate</span>';
    return '<span class="tiny-chip pending">Needs verification</span>';
  }

  function historyItemHtml(question) {
    const session = state.sessions.find((item) => item.id === question.sessionId);
    const thumbnail = question.imageData ? `<img alt="Capture preview" src="${question.imageData}" />` : '▣';
    const sources = question.verificationSources || [];
    const latestSource = sources[sources.length - 1];
    return `<article class="history-item" data-question-id="${question.id}">
      <div class="history-thumb">${thumbnail}</div>
      <div class="history-copy"><div class="history-line"><h3>Q${question.questionNumber} · ${escapeHtml(question.questionText || 'Awaiting transcription')}</h3>${statusChip(question)}<span class="tiny-chip source">${escapeHtml(sourceName(question.captureSource))}</span></div><p>${escapeHtml(session?.title || 'Deleted session')} · Captured ${formatDate(question.createdAt)}${latestSource ? ` · ${escapeHtml(latestSource.result || 'source saved')}` : ''}</p></div>
      <div class="history-actions"><button class="button ghost" type="button" data-action="open-question">Open</button><button class="icon-button" type="button" data-action="expand-question" aria-label="Expand details">⌄</button><button class="icon-button" type="button" data-action="delete-question" aria-label="Delete question">×</button></div>
      <div class="history-expand">
        <div class="field"><label>Audit notes</label><textarea class="history-note" rows="2" placeholder="Add a review note">${escapeHtml(question.notes || '')}</textarea></div>
        <div class="verification-grid"><input class="verification-url" inputmode="url" placeholder="https://source.example" value="" /><select class="verification-result"><option value="supports">Source supports answer</option><option value="contradicts">Source contradicts suggestion</option><option value="reference">Reference only</option></select><button class="button secondary" type="button" data-action="save-verification">Save evidence</button></div>
        <div class="history-actions"><button class="button secondary" type="button" data-action="mark-verified">Mark verified</button>${sources.length ? `<span class="tiny-chip source">${sources.length} source${sources.length === 1 ? '' : 's'} attached</span>` : ''}</div>
      </div>
    </article>`;
  }

  function renderHistory() {
    const search = normalizedText(els.historySearch.value);
    const sessionId = els.historySessionFilter.value || 'all';
    const status = els.historyStatusFilter.value || 'all';
    let questions = [...state.questions].sort(questionSort);
    if (search) questions = questions.filter((question) => normalizedText(`${question.questionText || ''} ${question.notes || ''}`).includes(search));
    if (sessionId !== 'all') questions = questions.filter((question) => question.sessionId === sessionId);
    if (status === 'flagged') questions = questions.filter((question) => question.flags?.length);
    if (status === 'verified') questions = questions.filter((question) => question.verificationStatus === 'verified');
    if (status === 'needs_verification') questions = questions.filter((question) => question.verificationStatus !== 'verified' && !question.isDuplicate);
    if (status === 'duplicate') questions = questions.filter((question) => question.isDuplicate);
    if (!questions.length) {
      els.historyList.innerHTML = `<div class="empty-state history-empty"><span class="empty-icon">☷</span><h3>${state.questions.length ? 'No questions match these filters' : 'Your saved captures will appear here'}</h3><p>${state.questions.length ? 'Try clearing a filter or searching different words.' : 'Start an audit, then capture an authorized screen, camera, or image.'}</p>${state.questions.length ? '<button class="button ghost" data-action="clear-history-filters" type="button">Clear filters</button>' : '<button class="button secondary" data-action="open-session" type="button">Start an audit</button>'}</div>`;
      return;
    }
    els.historyList.innerHTML = questions.map(historyItemHtml).join('');
  }

  function renderFlagged() {
    const flagged = [...state.questions].filter((question) => question.flags?.length).sort(questionSort);
    if (!flagged.length) {
      els.flaggedList.innerHTML = '<div class="empty-state history-empty"><span class="empty-icon">⚑</span><h3>No questions are flagged</h3><p>Flag a capture when it is ambiguous, incomplete, potentially duplicated, or needs a closer review.</p><button class="button ghost" data-view-target="capture" type="button">Go to live capture</button></div>';
      return;
    }
    els.flaggedList.innerHTML = flagged.map(historyItemHtml).join('');
  }

  function renderReports() {
    const selected = els.reportSessionSelect.value || 'all';
    const questions = selected === 'all' ? state.questions : state.questions.filter((question) => question.sessionId === selected);
    const session = state.sessions.find((item) => item.id === selected);
    els.reportSessionName.textContent = session ? session.title : 'All saved questions';
    const counts = {
      questions: questions.length,
      flagged: questions.filter((question) => question.flags?.length).length,
      verified: questions.filter((question) => question.verificationStatus === 'verified').length,
      pending: questions.filter((question) => question.verificationStatus !== 'verified').length,
    };
    els.reportSummary.innerHTML = `<div class="summary-item"><span>Questions</span><b>${counts.questions}</b></div><div class="summary-item"><span>Flagged</span><b>${counts.flagged}</b></div><div class="summary-item"><span>Verified</span><b>${counts.verified}</b></div><div class="summary-item"><span>To verify</span><b>${counts.pending}</b></div>`;
  }

  function switchView(target) {
    if (target === 'capture' && !state.currentSessionId) {
      openSessionDialog();
      return;
    }
    $$('.view').forEach((view) => view.classList.toggle('active', view.dataset.view === target));
    $$('.nav-item[data-view-target]').forEach((button) => button.classList.toggle('active', button.dataset.viewTarget === target && button.textContent.trim() !== 'New audit'));
    const labels = { dashboard: ['Workspace', 'Dashboard'], capture: ['Audit workspace', 'Live capture'], history: ['Records', 'Question history'], flagged: ['Records', 'Flagged questions'], reports: ['Exports', 'Reports'], settings: ['Workspace', 'Settings'] };
    els.pageEyebrow.textContent = labels[target]?.[0] || 'Workspace';
    els.pageTitle.textContent = labels[target]?.[1] || 'Dashboard';
    els.sidebar.classList.remove('open');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (target === 'history') renderHistory();
    if (target === 'flagged') renderFlagged();
    if (target === 'reports') renderReports();
  }

  function openSessionDialog() {
    els.sessionForm.reset();
    els.sessionTitle.value = `Audit session — ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date())}`;
    els.sessionDialog.showModal();
    window.setTimeout(() => els.sessionTitle.focus(), 0);
  }

  async function createSession() {
    const title = els.sessionTitle.value.trim();
    if (!title) { toast('Give this audit session a name first.', 'error'); return; }
    if (!els.authorizedCheck.checked) { toast('Confirm authorized use before creating the session.', 'error'); return; }
    const session = { id: uid(), title, description: els.sessionDescription.value.trim(), status: 'active', createdAt: now(), updatedAt: now() };
    await persistSession(session);
    state.currentSessionId = session.id;
    state.currentQuestionId = null;
    renderEverything();
    els.sessionDialog.close();
    switchView('capture');
    toast('Audit session created. Choose a capture source when ready.', 'success');
  }

  async function setSource(source) {
    if (state.activeSource === source && !(source === 'upload' && !state.sourceReady)) return;
    if (state.isCapturing || state.stream) await stopCapture();
    state.activeSource = source;
    state.sourceReady = source === 'upload' && Boolean(state.uploadDataUrl);
    state.lastFrameHash = null;
    state.candidateHash = null;
    state.candidateCount = 0;
    $$('.source-tab').forEach((button) => { const active = button.dataset.source === source; button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); });
    if (source === 'upload') {
      els.previewPlaceholder.hidden = Boolean(state.uploadDataUrl);
      els.captureVideo.hidden = true;
      els.captureImage.hidden = !state.uploadDataUrl;
      els.imageUpload.click();
    } else {
      els.captureImage.hidden = true;
      els.captureVideo.hidden = false;
      els.previewPlaceholder.hidden = false;
    }
    updateCaptureMessage(source === 'upload' ? 'Choose an image to prepare it for capture.' : `Choose “Start auto capture” to grant ${source} permission.`, false);
    renderCaptureState();
  }

  async function handleUpload(file) {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/i.test(file.type)) { toast('Choose a PNG, JPEG, or WebP image.', 'error'); return; }
    if (file.size > MAX_UPLOAD_BYTES) { toast('That image is larger than 10 MB. Choose a smaller capture.', 'error'); return; }
    try {
      state.uploadDataUrl = await readAsDataUrl(file);
      state.sourceReady = true;
      state.activeSource = 'upload';
      els.captureImage.src = state.uploadDataUrl;
      els.captureImage.hidden = false;
      els.captureVideo.hidden = true;
      els.previewPlaceholder.hidden = true;
      updateCaptureMessage('Image ready. Use “Capture now” to create a local record.', false);
      renderCaptureState();
      toast('Image prepared. It stays in this browser until you export or clear it.', 'success');
    } catch (error) {
      console.error(error);
      toast('The image could not be read. Try another file.', 'error');
    }
  }

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(file);
    });
  }

  async function startCapture() {
    if (!currentSession()) { openSessionDialog(); return; }
    if (state.isPaused) { resumeCapture(); return; }
    if (state.isCapturing) return;
    try {
      if (state.activeSource === 'upload') {
        if (!state.sourceReady) { els.imageUpload.click(); return; }
        state.isCapturing = true;
        state.isPaused = false;
        state.lastFrameHash = null;
        updateCaptureMessage('Uploaded image is active. It will be captured once and remains editable.', true);
        renderCaptureState();
        await captureFrame({ manual: false, initial: true });
        return;
      }
      updateCaptureMessage(`Requesting ${sourceName(state.activeSource).toLowerCase()} permission…`, true);
      const constraints = state.activeSource === 'screen'
        ? { video: { frameRate: { ideal: 5, max: 12 } }, audio: false }
        : { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false };
      state.stream = state.activeSource === 'screen'
        ? await navigator.mediaDevices.getDisplayMedia(constraints)
        : await navigator.mediaDevices.getUserMedia(constraints);
      const track = state.stream.getVideoTracks()[0];
      if (track) track.addEventListener('ended', () => { stopCapture('The browser ended this capture source.'); });
      els.captureVideo.srcObject = state.stream;
      els.captureVideo.hidden = false;
      els.captureImage.hidden = true;
      els.previewPlaceholder.hidden = true;
      await els.captureVideo.play();
      state.sourceReady = true;
      state.isCapturing = true;
      state.isPaused = false;
      state.lastFrameHash = null;
      state.candidateHash = null;
      state.candidateCount = 0;
      updateCaptureMessage('Capture active. Looking for a stable new question…', true);
      renderCaptureState();
      window.setTimeout(() => captureFrame({ manual: false, initial: true }), 500);
      state.autoTimer = window.setInterval(() => captureFrame({ manual: false }), Number(els.captureInterval.value));
    } catch (error) {
      console.error(error);
      const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError';
      state.sourceReady = false;
      state.isCapturing = false;
      updateCaptureMessage(denied ? 'Permission was not granted. You can retry whenever you are ready.' : 'Could not start this source. Check browser permissions and try again.', false, true);
      renderCaptureState();
      toast(denied ? 'Permission was not granted. No capture was started.' : 'Capture could not start. Check your browser and source.', 'error');
    }
  }

  function pauseCapture() {
    if (!state.isCapturing) return;
    window.clearInterval(state.autoTimer);
    state.autoTimer = null;
    state.isPaused = true;
    state.isCapturing = false;
    updateCaptureMessage('Auto capture paused. Your source remains open until you stop it.', false);
    renderCaptureState();
    toast('Auto capture paused.');
  }

  function resumeCapture() {
    if (!state.sourceReady) return;
    state.isPaused = false;
    state.isCapturing = true;
    updateCaptureMessage('Auto capture resumed. Looking for a stable new question…', true);
    state.autoTimer = window.setInterval(() => captureFrame({ manual: false }), Number(els.captureInterval.value));
    renderCaptureState();
    toast('Auto capture resumed.', 'success');
  }

  async function stopCapture(message = 'Capture stopped. Your saved records remain available.') {
    window.clearInterval(state.autoTimer);
    state.autoTimer = null;
    state.isCapturing = false;
    state.isPaused = false;
    if (state.stream) {
      state.stream.getTracks().forEach((track) => track.stop());
      state.stream = null;
    }
    if (state.activeSource !== 'upload') {
      state.sourceReady = false;
      els.captureVideo.srcObject = null;
      els.previewPlaceholder.hidden = false;
    }
    els.previewOverlay.hidden = true;
    updateCaptureMessage(message, false);
    renderCaptureState();
  }

  async function manualCapture() {
    if (!state.sourceReady) { toast('Choose and authorize a source first.', 'error'); return; }
    await captureFrame({ manual: true });
  }

  function getFrame() {
    const canvas = els.captureCanvas;
    const media = state.activeSource === 'upload' ? els.captureImage : els.captureVideo;
    const naturalWidth = state.activeSource === 'upload' ? media.naturalWidth : media.videoWidth;
    const naturalHeight = state.activeSource === 'upload' ? media.naturalHeight : media.videoHeight;
    if (!naturalWidth || !naturalHeight) return null;
    const useCenterCrop = els.captureCrop.value === 'center';
    const cropWidth = useCenterCrop ? Math.round(naturalWidth * 0.8) : naturalWidth;
    const cropHeight = useCenterCrop ? Math.round(naturalHeight * 0.8) : naturalHeight;
    const cropX = useCenterCrop ? Math.round((naturalWidth - cropWidth) / 2) : 0;
    const cropY = useCenterCrop ? Math.round((naturalHeight - cropHeight) / 2) : 0;
    const ratio = Math.min(1, FRAME_WIDTH / cropWidth);
    canvas.width = Math.max(1, Math.round(cropWidth * ratio));
    canvas.height = Math.max(1, Math.round(cropHeight * ratio));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(media, cropX, cropY, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);
    return { dataUrl: canvas.toDataURL('image/jpeg', 0.78), hash: hashCanvas(canvas), width: canvas.width, height: canvas.height };
  }

  function hashCanvas(sourceCanvas) {
    const hashCanvas = document.createElement('canvas');
    hashCanvas.width = 9;
    hashCanvas.height = 8;
    const context = hashCanvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(sourceCanvas, 0, 0, 9, 8);
    const pixels = context.getImageData(0, 0, 9, 8).data;
    const bits = [];
    for (let row = 0; row < 8; row += 1) {
      for (let col = 0; col < 8; col += 1) {
        const index = (row * 9 + col) * 4;
        const next = index + 4;
        const gray = pixels[index] * 0.299 + pixels[index + 1] * 0.587 + pixels[index + 2] * 0.114;
        const nextGray = pixels[next] * 0.299 + pixels[next + 1] * 0.587 + pixels[next + 2] * 0.114;
        bits.push(gray > nextGray ? 1 : 0);
      }
    }
    return bits;
  }

  function hammingDistance(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return Number.POSITIVE_INFINITY;
    let difference = 0;
    for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) difference += 1;
    return difference;
  }

  async function captureFrame({ manual = false, initial = false } = {}) {
    if (state.isProcessingFrame || (!state.isCapturing && !manual)) return;
    state.isProcessingFrame = true;
    try {
      const frame = getFrame();
      if (!frame) {
        updateCaptureMessage('Waiting for the source preview to become ready…', state.isCapturing);
        return;
      }
      if (!manual && state.activeSource !== 'upload') {
        if (!state.lastFrameHash) {
          state.lastFrameHash = frame.hash;
          state.candidateHash = frame.hash;
          state.candidateDataUrl = frame.dataUrl;
          state.candidateCount = 1;
          updateCaptureMessage(initial ? 'Establishing a stable baseline…' : 'Watching for a changed question…', true);
          if (!initial) return;
        } else if (hammingDistance(frame.hash, state.lastFrameHash) < HASH_NEW_QUESTION_DISTANCE) {
          state.candidateCount = 0;
          updateCaptureMessage('No material question change detected yet.', true);
          return;
        } else if (state.candidateHash && hammingDistance(frame.hash, state.candidateHash) <= STABLE_FRAME_DISTANCE) {
          state.candidateCount += 1;
          state.candidateDataUrl = frame.dataUrl;
          if (state.candidateCount < 2) {
            updateCaptureMessage('Change detected — checking stability before saving…', true);
            return;
          }
        } else {
          state.candidateHash = frame.hash;
          state.candidateDataUrl = frame.dataUrl;
          state.candidateCount = 1;
          updateCaptureMessage('Change detected — checking stability before saving…', true);
          return;
        }
      }
      await saveCapturedFrame(frame, manual);
    } catch (error) {
      console.error(error);
      updateCaptureMessage('This frame could not be captured. You can retry safely.', state.isCapturing, true);
      toast('Frame capture failed. Your prior records are safe.', 'error');
    } finally {
      state.isProcessingFrame = false;
      renderCaptureState();
    }
  }

  async function saveCapturedFrame(frame, manual) {
    const session = currentSession();
    if (!session) return;
    const sessionQuestions = questionsForSession(session.id);
    const duplicate = sessionQuestions.find((question) => question.imageHash && hammingDistance(question.imageHash, frame.hash) <= HASH_DUPLICATE_DISTANCE);
    state.lastFrameHash = frame.hash;
    state.candidateHash = frame.hash;
    state.candidateCount = 0;
    if (duplicate) {
      updateCaptureMessage(`Duplicate suppressed — similar to question ${duplicate.questionNumber}.`, state.isCapturing);
      els.duplicateStatus.textContent = `Duplicate protection matched question ${duplicate.questionNumber}`;
      if (manual) toast(`Duplicate suppressed: this looks like question ${duplicate.questionNumber}.`);
      return;
    }
    const question = {
      id: uid(),
      sessionId: session.id,
      userId: 'browser-local',
      questionNumber: sessionQuestions.length ? Math.max(...sessionQuestions.map((item) => item.questionNumber)) + 1 : 1,
      imageData: frame.dataUrl,
      imageHash: frame.hash,
      imageWidth: frame.width,
      imageHeight: frame.height,
      captureSource: state.activeSource,
      questionText: '',
      questionType: 'unknown',
      options: [],
      analysis: { status: 'not_configured' },
      confidence: null,
      verificationStatus: 'needs_verification',
      verificationSources: [],
      flags: [],
      notes: '',
      isDuplicate: false,
      createdAt: now(),
      updatedAt: now(),
    };
    await persistQuestion(question);
    state.currentQuestionId = question.id;
    updateCaptureMessage(`Question ${question.questionNumber} saved locally. Add text or options, then verify it.`, state.isCapturing);
    els.duplicateStatus.textContent = 'New question saved; duplicate protection remains active';
    renderEverything();
    toast(`Question ${question.questionNumber} captured and saved locally.`, 'success');
    if (state.activeSource === 'upload') await stopCapture('Uploaded image captured. Choose another image or review this record.');
  }

  function updateCaptureMessage(message, active, error = false) {
    els.detectionStatus.textContent = message;
    els.captureNotice.classList.toggle('info', !error);
    els.captureNotice.classList.toggle('error', error);
  }

  function snapshotQuestionFromWorkspace() {
    const question = currentQuestion();
    if (!question) return null;
    question.questionText = els.questionText.value.trim();
    question.options = $$('.option-input', els.optionsList).map((input, index) => ({ label: String.fromCharCode(65 + index), text: input.value.trim() })).filter((option) => option.text);
    return question;
  }

  function scheduleQuestionSave() {
    window.clearTimeout(state.debounceSave);
    state.debounceSave = window.setTimeout(async () => {
      const question = snapshotQuestionFromWorkspace();
      if (!question) return;
      try { await persistQuestion(question); renderHistory(); renderQuestionRail(); renderReports(); } catch (error) { console.error(error); toast('Could not save your edit locally.', 'error'); }
    }, 500);
  }

  async function saveAndNext() {
    const question = snapshotQuestionFromWorkspace();
    if (!question) { toast('Capture or open a question first.', 'error'); return; }
    await persistQuestion(question);
    const currentIndex = questionsForSession().findIndex((item) => item.id === question.id);
    const nextQuestion = questionsForSession()[currentIndex + 1] || null;
    state.currentQuestionId = nextQuestion?.id || null;
    renderEverything();
    if (nextQuestion) toast('Saved. Opened the next saved question.', 'success'); else toast('Saved. Ready for your next capture.', 'success');
  }

  async function toggleFlag() {
    const question = snapshotQuestionFromWorkspace();
    if (!question) return;
    if (question.flags?.length) question.flags = [];
    else question.flags = ['Needs reviewer attention'];
    await persistQuestion(question);
    renderEverything();
    toast(question.flags.length ? 'Question flagged for review.' : 'Review flag removed.', 'success');
  }

  async function analyzeQuestion() {
    const question = snapshotQuestionFromWorkspace();
    if (!question) { toast('Capture or open a question before requesting analysis.', 'error'); return; }
    if (!question.questionText && !question.imageData) { toast('Add question text or retain a capture before requesting analysis.', 'error'); return; }
    question.analysis = { status: 'analyzing' };
    await persistQuestion(question);
    renderAnalysis(question);
    els.analyzeButton.disabled = true;
    els.analyzeButton.textContent = 'Analyzing…';
    try {
      const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questionText: question.questionText, options: question.options, imageData: question.imageData || undefined }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.analysis) throw new Error(payload.message || payload.error || 'Secure analysis is unavailable for this deployment.');
      const result = payload.analysis;
      if (!question.questionText) question.questionText = result.question;
      if (!question.options?.length) question.options = result.options;
      question.questionType = result.question_type;
      question.analysis = {
        status: 'ready',
        suggestedAnswer: result.suggested_answer,
        answerText: result.answer_text,
        explanation: result.explanation,
        confidence: result.confidence,
        needsVerification: result.needs_verification,
        ambiguityDetected: result.ambiguity_detected,
        auditFlags: result.audit_flags,
        resultStatus: result.status,
      };
      question.confidence = result.confidence;
      question.verificationStatus = result.needs_verification ? 'needs_verification' : question.verificationStatus;
      question.flags = [...new Set([...(question.flags || []), ...(result.audit_flags || []), ...(result.ambiguity_detected ? ['Potential ambiguity detected'] : [])])];
      await persistQuestion(question);
      renderEverything();
      toast(result.status === 'ai_suggested' ? 'AI suggestion is ready. Verify it independently.' : 'Analysis saved; the capture needs closer review.', 'success');
    } catch (error) {
      question.analysis = { status: 'not_configured', error: String(error?.message || '') };
      await persistQuestion(question);
      renderAnalysis(question);
      toast(error?.message || 'Secure analysis could not be completed. Your capture is saved for retry.', 'error');
    } finally {
      els.analyzeButton.disabled = false;
      els.analyzeButton.textContent = 'Analyze securely';
    }
  }

  async function copyQuestion() {
    const question = snapshotQuestionFromWorkspace();
    if (!question) return;
    const content = [question.questionText, ...(question.options || []).map((option) => `${option.label}. ${option.text}`)].filter(Boolean).join('\n');
    if (!content) { toast('Add question text before copying.', 'error'); return; }
    try {
      await navigator.clipboard.writeText(content);
      toast('Question copied to clipboard.', 'success');
    } catch (error) {
      toast('Copy was blocked by this browser. Select the text and copy it manually.', 'error');
    }
  }

  function googleSearch() {
    const question = snapshotQuestionFromWorkspace();
    if (!question?.questionText) { toast('Add or paste question text before searching.', 'error'); return; }
    const query = [question.questionText, ...(question.options || []).map((option) => option.text)].filter(Boolean).join(' ');
    window.open(`https://www.google.com/search?q=${encodeURIComponent(query)}`, '_blank', 'noopener,noreferrer');
    toast('Opened an independent search in a new tab. It has not changed verification status.');
  }

  function selectQuestion(questionId) {
    const question = state.questions.find((item) => item.id === questionId);
    if (!question) return;
    state.currentSessionId = question.sessionId;
    state.currentQuestionId = question.id;
    renderEverything();
  }

  function navigateQuestion(direction) {
    const questions = questionsForSession();
    const index = questions.findIndex((question) => question.id === state.currentQuestionId);
    const target = questions[index + direction];
    if (target) {
      state.currentQuestionId = target.id;
      renderEverything();
    }
  }

  async function saveVerification(item) {
    const id = item.dataset.questionId;
    const question = state.questions.find((candidate) => candidate.id === id);
    if (!question) return;
    const note = $('.history-note', item)?.value.trim() || '';
    const sourceUrl = $('.verification-url', item)?.value.trim() || '';
    const result = $('.verification-result', item)?.value || 'reference';
    question.notes = note;
    if (sourceUrl) {
      try {
        const url = new URL(sourceUrl);
        if (!/^https?:$/.test(url.protocol)) throw new Error('Unsupported protocol');
        question.verificationSources = [...(question.verificationSources || []), { id: uid(), sourceUrl: url.href, result, createdAt: now() }];
        if (result === 'supports') question.verificationStatus = 'verified';
        if (result === 'contradicts') {
          question.verificationStatus = 'needs_verification';
          question.flags = [...new Set([...(question.flags || []), 'Verification source contradicts suggestion'])];
        }
      } catch (error) {
        toast('Add a complete http or https source URL, or leave it blank to save just a note.', 'error');
        return;
      }
    }
    await persistQuestion(question);
    renderEverything();
    toast(sourceUrl ? 'Evidence and review note saved.' : 'Review note saved.', 'success');
  }

  async function markVerified(item) {
    const question = state.questions.find((candidate) => candidate.id === item.dataset.questionId);
    if (!question) return;
    question.notes = $('.history-note', item)?.value.trim() || question.notes || '';
    question.verificationStatus = 'verified';
    await persistQuestion(question);
    renderEverything();
    toast('Marked verified. Make sure your note or source supports this decision.', 'success');
  }

  function confirmAction({ title, message, confirmLabel, action }) {
    state.pendingConfirm = action;
    els.confirmTitle.textContent = title;
    els.confirmMessage.textContent = message;
    els.confirmActionButton.textContent = confirmLabel;
    els.confirmDialog.showModal();
  }

  async function deleteQuestion(questionId) {
    const question = state.questions.find((item) => item.id === questionId);
    if (!question) return;
    confirmAction({
      title: 'Delete this question?',
      message: 'This removes the captured image, transcription, and local notes from this browser. This cannot be undone.',
      confirmLabel: 'Delete question',
      action: async () => {
        await db.delete('questions', question.id);
        state.questions = state.questions.filter((item) => item.id !== question.id);
        if (state.currentQuestionId === question.id) state.currentQuestionId = null;
        renderEverything();
        toast('Question removed from this browser.', 'success');
      },
    });
  }

  function csvValue(value) { const text = String(value ?? ''); return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text; }
  function exportRows(sessionId = 'all') {
    const questions = sessionId === 'all' ? state.questions : state.questions.filter((question) => question.sessionId === sessionId);
    return [...questions].sort(questionSort).map((question) => ({
      question_id: question.id,
      session: state.sessions.find((session) => session.id === question.sessionId)?.title || '',
      question_number: question.questionNumber,
      captured_at: question.createdAt,
      source: sourceName(question.captureSource),
      question_text: question.questionText || '',
      options: (question.options || []).map((option) => `${option.label}. ${option.text}`).join(' | '),
      ai_status: question.analysis?.status || 'not_configured',
      ai_suggested_answer: question.analysis?.suggestedAnswer?.join(', ') || '',
      explanation: question.analysis?.explanation || '',
      verification_status: question.verificationStatus || 'needs_verification',
      audit_flags: (question.flags || []).join(' | '),
      notes: question.notes || '',
      sources: (question.verificationSources || []).map((source) => `${source.result}: ${source.sourceUrl}`).join(' | '),
    }));
  }

  function downloadFile(name, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportCsv() {
    const rows = exportRows(els.reportSessionSelect.value || 'all');
    if (!rows.length) { toast('There are no saved questions to export yet.', 'error'); return; }
    const headers = Object.keys(rows[0]);
    const csv = [headers.join(','), ...rows.map((row) => headers.map((key) => csvValue(row[key])).join(','))].join('\r\n');
    downloadFile('quizlens-audit-report.csv', csv, 'text/csv;charset=utf-8');
    toast('CSV report downloaded.', 'success');
  }

  function exportJson() {
    const selected = els.reportSessionSelect.value || 'all';
    const backup = { exportedAt: now(), format: 'QuizLens AI local audit export', sessions: selected === 'all' ? state.sessions : state.sessions.filter((session) => session.id === selected), questions: selected === 'all' ? state.questions : state.questions.filter((question) => question.sessionId === selected) };
    if (!backup.questions.length) { toast('There are no saved questions to export yet.', 'error'); return; }
    downloadFile('quizlens-audit-export.json', JSON.stringify(backup, null, 2), 'application/json');
    toast('JSON export downloaded.', 'success');
  }

  function exportSettingsBackup() {
    const backup = { exportedAt: now(), format: 'QuizLens AI browser-local backup', sessions: state.sessions, questions: state.questions };
    downloadFile('quizlens-browser-backup.json', JSON.stringify(backup, null, 2), 'application/json');
    toast('Browser-local backup downloaded.', 'success');
  }

  function bindEvents() {
    document.addEventListener('click', async (event) => {
      const nav = event.target.closest('[data-view-target]');
      if (nav) { switchView(nav.dataset.viewTarget); return; }
      const action = event.target.closest('[data-action]');
      if (!action) return;
      const actionName = action.dataset.action;
      if (actionName === 'open-session') openSessionDialog();
      if (actionName === 'resume-session') { state.currentSessionId = action.dataset.sessionId; state.currentQuestionId = questionsForSession(action.dataset.sessionId)[0]?.id || null; renderEverything(); switchView('capture'); }
      if (actionName === 'clear-history-filters') { els.historySearch.value = ''; els.historySessionFilter.value = 'all'; els.historyStatusFilter.value = 'all'; renderHistory(); }
      if (actionName === 'open-question') { selectQuestion(action.closest('.history-item').dataset.questionId); switchView('capture'); }
      if (actionName === 'expand-question') action.closest('.history-item').classList.toggle('expanded');
      if (actionName === 'delete-question') await deleteQuestion(action.closest('.history-item').dataset.questionId);
      if (actionName === 'save-verification') await saveVerification(action.closest('.history-item'));
      if (actionName === 'mark-verified') await markVerified(action.closest('.history-item'));
    });

    $('#newAuditButton').addEventListener('click', openSessionDialog);
    $('#recentStartButton')?.addEventListener('click', openSessionDialog);
    $('#historyNewAudit').addEventListener('click', openSessionDialog);
    $('#openHelp').addEventListener('click', () => els.helpDialog.showModal());
    $('#integrityHelp').addEventListener('click', () => els.helpDialog.showModal());
    els.mobileMenuButton.addEventListener('click', () => els.sidebar.classList.toggle('open'));
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') els.sidebar.classList.remove('open'); });

    els.sessionForm.addEventListener('submit', async (event) => {
      if (event.submitter?.value === 'cancel') return;
      event.preventDefault();
      if (!els.sessionForm.reportValidity()) return;
      await createSession();
    });
    els.confirmDialog.addEventListener('close', async () => {
      if (els.confirmDialog.returnValue === 'confirm' && state.pendingConfirm) {
        const action = state.pendingConfirm;
        state.pendingConfirm = null;
        try { await action(); } catch (error) { console.error(error); toast('That change could not be completed.', 'error'); }
      }
      state.pendingConfirm = null;
    });

    $$('.source-tab').forEach((button) => button.addEventListener('click', () => setSource(button.dataset.source)));
    els.imageUpload.addEventListener('change', (event) => handleUpload(event.target.files?.[0]));
    els.startCaptureButton.addEventListener('click', startCapture);
    els.pauseCaptureButton.addEventListener('click', () => { if (state.isPaused) resumeCapture(); else pauseCapture(); });
    els.manualCaptureButton.addEventListener('click', manualCapture);
    els.stopCaptureButton.addEventListener('click', () => stopCapture());
    els.captureInterval.addEventListener('change', () => {
      if (state.isCapturing) {
        window.clearInterval(state.autoTimer);
        state.autoTimer = window.setInterval(() => captureFrame({ manual: false }), Number(els.captureInterval.value));
        toast(`Detection interval set to ${Number(els.captureInterval.value) / 1000} seconds.`);
      }
    });
    els.captureCrop.addEventListener('change', () => {
      state.lastFrameHash = null;
      state.candidateHash = null;
      state.candidateCount = 0;
      updateCaptureMessage('Question region changed. Establishing a new comparison baseline…', state.isCapturing);
      toast(els.captureCrop.value === 'center' ? 'Capture will compare the central question region.' : 'Capture will compare the full source.');
    });

    els.questionText.addEventListener('input', scheduleQuestionSave);
    els.optionsList.addEventListener('input', scheduleQuestionSave);
    els.optionsList.addEventListener('click', (event) => {
      const remove = event.target.closest('.remove-option');
      if (!remove) return;
      const question = snapshotQuestionFromWorkspace();
      if (!question) return;
      question.options.splice(Number(remove.dataset.optionIndex), 1);
      persistQuestion(question, { render: true });
    });
    els.addOptionButton.addEventListener('click', async () => {
      const question = snapshotQuestionFromWorkspace();
      if (!question) return;
      question.options = [...(question.options || []), { label: String.fromCharCode(65 + question.options.length), text: '' }];
      await persistQuestion(question);
      renderQuestion();
      const inputs = $$('.option-input', els.optionsList);
      inputs[inputs.length - 1]?.focus();
    });
    els.analyzeButton.addEventListener('click', analyzeQuestion);
    els.googleSearchButton.addEventListener('click', googleSearch);
    els.copyQuestionButton.addEventListener('click', copyQuestion);
    els.flagQuestionButton.addEventListener('click', toggleFlag);
    els.saveNextButton.addEventListener('click', saveAndNext);
    els.toggleQuestionRail.addEventListener('click', () => { els.questionRail.hidden = !els.questionRail.hidden; });
    els.questionRailList.addEventListener('click', (event) => { const item = event.target.closest('[data-question-id]'); if (item) { selectQuestion(item.dataset.questionId); renderQuestionRail(); } });
    els.previousQuestionButton.addEventListener('click', () => navigateQuestion(-1));
    els.nextQuestionButton.addEventListener('click', () => navigateQuestion(1));

    els.historySearch.addEventListener('input', renderHistory);
    els.historySessionFilter.addEventListener('change', renderHistory);
    els.historyStatusFilter.addEventListener('change', renderHistory);
    els.clearFiltersButton.addEventListener('click', () => { els.historySearch.value = ''; els.historySessionFilter.value = 'all'; els.historyStatusFilter.value = 'all'; renderHistory(); });
    els.reportSessionSelect.addEventListener('change', renderReports);
    els.exportCsvButton.addEventListener('click', exportCsv);
    els.exportJsonButton.addEventListener('click', exportJson);
    els.exportPdfButton.addEventListener('click', () => { if (!state.questions.length) { toast('There are no saved questions to print yet.', 'error'); return; } window.print(); });
    els.settingsExportButton.addEventListener('click', exportSettingsBackup);
    els.clearDataButton.addEventListener('click', () => confirmAction({ title: 'Clear local workspace?', message: 'This permanently deletes all browser-local sessions, images, notes, and verification records. Export a JSON backup first if you want to keep them.', confirmLabel: 'Clear local data', action: async () => { await stopCapture('Capture stopped because local data was cleared.'); await db.clearAll(); state.sessions = []; state.questions = []; state.currentSessionId = null; state.currentQuestionId = null; state.uploadDataUrl = null; els.captureImage.removeAttribute('src'); els.captureImage.hidden = true; els.previewPlaceholder.hidden = false; renderEverything(); toast('Browser-local workspace cleared.', 'success'); } }));
  }

  init();
})();
