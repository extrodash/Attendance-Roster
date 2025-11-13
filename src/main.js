import { initRouter, showView } from './router.js';

// Will be assigned after globals load
let DB = null;

// Global state
const state = {
  settings: null,
  eventTypes: [],
  people: [],
  currentDate: null,
  currentEventTypeId: null,
  currentSessionId: null,
  currentRecords: new Map(), // personId -> record
  showAll: false,
  editingNotesFor: null,
  selectedPersonId: null,
  officeGaps: [],
  personModalMode: null,
  editingPersonId: null,
  pendingTardyPersonId: null,
};

// Desired check-in flow order (Office first)
const FLOW_ORDER = ['work', 'meeting', 'gospel'];
const DEFAULT_LEGEND_THRESHOLDS = { low: 0.75, mid: 0.89, high: 0.90 };
const REQUIRED_EVENT_ID = 'work';
const OPTIONAL_EVENT_IDS = new Set(['meeting', 'gospel']);
const DAY_SEQUENCE = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const EARLY_STATUSES = new Set(['early_leave', 'very_early_leave']);
const STATUS_WEIGHTS = {
  present: 1.0,
  online: 0.95,
  excused: 0.5,
  tardy: 0.75,
  early_leave: 0.95,
  very_early_leave: 0.7,
  absent: 0.0,
  non_service: 0.0
};

function recordStatusKeys(record) {
  if (!record) return [];
  const keys = [];
  const base = record.status;
  if (base) keys.push(base);
  const leave = record.leaveStatus;
  if (leave && leave !== base) keys.push(leave);
  return keys;
}

function recordWeight(record) {
  const keys = recordStatusKeys(record);
  if (!keys.length) return 0;
  let weight = STATUS_WEIGHTS[keys[0]] ?? 0;
  for (let i = 1; i < keys.length; i += 1) {
    const key = keys[i];
    const w = STATUS_WEIGHTS[key];
    if (typeof w === 'number') {
      weight = Math.min(weight, w);
    }
  }
  return weight;
}

function accumulateRecordCounts(counts, record) {
  const keys = recordStatusKeys(record);
  if (!keys.length) return false;
  let counted = false;
  for (const key of keys) {
    if (!key) continue;
    counts[key] = (counts[key] || 0) + 1;
    counted = true;
  }
  return counted;
}

function isStatusActive(record, statusId) {
  if (!record || !statusId) return false;
  if (EARLY_STATUSES.has(statusId)) {
    return record.status === statusId || record.leaveStatus === statusId;
  }
  return record.status === statusId;
}

function statusLabelText(status) {
  switch (status) {
    case 'present': return 'Present';
    case 'online': return 'Online';
    case 'excused': return 'Excused';
    case 'tardy': return 'Tardy';
    case 'absent': return 'Absent';
    case 'early_leave': return 'Left Early';
    case 'very_early_leave': return 'Left Very Early';
    case 'non_service': return 'Not Serving';
    default: return status || '';
  }
}

function shortDayLabel(day) {
  if (!day) return '';
  const normalized = String(day).trim().toLowerCase();
  const map = {
    sunday: 'Sun', sun: 'Sun',
    monday: 'Mon', mon: 'Mon',
    tuesday: 'Tue', tue: 'Tue', tues: 'Tue',
    wednesday: 'Wed', wed: 'Wed',
    thursday: 'Thu', thu: 'Thu', thurs: 'Thu',
    friday: 'Fri', fri: 'Fri',
    saturday: 'Sat', sat: 'Sat',
  };
  if (map[normalized]) return map[normalized];
  return normalized.slice(0, 3).charAt(0).toUpperCase() + normalized.slice(1, 3);
}

function formatServiceDayBadge(days = []) {
  if (!Array.isArray(days) || days.length === 0) return null;
  const unique = [];
  const seen = new Set();
  for (const day of days) {
    const short = shortDayLabel(day);
    if (short && !seen.has(short)) {
      seen.add(short);
      unique.push(short);
    }
  }
  if (!unique.length) return null;
  const sorted = [...unique].sort((a, b) => DAY_SEQUENCE.indexOf(a) - DAY_SEQUENCE.indexOf(b));
  const indices = sorted.map(label => DAY_SEQUENCE.indexOf(label));
  const sequential = sorted.length > 1 && indices.every((idx, i, arr) => idx !== -1 && (i === 0 || arr[i] - arr[i - 1] === 1));
  if (sorted.length === 1) {
    return { mode: 'single', text: sorted[0], tooltip: sorted[0] };
  }
  if (sequential) {
    return {
      mode: 'range',
      text: `${sorted[0]}–${sorted[sorted.length - 1]}`,
      tooltip: sorted.join(', ')
    };
  }
  return {
    mode: 'list',
    parts: sorted,
    tooltip: sorted.join(', ')
  };
}

function sortEventTypesByFlow(eventTypes) {
  const idx = (id) => {
    const i = FLOW_ORDER.indexOf(id);
    return i === -1 ? 999 : i;
  };
  return [...eventTypes].sort((a, b) => {
    const da = idx(a.id);
    const db = idx(b.id);
    if (da !== db) return da - db;
    return (a.label || '').localeCompare(b.label || '');
  });
}

// DOM shortcuts
const titleEl = document.getElementById('app-title');

// Take view controls
const takeDateEl = document.getElementById('take-date');
const takeDatePrevBtn = document.getElementById('take-date-prev');
const takeDateNextBtn = document.getElementById('take-date-next');
const takeDateTodayBtn = document.getElementById('take-date-today');
const takeEventEl = document.getElementById('take-event');
const eventStepper = document.getElementById('event-stepper');
const takeSearchEl = document.getElementById('take-search');
const takeShowAllEl = document.getElementById('take-show-all');
const peopleListEl = document.getElementById('people-list');
const takeTrackingStatsEl = document.getElementById('take-tracking-stats');
const takeHiddenInfoEl = document.getElementById('take-hidden-info');
const takeHiddenCountEl = document.getElementById('take-hidden-count');
const takeHiddenToggleBtn = document.getElementById('take-hidden-toggle');
const takeHiddenHideBtn = document.getElementById('take-hidden-hide');
const btnAllPresent = document.getElementById('mark-all-present');
const btnClearAll = document.getElementById('clear-all');
const btnSaveAttendance = document.getElementById('save-attendance');
const btnSaveDownloadAttendance = document.getElementById('save-download-attendance');
const btnPrintAttendance = document.getElementById('print-attendance');
const takeSummaryEl = document.getElementById('take-summary');
const takeDateHint = document.getElementById('date-helper');
// Navigator controls
const navigatorListEl = document.getElementById('navigator-gaps');

// Insights controls
const analyticsFrom = document.getElementById('analytics-from');
const analyticsTo = document.getElementById('analytics-to');
const analyticsEvent = document.getElementById('analytics-event');
const analyticsRunBtn = document.getElementById('analytics-run');
const analyticsApplyEventWeight = document.getElementById('analytics-apply-event-weight');
const analyticsSmoothRate = document.getElementById('analytics-smooth-rate');
const analyticsShowPresent = document.getElementById('analytics-show-present');
const analyticsShowOnline = document.getElementById('analytics-show-online');
const analyticsShowExcused = document.getElementById('analytics-show-excused');
const analyticsShowTardy = document.getElementById('analytics-show-tardy');
const analyticsShowAbsent = document.getElementById('analytics-show-absent');
const analyticsShowRate = document.getElementById('analytics-show-rate');
const analyticsActiveOnly = document.getElementById('analytics-active-only');
const analyticsTag = document.getElementById('analytics-tag');
const analyticsRange14 = document.getElementById('analytics-range-14');
const analyticsRange30 = document.getElementById('analytics-range-30');
const analyticsRange90 = document.getElementById('analytics-range-90');
const analyticsExportCsvBtn = document.getElementById('analytics-export-csv');
const analyticsCompare = document.getElementById('analytics-compare');
const analyticsSummaryEl = document.getElementById('analytics-summary');
const analyticsDaysEl = document.getElementById('analytics-days');
const totalsPresentEl = document.getElementById('totals-present');
const totalsOnlineEl = document.getElementById('totals-online');
const totalsExcusedEl = document.getElementById('totals-excused');
const totalsTardyEl = document.getElementById('totals-tardy');
const totalsAbsentEl = document.getElementById('totals-absent');
const totalsRateEl = document.getElementById('totals-rate');
const heatmapEl = document.getElementById('dow-heatmap');

// Trends controls
const trendsFrom = document.getElementById('trends-from');
const trendsTo = document.getElementById('trends-to');
const trendsEvent = document.getElementById('trends-event');
const trendsApplyEventWeight = document.getElementById('trends-apply-event-weight');
const trendsRunBtn = document.getElementById('trends-run');
const trendsPeopleEl = document.getElementById('trends-people');
const trendsStatusDowEl = document.getElementById('trends-status-dow');
const trendsSearchEl = document.getElementById('trends-search');
const trendsActiveOnly = document.getElementById('trends-active-only');
const trendsTag = document.getElementById('trends-tag');
const trendsSort = document.getElementById('trends-sort');
const trendsRange14 = document.getElementById('trends-range-14');
const trendsRange30 = document.getElementById('trends-range-30');
const trendsRange90 = document.getElementById('trends-range-90');
const trendsExportCsvBtn = document.getElementById('trends-export-csv');
const trendsLoadMoreBtn = document.getElementById('trends-load-more');
const trendsSummaryEl = document.getElementById('trends-summary');
const trendsThreshLow = document.getElementById('trends-thresh-low');
const trendsThreshHigh = document.getElementById('trends-thresh-high');
const trendsThreshReadout = document.getElementById('trends-thresh-readout');
const trendsApplyThresholdsBtn = document.getElementById('trends-apply-thresholds');
const trendsThreshPreset = document.getElementById('trends-thresh-preset');

// Calendar controls
const calMonthEl = document.getElementById('cal-month');
const calMonthPrevBtn = document.getElementById('cal-month-prev');
const calMonthNextBtn = document.getElementById('cal-month-next');
const calEventEl = document.getElementById('cal-event');
const calApplyEventWeightEl = document.getElementById('cal-apply-event-weight');
const calTodayBtn = document.getElementById('cal-today');
const calGridEl = document.getElementById('calendar-grid');
const calDetailEl = document.getElementById('calendar-detail');
const calWeeksEl = document.getElementById('calendar-weeks');

// Roster controls
const rosterTbody = document.getElementById('roster-tbody');
const btnAddPerson = document.getElementById('add-person-btn');

// Modal / toast
const notesModal = document.getElementById('notes-modal');
const notesText = document.getElementById('notes-text');
const notesSave = document.getElementById('notes-save');
const notesCancel = document.getElementById('notes-cancel');
const toastEl = document.getElementById('toast');
const personModal = document.getElementById('person-modal');
const personForm = document.getElementById('person-form');
const personModalTitle = document.getElementById('person-modal-title');
const personNameInput = document.getElementById('person-name');
const personActiveInput = document.getElementById('person-active');
const personTagsInput = document.getElementById('person-tags');
const personDayCheckboxes = personForm ? Array.from(personForm.querySelectorAll('[data-day]')) : [];
const personCancelBtn = document.getElementById('person-cancel');
const tardyModal = document.getElementById('tardy-modal');
const tardyForm = document.getElementById('tardy-form');
const tardyMinutesInput = document.getElementById('tardy-minutes');
const tardyPersonLabel = document.getElementById('tardy-person');
const tardyCancelBtn = document.getElementById('tardy-cancel');

// Person (details) controls
const personTitleEl = document.getElementById('person-title');
const personFrom = document.getElementById('person-from');
const personTo = document.getElementById('person-to');
const personEvent = document.getElementById('person-event');
const personApplyEventWeight = document.getElementById('person-apply-event-weight');
const personSummaryEl = document.getElementById('person-summary');
const personDOWIndEl = document.getElementById('person-dow-individual');
const personDOWTeamEl = document.getElementById('person-dow-team');
const personDaysEl = document.getElementById('person-days');
const personBackTrendsBtn = document.getElementById('person-back-trends');

function showToast(msg, ms = 1200) {
  if (!toastEl) return; toastEl.innerHTML = msg; toastEl.hidden = false; if (ms > 0) window.setTimeout(() => (toastEl.hidden = true), ms);
}

// Tracking coverage for Check-In (ratio of tracked vs blank weekdays from first session to today)
async function renderTrackingStats() {
  if (!takeTrackingStatsEl) return;
  if (!state.people || state.people.length === 0) {
    takeTrackingStatsEl.hidden = true;
    state.officeGaps = [];
    renderNavigatorGaps();
    return;
  }
  try {
    const firstRequired = await DB.dexie.sessions
      .orderBy('date')
      .filter(s => s.eventTypeId === REQUIRED_EVENT_ID)
      .first();
    if (!firstRequired) {
      takeTrackingStatsEl.hidden = true;
      state.officeGaps = [];
      renderNavigatorGaps();
      return;
    }
    const from = firstRequired.date;
    const to = dayjs().format('YYYY-MM-DD');
    const { sessions, records } = await DB.recordsForRange(from, to);
    const requiredSessions = sessions.filter(s => s.eventTypeId === REQUIRED_EVENT_ID);
    const sessionsByDate = new Map();
    for (const s of requiredSessions) {
      if (!sessionsByDate.has(s.date)) sessionsByDate.set(s.date, []);
      sessionsByDate.get(s.date).push(s);
    }
    const requiredSessionIds = new Set(requiredSessions.map(s => s.id));
    const recordsBySession = new Map();
    for (const r of records) {
      if (!requiredSessionIds.has(r.sessionId)) continue;
      if (!recordsBySession.has(r.sessionId)) recordsBySession.set(r.sessionId, []);
      recordsBySession.get(r.sessionId).push(r);
    }

    const officeGaps = [];
    let complete = 0;
    let partial = 0;
    let blank = 0;

    const activePeople = state.people.filter(p => p && p.active !== false);

    for (let d = dayjs(from); d.isBefore(dayjs(to)) || d.isSame(dayjs(to), 'day'); d = d.add(1, 'day')) {
      const iso = ((d.day() + 6) % 7) + 1;
      if (iso < 1 || iso > 5) continue; // weekdays (Mon-Fri)
      const ds = d.format('YYYY-MM-DD');
      const scheduled = activePeople.filter(p => isPersonServingOn(ds, p));
      if (!scheduled.length) continue;

      const sessionCandidates = sessionsByDate.get(ds) || [];
      const session = sessionCandidates[0] || null;
      if (!session) {
        blank += 1;
        continue;
      }

      const recs = recordsBySession.get(session.id) || [];
      const recByPerson = new Map(recs.map(r => [r.personId, r]));

      let recordedCount = 0;
      const missing = [];
      for (const person of scheduled) {
        const rec = recByPerson.get(person.id);
        const status = rec?.status;
        if (status) {
          recordedCount += 1;
          continue;
        }
        missing.push(person);
      }

      if (missing.length === 0) {
        complete += 1;
        continue;
      }

      const gapType = recordedCount === 0 ? 'blank' : 'partial';
      if (gapType === 'blank') blank += 1; else partial += 1;

      officeGaps.push({
        date: ds,
        missing: missing.length,
        total: scheduled.length,
        type: gapType,
        names: missing.slice(0, 3).map(p => p.displayName || 'Unnamed'),
      });
    }

    const totalDays = complete + partial + blank;
    const coveragePct = totalDays ? Math.round((complete / totalDays) * 100) : 0;
    takeTrackingStatsEl.setAttribute('aria-label', 'Office coverage since first log');
    takeTrackingStatsEl.innerHTML = `
      <div class="navigator-stat">
        <span class="navigator-stat__label">office complete</span>
        <strong class="navigator-stat__value">${complete}</strong>
      </div>
      <div class="navigator-stat">
        <span class="navigator-stat__label">office pending</span>
        <strong class="navigator-stat__value">${partial}</strong>
      </div>
      <div class="navigator-stat">
        <span class="navigator-stat__label">office blanks</span>
        <strong class="navigator-stat__value">${blank}</strong>
      </div>
      <div class="navigator-stat">
        <span class="navigator-stat__label">office coverage</span>
        <strong class="navigator-stat__value">${coveragePct}%</strong>
      </div>`;
    takeTrackingStatsEl.hidden = totalDays === 0;

    state.officeGaps = officeGaps.sort((a, b) => a.date.localeCompare(b.date));
    renderNavigatorGaps();
  } catch (e) {
    console.warn('renderTrackingStats error', e);
    takeTrackingStatsEl.hidden = true;
    state.officeGaps = [];
    renderNavigatorGaps();
  }
}

// Router
document.querySelectorAll('[data-route]').forEach(btn => btn.addEventListener('click', (e) => {
  const route = e.currentTarget.getAttribute('data-route'); window.location.hash = route;
}));

// When route changes to person, render the view
window.addEventListener('hashchange', () => {
  const key = (window.location.hash.replace('#/', '') || 'take').split('?')[0];
  if (key === 'person') {
    renderPersonView();
  }
});

// Helpers
function isoWeekday(dateStr) { const d = dayjs(dateStr); return ((d.day() + 6) % 7) + 1; }
function isoDowName(n) { return ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'][n-1]; }
function debounce(fn, ms) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; }

function updateTakeDateHint() {
  if (!takeDateHint) return;
  const raw = takeDateEl?.value || state.currentDate;
  if (!raw) {
    takeDateHint.textContent = '';
    return;
  }
  const d = dayjs(raw);
  if (!d.isValid()) {
    takeDateHint.textContent = '';
    return;
  }
  const today = dayjs();
  let prefix = '';
  if (d.isSame(today, 'day')) prefix = 'Today • ';
  else if (d.isSame(today.subtract(1, 'day'), 'day')) prefix = 'Yesterday • ';
  else if (d.isSame(today.add(1, 'day'), 'day')) prefix = 'Tomorrow • ';
  takeDateHint.textContent = `${prefix}${d.format('dddd, MMM D')}`;
}

function pickDefaultEventTypeId() {
  const stored = localStorage.getItem('lastEventTypeId');
  const hasStored = stored && state.eventTypes.some(t => t.id === stored);
  if (hasStored && !OPTIONAL_EVENT_IDS.has(stored)) return stored;
  const office = state.eventTypes.find(t => t.id === REQUIRED_EVENT_ID) || state.eventTypes[0];
  const fallback = office?.id || '';
  if (fallback) localStorage.setItem('lastEventTypeId', fallback);
  return fallback;
}

function labelWithPriority(t) {
  if (!t) return '';
  if (t.id === REQUIRED_EVENT_ID) return `${t.label} (Required)`;
  return t.label;
}

function hydrateEventTypeSelects() {
  const opts = state.eventTypes.map(t => `<option value="${t.id}">${labelWithPriority(t)}</option>`).join('');
  if (takeEventEl) takeEventEl.innerHTML = opts;
  if (analyticsEvent) analyticsEvent.innerHTML = `<option value="">All</option>` + opts;
  if (calEventEl) calEventEl.innerHTML = `<option value="">All</option>` + opts;
  if (trendsEvent) trendsEvent.innerHTML = `<option value="">All</option>` + opts;
  if (personEvent) personEvent.innerHTML = `<option value="">All</option>` + opts;
}

function buildEventStepper() {
  if (!eventStepper) return;
  eventStepper.innerHTML = '';
  state.eventTypes.forEach((t) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    const classes = ['step-btn'];
    if (t.id === REQUIRED_EVENT_ID) classes.push('step-btn--primary');
    else if (OPTIONAL_EVENT_IDS.has(t.id)) classes.push('step-btn--optional');
    btn.className = classes.join(' ');
    btn.dataset.priority = OPTIONAL_EVENT_IDS.has(t.id) ? 'supplemental' : 'required';
    btn.setAttribute('role', 'tab');
    const active = state.currentEventTypeId ? state.currentEventTypeId === t.id : t.id === REQUIRED_EVENT_ID;
    btn.setAttribute('aria-current', String(active));
    const isRequired = t.id === REQUIRED_EVENT_ID;
    btn.innerHTML = `
      <span class="step-title">${t.label}</span>
      ${isRequired ? '<span class="step-sub">Required</span>' : ''}
    `;
    btn.addEventListener('click', () => {
      takeEventEl.value = t.id;
      localStorage.setItem('lastEventTypeId', t.id);
      ensureSession().then(renderPeopleList);
    });
    const dot = document.createElement('span');
    dot.className = 'step-dot';
    dot.setAttribute('aria-hidden', 'true');
    btn.appendChild(dot);
    eventStepper.appendChild(btn);
  });
  // mark dots for sessions with data
  const date = takeDateEl.value || state.currentDate;
  for (const t of state.eventTypes) {
    const sid = `${date}_${t.id}`; DB.recordsForSession(sid).then(recs => {
      const idx = state.eventTypes.findIndex(x=>x.id===t.id);
      const btn = eventStepper.children[idx]; if (btn) btn.setAttribute('data-has-records', String(recs.length>0));
    });
  }
}

async function loadSettingsAndTypes() {
  state.settings = await DB.dexie.settings.get('app');
  state.eventTypes = sortEventTypesByFlow(await DB.listEventTypes());
  const desired = new Map([
    ['work', { label: 'Office', weight: 1 }],
    ['meeting', { label: 'Morning Meeting', weight: 0.25 }],
    ['gospel', { label: 'Afternoon Meeting', weight: 0.2 }]
  ]);
  let updated = false;
  for (const [id, meta] of desired) {
    const existing = state.eventTypes.find(t => t.id === id);
    if (!existing) continue;
    let dirty = false;
    if (meta.label && existing.label !== meta.label) { existing.label = meta.label; dirty = true; }
    if (typeof meta.weight === 'number' && existing.weight !== meta.weight) { existing.weight = meta.weight; dirty = true; }
    if (dirty) { await DB.saveEventType(existing); updated = true; }
  }
  if (updated) state.eventTypes = sortEventTypesByFlow(await DB.listEventTypes());
  titleEl.textContent = state.settings?.teamName || 'Attendance';
  hydrateEventTypeSelects();
  buildEventStepper();
  renderEventTypesTable();
  syncSettingsForm();
}

async function loadPeople() { state.people = await DB.listPeople(); }

function personRowTemplate(person, record) {
  const statuses = [
    { id: 'present', label: 'Present', hint: 'In-person' },
    { id: 'online', label: 'Online', hint: 'Remote' },
    { id: 'excused', label: 'Excused', hint: 'Planned away' },
    { id: 'tardy', label: 'Tardy', hint: 'Minutes late' },
    { id: 'absent', label: 'Absent', hint: 'Unaccounted' },
    { id: 'early_leave', label: 'Left Early', hint: 'Partial' },
    { id: 'very_early_leave', label: 'Left Very Early', hint: 'Short stay' },
    { id: 'non_service', label: 'N/A', hint: 'Not serving' }
  ];
  const initials = (person.displayName || '')
    .split(/\s+/)
    .filter(Boolean)
    .map(part => part[0]?.toUpperCase() || '')
    .join('')
    .slice(0, 2) || '–';
  const tags = (person.tags || []).join(', ');
  const notes = record?.notes;
  const minutesLate = record?.minutesLate && Number.isFinite(record.minutesLate) ? record.minutesLate : null;
  const serviceDays = Array.isArray(person.serviceDays) ? person.serviceDays : [];
  const dayBadge = formatServiceDayBadge(serviceDays);
  const badgeTitle = dayBadge ? `Serving ${dayBadge.tooltip}` : '';
  const fullName = person.fullName || person.displayName;
  const footnotes = [];
  if (minutesLate) footnotes.push(`<span>${minutesLate} min late</span>`);
  const activeEarlyStatuses = new Set(recordStatusKeys(record).filter(st => EARLY_STATUSES.has(st)));
  if (activeEarlyStatuses.has('very_early_leave')) {
    footnotes.push('<span>Left very early</span>');
  } else if (activeEarlyStatuses.has('early_leave')) {
    footnotes.push('<span>Left early</span>');
  }
  if (person.active === false) footnotes.push('<span class="chip tone-danger">Inactive</span>');
  const footnoteDays = !dayBadge && serviceDays.length
    ? `<span class="chip tone-info">${serviceDays.map(shortDayLabel).join(' · ')}</span>`
    : '';
  if (footnoteDays) footnotes.push(footnoteDays);
  const badgeMarkup = dayBadge
    ? dayBadge.mode === 'list'
      ? `<span class="day-badge day-badge--list" title="${badgeTitle}">${dayBadge.parts.map(part => `<span>${part}</span>`).join('')}</span>`
      : `<span class="day-badge" title="${badgeTitle}">${dayBadge.text}</span>`
    : '';
  const noteStatus = notes ? 'Notes saved' : 'No notes yet';
  return `
    <li class="person-row" data-person-id="${person.id}">
      ${badgeMarkup}
      <div class="person-header">
        <div class="person-meta">
          <span class="person-avatar" aria-hidden="true">${initials}</span>
          <div class="person-name-block">
            <button type="button" class="person-name">${person.displayName}</button>
            <div class="person-full-name">${fullName}</div>
            ${tags ? `<div class="person-tags">${tags}</div>` : ''}
          </div>
        </div>
        <div class="person-actions">
          <button class="notes-btn" data-notes type="button" data-has-notes="${Boolean(notes)}">${notes ? 'View notes' : 'Add notes'}</button>
        </div>
        <div class="person-note-status">${noteStatus}</div>
      </div>
      <div class="status-group" role="group" aria-label="Status for ${person.displayName}">
        ${statuses.map(s => `
          <button class="pill ${s.id}" type="button" aria-pressed="${isStatusActive(record, s.id)}" data-status="${s.id}" data-checked="${isStatusActive(record, s.id)}">
            <span>${s.label}</span>
            <span class="pill-hint">${s.hint}</span>
          </button>
        `).join('')}
      </div>
      ${footnotes.length ? `<div class="person-footnote">${footnotes.join('<span class="footnote-sep" aria-hidden="true">•</span>')}</div>` : ''}
    </li>`;
}

function isPersonServingOn(dateStr, person) {
  const days = person.serviceDays || [];
  if (!days || days.length === 0) return true; // default: show if unspecified
  const dowName = isoDowName(isoWeekday(dateStr));
  return days.includes(dowName);
}

function filterPeople(query) { const q = (query || '').toLowerCase(); return state.people.filter(p => p.displayName.toLowerCase().includes(q)); }

async function renderPeopleList() {
  const base = filterPeople(takeSearchEl?.value);
  const date = takeDateEl.value || state.currentDate;
  const filtered = state.showAll
    ? base
    : base.filter((p) => isPersonServingOn(date, p) && p.active !== false);
  const items = filtered.map(p => personRowTemplate(p, state.currentRecords.get(p.id)));
  if (peopleListEl) peopleListEl.innerHTML = items.join('');
  renderTakeSummary(filtered);
  updateHiddenInfoBar();
}

function renderNavigatorGaps() {
  if (!navigatorListEl) return;
  const gaps = state.officeGaps || [];
  const hasStats = !takeTrackingStatsEl?.hidden;
  if (!gaps.length) {
    if (!hasStats) {
      navigatorListEl.hidden = true;
      navigatorListEl.innerHTML = '';
      return;
    }
    navigatorListEl.hidden = false;
    navigatorListEl.innerHTML = `
      <li class="navigator-item navigator-item--empty">
        <div class="navigator-item__body">
          <span class="navigator-item__date">All Office sessions are up to date.</span>
          <span class="navigator-item__names">Great work! Nothing pending.</span>
        </div>
      </li>`;
    return;
  }
  navigatorListEl.hidden = false;
  const maxItems = 12;
  const display = gaps.slice(0, maxItems);
  const overflow = gaps.length - display.length;
  const items = display.map((gap) => {
    const dateLabel = dayjs(gap.date).format('ddd • MMM D');
    const pendingLabel = gap.type === 'blank' ? 'No log yet' : `${gap.missing} pending`;
    const names = gap.names.join(', ');
    const extra = gap.missing > gap.names.length ? ` +${gap.missing - gap.names.length} more` : '';
    const detail = names ? `${names}${extra}` : '';
    const aria = gap.type === 'blank'
      ? `${dateLabel} has no Office log yet`
      : `${dateLabel} has ${gap.missing} pending Office statuses`;
    return `
      <li class="navigator-item">
        <button type="button" data-date="${gap.date}" data-type="${gap.type}" aria-label="${aria}">
          <div class="navigator-item__body">
            <span class="navigator-item__date">${dateLabel}</span>
            <span class="navigator-item__badge" data-gap="${gap.type}">${pendingLabel}</span>
          </div>
          ${detail ? `<span class="navigator-item__names">${detail}</span>` : ''}
        </button>
      </li>`;
  });
  navigatorListEl.innerHTML = items.join('');
  if (overflow > 0) {
    navigatorListEl.innerHTML += `<li class="navigator-item navigator-item--more"><span class="navigator-item__names">+${overflow} more earlier Office days pending</span></li>`;
  }
}

function renderTakeSummary(filteredPeople = []) {
  if (!takeSummaryEl) return;
  if (!state.currentSessionId) {
    takeSummaryEl.innerHTML = '<p class="summary-empty">Select a date and event to begin logging attendance.</p>';
    return;
  }
  if (!filteredPeople.length) {
    const msg = state.people.length === 0
      ? 'Add missionaries from the roster to start tracking attendance.'
      : 'No missionaries match your current filters for this session.';
    takeSummaryEl.innerHTML = `<p class="summary-empty">${msg}</p>`;
    return;
  }
  const currentEvent = state.eventTypes.find(t => t.id === state.currentEventTypeId);
  const officeLabel = state.eventTypes.find(t => t.id === REQUIRED_EVENT_ID)?.label || 'Office';
  let notice = '';
  if (currentEvent) {
    if (OPTIONAL_EVENT_IDS.has(currentEvent.id)) {
      notice = `<div class="summary-note summary-note--supplemental"><strong>Supplemental session.</strong> Logging this is extra credit—${officeLabel} attendance is what counts.</div>`;
    } else if (currentEvent.id === REQUIRED_EVENT_ID) {
      notice = `<div class="summary-note summary-note--required"><strong>${officeLabel} is required.</strong> Log everyone here to stay current.</div>`;
    }
  }
  const counts = {
    present: 0,
    online: 0,
    excused: 0,
    tardy: 0,
    absent: 0,
    early_leave: 0,
    very_early_leave: 0,
    non_service: 0,
    unmarked: 0
  };
  for (const person of filteredPeople) {
    const rec = state.currentRecords.get(person.id);
    if (!rec || !accumulateRecordCounts(counts, rec)) {
      counts.unmarked += 1;
      continue;
    }
  }
  const total = filteredPeople.length;
  const recorded = total - counts.unmarked;
  const progressPct = total ? Math.round((recorded / total) * 100) : 0;
  const summaryStatuses = [
    { key: 'present', label: 'Present', tone: 'tone-success' },
    { key: 'online', label: 'Online', tone: 'tone-info' },
    { key: 'excused', label: 'Excused', tone: 'tone-muted' },
    { key: 'tardy', label: 'Tardy', tone: 'tone-warn' },
    { key: 'early_leave', label: 'Left Early', tone: 'tone-info' },
    { key: 'very_early_leave', label: 'Left Very Early', tone: 'tone-info' },
    { key: 'absent', label: 'Absent', tone: 'tone-danger' },
    { key: 'unmarked', label: 'Pending', tone: 'tone-muted' }
  ];
  const cards = summaryStatuses.map(({ key, label, tone }) => `
    <article class="summary-card ${tone}">
      <small>${label}</small>
      <strong>${counts[key] || 0}</strong>
    </article>
  `).join('');
  takeSummaryEl.innerHTML = `
    ${notice}
    <div class="summary-grid">
      <article class="summary-card span-2">
        <small>Progress</small>
        <strong>${recorded}/${total}</strong>
        <div class="progress-track"><div class="progress-bar" style="--progress:${progressPct}%;"></div></div>
        <small>${counts.unmarked ? `${counts.unmarked} remaining to log` : 'All missionaries recorded'}</small>
      </article>
      ${cards}
    </div>
  `;
}

async function applyStatus(personId, status, minutesLate) {
  if (!state.currentSessionId) return;
  const existing = state.currentRecords.get(personId) || {};
  const notes = existing?.notes;
  const providedMinutes = Number.isFinite(minutesLate) ? minutesLate : undefined;
  const preservedMinutes = Number.isFinite(existing.minutesLate) ? existing.minutesLate : undefined;
  const minutes = status === 'tardy'
    ? (providedMinutes ?? preservedMinutes)
    : undefined;
  let nextLeave;
  if (EARLY_STATUSES.has(status)) {
    nextLeave = status;
  } else if (status === 'tardy') {
    nextLeave = existing.leaveStatus;
  } else {
    nextLeave = undefined;
  }
  const recordId = await DB.setRecordStatus(state.currentSessionId, personId, status, minutes, notes, nextLeave);
  const next = { ...existing, id: existing.id || recordId, sessionId: state.currentSessionId, personId, status };
  if (status === 'tardy') {
    if (Number.isFinite(minutes)) next.minutesLate = minutes;
    else delete next.minutesLate;
  } else {
    delete next.minutesLate;
  }
  if (nextLeave) next.leaveStatus = nextLeave;
  else delete next.leaveStatus;
  state.currentRecords.set(personId, next);
  await renderPeopleList();
  renderTrackingStats();
  buildEventStepper();
}

async function applyLeaveStatus(personId, leaveStatus) {
  if (!state.currentSessionId) return;
  const existing = state.currentRecords.get(personId) || {};
  const baseStatus = existing.status;
  if (!baseStatus) {
    if (leaveStatus) await applyStatus(personId, leaveStatus);
    return;
  }
  if (baseStatus !== 'tardy') {
    if (leaveStatus) await applyStatus(personId, leaveStatus);
    return;
  }
  const normalized = leaveStatus || undefined;
  const notes = existing.notes;
  const minutes = Number.isFinite(existing.minutesLate) ? existing.minutesLate : undefined;
  const recordId = await DB.setRecordStatus(state.currentSessionId, personId, baseStatus, minutes, notes, normalized);
  const next = {
    ...existing,
    id: existing.id || recordId,
    sessionId: state.currentSessionId,
    personId,
    leaveStatus: normalized
  };
  if (!normalized) delete next.leaveStatus;
  state.currentRecords.set(personId, next);
  await renderPeopleList();
  renderTrackingStats();
  buildEventStepper();
}

function openTardyModal(personId) {
  if (!tardyModal) return;
  const person = state.people.find(p => p.id === personId);
  const rec = state.currentRecords.get(personId);
  const def = rec?.minutesLate ?? state.settings?.tardyThresholdMins ?? 5;
  state.pendingTardyPersonId = personId;
  if (tardyPersonLabel) tardyPersonLabel.textContent = person?.displayName || '';
  if (tardyMinutesInput) tardyMinutesInput.value = def;
  tardyModal.hidden = false;
  window.setTimeout(() => tardyMinutesInput?.focus(), 0);
}

function closeTardyModal() {
  if (tardyModal) tardyModal.hidden = true;
  state.pendingTardyPersonId = null;
}

function openPersonModal(mode, person) {
  if (!personModal) return;
  state.personModalMode = mode;
  state.editingPersonId = person?.id || null;
  if (personModalTitle) personModalTitle.textContent = mode === 'edit' ? 'Edit Missionary' : 'Add Missionary';
  if (personNameInput) personNameInput.value = person?.displayName || '';
  if (personActiveInput) personActiveInput.checked = person?.active !== false;
  if (personTagsInput) personTagsInput.value = (person?.tags || []).join(', ');
  const daySet = new Set(person?.serviceDays || []);
  personDayCheckboxes.forEach(cb => { cb.checked = daySet.has(cb.dataset.day); });
  personModal.hidden = false;
  window.setTimeout(() => personNameInput?.focus(), 0);
}

function closePersonModal() {
  if (!personModal) return;
  personModal.hidden = true;
  state.personModalMode = null;
  state.editingPersonId = null;
  if (personForm) personForm.reset();
  personDayCheckboxes.forEach(cb => { cb.checked = false; });
}

async function ensureSession() {
  const date = takeDateEl.value || state.currentDate;
  const eventTypeId = takeEventEl.value || state.currentEventTypeId || state.eventTypes[0]?.id;
  if (!date || !eventTypeId) {
    updateTakeDateHint();
    return;
  }
  const sid = await DB.upsertSession(date, eventTypeId);
  state.currentSessionId = sid; state.currentDate = date; state.currentEventTypeId = eventTypeId;
  const recs = await DB.recordsForSession(sid); state.currentRecords = new Map(recs.map(r => [r.personId, r]));
  buildEventStepper();
  updateTakeDateHint();
}

// Interactions: Take view
peopleListEl?.addEventListener('click', async (e) => {
  const pill = e.target.closest('button.pill');
  if (pill) {
    const li = pill.closest('.person-row');
    const personId = li?.dataset.personId;
    const status = pill.getAttribute('data-status');
    if (!personId || !status) return;
    if (status === 'tardy') {
      openTardyModal(personId);
      return;
    }
    if (EARLY_STATUSES.has(status)) {
      const rec = state.currentRecords.get(personId);
      if (rec?.status === 'tardy') {
        const nextLeave = rec.leaveStatus === status ? undefined : status;
        await applyLeaveStatus(personId, nextLeave);
        return;
      }
    }
    await applyStatus(personId, status);
    return;
  }
  const notesBtn = e.target.closest('[data-notes]');
  if (notesBtn) {
    const li = notesBtn.closest('.person-row');
    state.editingNotesFor = li?.dataset.personId || null;
    const rec = state.currentRecords.get(state.editingNotesFor);
    notesText.value = rec?.notes || '';
    if (notesModal) notesModal.hidden = false;
    return;
  }
  const nameEl = e.target.closest('.person-name');
  if (nameEl) {
    const li = nameEl.closest('.person-row');
    if (li) { state.selectedPersonId = li.dataset.personId; window.location.hash = '#/person'; }
  }
});

notesSave?.addEventListener('click', async () => {
  if (!state.editingNotesFor) return;
  const personId = state.editingNotesFor;
  const rec = state.currentRecords.get(personId) || {};
  const nextStatus = rec?.status || null;
  await DB.setRecordStatus(state.currentSessionId, personId, nextStatus, rec?.minutesLate, notesText.value, rec?.leaveStatus);
  const nextRecord = { ...rec, notes: notesText.value };
  if (nextStatus) nextRecord.status = nextStatus;
  else delete nextRecord.status;
  state.currentRecords.set(personId, nextRecord);
  notesModal.hidden = true;
  state.editingNotesFor = null;
  await renderPeopleList();
  showToast('Notes saved');
});
notesCancel?.addEventListener('click', () => { if (notesModal) notesModal.hidden = true; state.editingNotesFor = null; });

tardyForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.pendingTardyPersonId) { closeTardyModal(); return; }
  const minutes = Number(tardyMinutesInput?.value || 0);
  const safeMinutes = Number.isFinite(minutes) && minutes >= 0 ? minutes : 0;
  await applyStatus(state.pendingTardyPersonId, 'tardy', safeMinutes);
  closeTardyModal();
});
tardyCancelBtn?.addEventListener('click', () => { closeTardyModal(); });

personForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = personNameInput?.value.trim();
  if (!name) { personNameInput?.focus(); return; }
  const active = personActiveInput?.checked !== false;
  const tags = (personTagsInput?.value || '')
    .split(',')
    .map(t => t.trim())
    .filter(Boolean);
  const serviceDays = personDayCheckboxes.filter(cb => cb.checked).map(cb => cb.dataset.day);
  if (state.personModalMode === 'edit' && state.editingPersonId) {
    const idx = state.people.findIndex(p => p.id === state.editingPersonId);
    if (idx >= 0) {
      const next = { ...state.people[idx], displayName: name, active, tags, serviceDays };
      await DB.savePerson(next);
      state.people[idx] = next;
    }
    showToast('Missionary updated');
  } else {
    await DB.addPerson(name, { active, tags, serviceDays });
    showToast('Missionary added');
  }
  await loadPeople();
  renderRoster();
  await renderPeopleList();
  renderTrackingStats();
  closePersonModal();
});
personCancelBtn?.addEventListener('click', () => { closePersonModal(); });

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (notesModal && !notesModal.hidden) { notesModal.hidden = true; state.editingNotesFor = null; }
    if (personModal && !personModal.hidden) closePersonModal();
    if (tardyModal && !tardyModal.hidden) closeTardyModal();
  }
});

btnAllPresent?.addEventListener('click', async () => {
  if (!state.currentSessionId) return;
  for (const p of state.people) {
    const existing = state.currentRecords.get(p.id) || {};
    await DB.setRecordStatus(state.currentSessionId, p.id, 'present', undefined, existing.notes, undefined);
    const next = { ...existing, status: 'present' };
    delete next.minutesLate;
    delete next.leaveStatus;
    state.currentRecords.set(p.id, next);
  }
  await renderPeopleList();
  renderTrackingStats();
  buildEventStepper();
  showToast('All marked present');
});
btnClearAll?.addEventListener('click', async () => {
  if (!state.currentSessionId) return;
  if (!confirm('Clear all statuses for this session?')) return;
  await DB.clearRecordsForSession(state.currentSessionId);
  state.currentRecords.clear();
  await renderPeopleList();
  renderTrackingStats();
  buildEventStepper();
  showToast('Cleared');
});
btnSaveAttendance?.addEventListener('click', () => showToast('Saved to this browser. Your latest check-in is stored here.', 2200));
btnSaveDownloadAttendance?.addEventListener('click', () => {
  downloadBackup({
    toastMessage: 'Backup downloaded with your latest check-in. Keep the JSON handy if you need to import elsewhere.',
    toastDuration: 2600
  });
});
btnPrintAttendance?.addEventListener('click', () => window.print());

// Roster
btnAddPerson?.addEventListener('click', () => { openPersonModal('add'); });

rosterTbody?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]'); if (!btn) return; const tr = btn.closest('tr'); const id = tr.dataset.personId; const person = state.people.find(p=>p.id===id); if (!person) return;
  const action = btn.getAttribute('data-action');
  if (action === 'profile') { state.selectedPersonId = id; window.location.hash = '#/person'; return; }
  if (action === 'del') {
    if (!confirm('Delete?')) return;
    await DB.deletePerson(id);
    state.currentRecords.delete(id);
    if (state.selectedPersonId === id) state.selectedPersonId = null;
    const pinKey = 'trends_pins';
    try {
      const pins = new Set(JSON.parse(localStorage.getItem(pinKey) || '[]'));
      if (pins.delete(id)) localStorage.setItem(pinKey, JSON.stringify([...pins]));
    } catch (err) {
      // ignore localStorage errors
    }
    await loadPeople();
    renderRoster();
    await renderPeopleList();
    renderTrackingStats();
    const trendsView = document.getElementById('view-trends');
    if (trendsView && !trendsView.hidden) await runTrends();
    const insightsView = document.getElementById('view-insights');
    if (insightsView && !insightsView.hidden) await runAnalytics();
    const personViewEl = document.getElementById('view-person');
    if (personViewEl && !personViewEl.hidden) await renderPersonView();
  }
  if (action === 'toggle-active') { person.active = !person.active; await DB.savePerson(person); await loadPeople(); renderRoster(); await renderPeopleList(); }
  if (action === 'edit') { openPersonModal('edit', person); }
});

rosterTbody?.addEventListener('change', async (e) => {
  const cb = e.target.closest('input[type="checkbox"][data-day]'); if (!cb) return; const tr = cb.closest('tr'); const personId = tr.dataset.personId; const day = cb.getAttribute('data-day'); const person = state.people.find(p=>p.id===personId);
  const current = new Set(person?.serviceDays || []); if (cb.checked) current.add(day); else current.delete(day); const next = { ...person, serviceDays: Array.from(current) }; await DB.savePerson(next);
  const idx = state.people.findIndex(p=>p.id===personId); state.people[idx] = next; if (!document.querySelector('[data-view="take"]').hidden) renderPeopleList();
});

function rosterRow(person) {
  const days = ['Mon','Tue','Wed','Thu','Fri']; const has = new Set(person.serviceDays || []);
  const checks = days.map(d => `<td><input type="checkbox" data-day="${d}" ${has.has(d)?'checked':''} /></td>`).join('');
  const tags = (person.tags || []).join(', ');
  const statusChip = person.active ? '<span class="chip tone-success">Active</span>' : '<span class="chip tone-danger">Inactive</span>';
  const serviceDays = days.filter(d => has.has(d)).join(', ');
  return `<tr data-person-id="${person.id}">
    <td><div class="roster-name">${person.displayName}</div>${serviceDays ? `<div class="person-tags">${serviceDays}</div>` : ''}</td>
    <td>${statusChip}</td>
    <td>${tags || '—'}</td>
    ${checks}
    <td class="row-actions"><button data-action="profile" type="button">Profile</button><button data-action="edit" type="button">Edit</button><button data-action="toggle-active" type="button">${person.active?'Deactivate':'Activate'}</button><button data-action="del" type="button" class="ghost">Delete</button></td>
  </tr>`;
}

function renderRoster() { rosterTbody.innerHTML = state.people.map(rosterRow).join(''); }

// Analytics
let trendChart = null;
let trendsRows = [];
let trendsOffset = 0;
const TRENDS_CHUNK = 60;
function ensureTrendChart() {
  if (trendChart) return trendChart; const ctx = document.getElementById('trend-chart');
  // eslint-disable-next-line no-undef
  trendChart = new Chart(ctx, { type: 'bar', data: { labels: [], datasets: [
    { type: 'bar', label: 'Present', backgroundColor: 'rgba(34,197,94,0.6)', borderColor: '#22c55e', data: [], yAxisID: 'y', order: 2, stack: 'counts' },
    { type: 'bar', label: 'Online', backgroundColor: 'rgba(34,211,238,0.6)', borderColor: '#22d3ee', data: [], yAxisID: 'y', order: 2, stack: 'counts' },
    { type: 'bar', label: 'Excused', backgroundColor: 'rgba(96,165,250,0.6)', borderColor: '#60a5fa', data: [], yAxisID: 'y', order: 2, stack: 'counts' },
    { type: 'bar', label: 'Tardy', backgroundColor: 'rgba(245,158,11,0.6)', borderColor: '#f59e0b', data: [], yAxisID: 'y', order: 2, stack: 'counts' },
    { type: 'bar', label: 'Absent', backgroundColor: 'rgba(239,68,68,0.6)', borderColor: '#ef4444', data: [], yAxisID: 'y', order: 2, stack: 'counts' },
    { type: 'line', label: 'Rate', borderColor: '#a78bfa', pointRadius: 0, data: [], yAxisID: 'y2', order: 1 }
  ]}, options: { responsive: true, maintainAspectRatio: false, layout: { padding: { top: 4, bottom: 4 } }, plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => { if (ctx.dataset.label==='Rate') return `Rate: ${Math.round((ctx.parsed.y||0)*100)}%`; return `${ctx.dataset.label}: ${ctx.parsed.y}`; } } } }, scales: { x: { stacked: true, ticks: { color: '#9fb3c8', maxRotation: 0, autoSkip: true, maxTicksLimit: 14 } }, y: { stacked: true, ticks: { color: '#9fb3c8', maxTicksLimit: 4 } }, y2: { position: 'right', min: 0, max: 1, grid: { drawOnChartArea: false }, ticks: { color: '#9fb3c8', maxTicksLimit: 4, callback: (v) => `${Math.round(v*100)}%` } } } } });
  return trendChart;
}

function thresholds() {
  const base = state.settings?.legendThresholds || DEFAULT_LEGEND_THRESHOLDS;
  const low = Number(trendsThreshLow?.value || base.low);
  const high = Number(trendsThreshHigh?.value || base.high);
  return { low, high };
}
function colorForRate(rate) { const t = thresholds(); if (rate >= t.high) return 'rate-high'; if (rate >= t.low && rate < t.high) return 'rate-mid'; if (rate < t.low) return 'rate-low'; return ''; }
function heatStyle(rate, rgb = '34,197,94') { const v = Math.max(0, Math.min(1, rate)); return `background: linear-gradient(0deg, rgba(${rgb},${v}) 0%, rgba(${rgb},${v}) 100%);`; }
// Calendar-specific red→green scale mapped to 60%..100%
function calendarHeatStyle(rate) {
  const t = Math.max(0, Math.min(1, (rate - 0.6) / 0.4));
  const r0 = [239, 68, 68]; // red
  const g1 = [34, 197, 94]; // green
  const r = Math.round(r0[0] + (g1[0] - r0[0]) * t);
  const g = Math.round(r0[1] + (g1[1] - r0[1]) * t);
  const b = Math.round(r0[2] + (g1[2] - r0[2]) * t);
  const alpha = 0.85;
  return `background: linear-gradient(0deg, rgba(${r},${g},${b},${alpha}) 0%, rgba(${r},${g},${b},${alpha}) 100%);`;
}

function calendarCellStyle(rate) {
  if (!rate || rate === 0) {
    // gray for 0%
    const gray = '148,163,184'; // slate-400ish
    const a = 0.25;
    return `background: linear-gradient(0deg, rgba(${gray},${a}) 0%, rgba(${gray},${a}) 100%);`;
  }
  return calendarHeatStyle(rate);
}

async function runAnalytics() {
  const from = analyticsFrom.value || dayjs().subtract(30,'day').format('YYYY-MM-DD');
  const to = analyticsTo.value || dayjs().format('YYYY-MM-DD');
  const eventTypeId = analyticsEvent.value || undefined;
  const applyEvent = !!analyticsApplyEventWeight?.checked;
  const activeOnly = !!analyticsActiveOnly?.checked;
  const tagq = (analyticsTag?.value || '').toLowerCase();

  const { sessions, records } = await DB.recordsForRange(from, to, eventTypeId);
  const eventWeightBySession = new Map(sessions.map(s => [s.id, (state.eventTypes.find(t => t.id===s.eventTypeId)?.weight) ?? 1]));
  const peopleById = new Map(state.people.map(p => [p.id, p]));
  const rawScore = (r) => recordWeight(r);
  const sessionWeight = (sessionId) => applyEvent ? (eventWeightBySession.get(sessionId) ?? 1) : 1;
  const weightedScore = (r) => rawScore(r) * sessionWeight(r.sessionId);
  const includeRecord = (r) => {
    const person = peopleById.get(r.personId);
    if (activeOnly && person && person.active === false) return false;
    if (tagq && person && !(person.tags||[]).join(' ').toLowerCase().includes(tagq)) return false;
    return true;
  };
  // Exclude blanks entirely and non_service from analytics
  const filtered = records.filter(r => r.status && r.status !== 'non_service').filter(includeRecord);

  // Totals
  const counts = { present:0, online:0, excused:0, tardy:0, absent:0, early_leave:0, very_early_leave:0 };
  for (const rec of filtered) accumulateRecordCounts(counts, rec);
  const totalWeight = filtered.reduce((sum, r) => sum + sessionWeight(r.sessionId), 0);
  const scoreSum = filtered.reduce((sum, r) => sum + weightedScore(r), 0);
  const avgScore = totalWeight ? (scoreSum / totalWeight) : 0;
  totalsPresentEl.textContent = counts.present || 0;
  if (totalsOnlineEl) totalsOnlineEl.textContent = counts.online || 0;
  totalsExcusedEl.textContent = counts.excused || 0;
  totalsTardyEl.textContent = counts.tardy || 0;
  totalsAbsentEl.textContent = counts.absent || 0;
  totalsRateEl.textContent = `${Math.round(avgScore*100)}%`;

  // Series by date (fill all dates in range)
  const dates = [];
  for (let d = dayjs(from); d.isBefore(dayjs(to)) || d.isSame(dayjs(to), 'day'); d = d.add(1,'day')) {
    const ds = d.format('YYYY-MM-DD');
    if (isoWeekday(ds) >= 1 && isoWeekday(ds) <= 5) dates.push(ds);
  }
  const byDate = new Map(dates.map(d => [d, { present:0, online:0, excused:0, tardy:0, absent:0, early_leave:0, very_early_leave:0, total:0, weightSum:0, rateAcc:0 }]));
  const sessionById = new Map(sessions.map(s => [s.id, s]));
  for (const r of filtered) {
    const session = sessionById.get(r.sessionId);
    if (!session) continue;
    const ent = byDate.get(session.date);
    if (!ent) continue;
    const weight = sessionWeight(r.sessionId);
    accumulateRecordCounts(ent, r);
    ent.total += 1;
    ent.weightSum += weight;
    ent.rateAcc += rawScore(r) * weight;
  }
  let rate = dates.map(d => { const ent = byDate.get(d); return ent && ent.weightSum ? (ent.rateAcc/ent.weightSum) : 0; });
  // Optional smoothing (7-day)
  if (analyticsSmoothRate?.checked) {
    const sm = [];
    const window = 7;
    for (let i=0;i<rate.length;i++) {
      const a = Math.max(0, i-window+1);
      const slice = rate.slice(a, i+1);
      sm.push(slice.length ? (slice.reduce((s,v)=>s+v,0)/slice.length) : rate[i]);
    }
    rate = sm;
  }
  const series = { dates,
    present: dates.map(d => byDate.get(d)?.present || 0),
    online: dates.map(d => byDate.get(d)?.online || 0),
    excused: dates.map(d => byDate.get(d)?.excused || 0),
    tardy: dates.map(d => byDate.get(d)?.tardy || 0),
    absent: dates.map(d => byDate.get(d)?.absent || 0),
    rate };

  // If compare: build previous period rate series
  let prevRate = [];
  if (analyticsCompare?.checked) {
    const spanDays = dayjs(to).diff(dayjs(from), 'day') + 1;
    const prevFrom = dayjs(from).subtract(spanDays, 'day').format('YYYY-MM-DD');
    const prevTo = dayjs(from).subtract(1, 'day').format('YYYY-MM-DD');
    const { sessions: psessions, records: precords } = await DB.recordsForRange(prevFrom, prevTo, eventTypeId);
    const ewb = new Map(psessions.map(s => [s.id, (state.eventTypes.find(t => t.id===s.eventTypeId)?.weight) ?? 1]));
    const prevFiltered = precords.filter(r => r.status && r.status !== 'non_service').filter(includeRecord);
    const byDatePrev = new Map();
    const prevSessionById = new Map(psessions.map(s => [s.id, s]));
    for (const s of psessions) byDatePrev.set(s.date, { weightSum:0, rateAcc:0 });
    for (const r of prevFiltered) {
      const session = prevSessionById.get(r.sessionId);
      if (!session) continue;
      const weight = applyEvent ? (ewb.get(r.sessionId) ?? 1) : 1;
      const ent = byDatePrev.get(session.date) || { weightSum:0, rateAcc:0 };
      ent.weightSum += weight;
      ent.rateAcc += recordWeight(r) * weight;
      byDatePrev.set(session.date, ent);
    }
    // align to current dates by index
    const prevDatesAll = [...byDatePrev.keys()].sort();
    const prevWeekdays = prevDatesAll.filter(ds => { const wd = isoWeekday(ds); return wd>=1 && wd<=5; });
    const lastN = prevWeekdays.slice(-dates.length);
    prevRate = lastN.map(d => {
      const ent = byDatePrev.get(d);
      return ent && ent.weightSum ? (ent.rateAcc / ent.weightSum) : 0;
    });
  }

  // Update chart
  const chart = ensureTrendChart();
  chart.data.labels = series.dates;
  chart.data.datasets[0].data = series.present;
  chart.data.datasets[1].data = series.online;
  chart.data.datasets[2].data = series.excused;
  chart.data.datasets[3].data = series.tardy;
  chart.data.datasets[4].data = series.absent;
  chart.data.datasets[5].data = series.rate;
  if (analyticsCompare?.checked) {
    // reuse datasets[4] for current rate, overlay previous via dataset[5] (create if missing)
    if (!chart.data.datasets[6]) chart.data.datasets.push({ type: 'line', label: 'Rate (prev)', borderColor: '#94a3b8', pointRadius: 0, data: [], tension: 0.3, yAxisID: 'y2', borderDash: [4,3] });
    chart.data.datasets[6].data = prevRate;
  } else if (chart.data.datasets[6]) {
    chart.data.datasets[6].data = [];
  }
  // Show/hide datasets per toggles
  if (analyticsShowPresent) chart.getDatasetMeta(0).hidden = !analyticsShowPresent.checked;
  if (analyticsShowOnline) chart.getDatasetMeta(1).hidden = !analyticsShowOnline.checked;
  if (analyticsShowExcused) chart.getDatasetMeta(2).hidden = !analyticsShowExcused.checked;
  if (analyticsShowTardy) chart.getDatasetMeta(3).hidden = !analyticsShowTardy.checked;
  if (analyticsShowAbsent) chart.getDatasetMeta(4).hidden = !analyticsShowAbsent.checked;
  if (analyticsShowRate) chart.getDatasetMeta(5).hidden = !analyticsShowRate.checked;
  chart.update();

  // Heatmap by DOW using weighted rate (Mon–Fri only)
  heatmapEl.innerHTML = '';
  const rateSumByDow = {1:0,2:0,3:0,4:0,5:0};
  const weightByDow = {1:0,2:0,3:0,4:0,5:0};
  for (const r of filtered) {
    const s = sessions.find(s=>s.id===r.sessionId); if (!s) continue; if (s.dow < 1 || s.dow > 5) continue;
    const w = sessionWeight(r.sessionId);
    rateSumByDow[s.dow] += rawScore(r) * w;
    weightByDow[s.dow] += w;
  }
  const dayNames = ['Mon','Tue','Wed','Thu','Fri'];
  for (let d=1; d<=5; d++) {
    const avg = weightByDow[d] ? (rateSumByDow[d] / weightByDow[d]) : 0;
    const style = calendarHeatStyle(avg);
    const textColor = avg >= 0.6 ? '#000000' : 'var(--text)';
    const cell = document.createElement('div'); cell.className = 'heat'; cell.setAttribute('role','gridcell'); cell.setAttribute('aria-label', `${dayNames[d-1]}: ${(avg*100).toFixed(0)}% rate`); cell.style = style + `;color:${textColor}`; cell.textContent = `${dayNames[d-1]}\n${Math.round(avg*100)}%`;
    heatmapEl.appendChild(cell);
  }

  // Summary insights
  if (analyticsSummaryEl) {
    const best = series.dates.map((d,i)=>({ d, rate: series.rate[i] })).sort((a,b)=> b.rate - a.rate)[0] || { d:'', rate:0 };
    const worst = series.dates.map((d,i)=>({ d, rate: series.rate[i] })).sort((a,b)=> a.rate - b.rate)[0] || { d:'', rate:0 };
    analyticsSummaryEl.innerHTML = `<div><strong>Best day:</strong> ${best.d} (${Math.round(best.rate*100)}%)</div><div><strong>Worst day:</strong> ${worst.d} (${Math.round(worst.rate*100)}%)</div><div><strong>Days:</strong> ${series.dates.length}</div><div><strong>Event:</strong> ${eventTypeId || 'All'}</div><div><strong>Weighted:</strong> ${applyEvent ? 'Yes':'No'}</div>`;
  }

  // Daily cards
  if (analyticsDaysEl) {
    const weekdayOnly = series.dates.filter(ds => { const wd = isoWeekday(ds); return wd>=1 && wd<=5; });
    const padCount = weekdayOnly.length ? (isoWeekday(weekdayOnly[0]) - 1) : 0;
    const pads = Array.from({ length: Math.max(0, padCount) }, () => `<div class="card analytics-card empty"></div>`);
    analyticsDaysEl.innerHTML = pads.join('') + weekdayOnly.map((d) => {
      const i = series.dates.indexOf(d);
      const p = series.present[i]||0, t = series.tardy[i]||0, e = series.excused[i]||0, a = series.absent[i]||0; const r = series.rate[i]||0; const textColor = r >= 0.6 ? '#000000' : 'var(--text)'; const subColor = r >= 0.6 ? '#001014' : 'var(--muted)';
      const o = series.online[i]||0;
      return `<div class=\"card analytics-card\" style=\"${calendarCellStyle(r)};color:${textColor}\" data-date=\"${d}\"><div class=\"day-title\">${d}</div><div class=\"kpis\"><span>${p}P</span><span>${o}O</span><span>${t}T</span><span>${e}E</span><span>${a}A</span></div><div class=\"cal-score percent-outline\">${Math.round(r*100)}%</div><div style=\"margin-top:6px; display:flex; gap:8px;\"><button type=\"button\" data-action=\"open-take\" data-date=\"${d}\">Open in Take</button></div></div>`;
    }).join('');
    analyticsDaysEl.querySelectorAll('[data-action="open-take"]').forEach(btn => btn.addEventListener('click', async (e) => { const date = e.currentTarget.getAttribute('data-date'); takeDateEl.value = date; await ensureSession(); await renderPeopleList(); window.location.hash = '#/take'; }));
  }
}

// Trends
async function runTrends() {
  if (!trendsPeopleEl) return;
  const from = trendsFrom.value || dayjs().subtract(30,'day').format('YYYY-MM-DD');
  const to = trendsTo.value || dayjs().format('YYYY-MM-DD');
  const eventTypeId = trendsEvent.value || undefined;
  const applyEvent = !!trendsApplyEventWeight?.checked;
  const { sessions, records } = await DB.recordsForRange(from, to, eventTypeId);
  const eventWeightBySession = new Map(sessions.map(s => [s.id, (state.eventTypes.find(t => t.id===s.eventTypeId)?.weight) ?? 1]));
  const rawScore = (r) => recordWeight(r);
  const sessionWeight = (sessionId) => applyEvent ? (eventWeightBySession.get(sessionId) ?? 1) : 1;
  const byPerson = new Map();
  const sessionById = new Map(sessions.map(s => [s.id, s]));
  for (const r of records) {
    if (!r.status || r.status === 'non_service') continue;
    const s = sessionById.get(r.sessionId);
    const d = s?.date || '';
    if (!byPerson.has(r.personId)) byPerson.set(r.personId, []);
    byPerson.get(r.personId).push({ ...r, _date:d, _score: rawScore(r), _weight: sessionWeight(r.sessionId) });
  }
  const q = (trendsSearchEl?.value || '').toLowerCase(); const tagq = (trendsTag?.value || '').toLowerCase(); const activeOnly = !!trendsActiveOnly?.checked; const pins = new Set(JSON.parse(localStorage.getItem('trends_pins') || '[]'));
  const rows = [];
  for (const [pid, recs] of byPerson) {
    const person = state.people.find(p => p.id === pid);
    const name = person?.displayName || pid;
    const tags = (person?.tags || []).map(x=>String(x));
    if (activeOnly && person && person.active === false) continue;
    if (q && !name.toLowerCase().includes(q)) continue;
    if (tagq && !tags.join(' ').toLowerCase().includes(tagq)) continue;
    const eligible = recs;
    const weightSum = eligible.reduce((s, r) => s + (r._weight ?? 1), 0);
    const avg = weightSum ? eligible.reduce((s,r)=> s + (r._score * (r._weight ?? 1)), 0) / weightSum : 0;
    const online = recs.filter(r => r.status==='online').length;
    const tardies = recs.filter(r => r.status==='tardy').length;
    const presents = recs.filter(r => r.status==='present').length;
    const excused = recs.filter(r => r.status==='excused').length;
    const absent = recs.filter(r => r.status==='absent').length;
    const sessionsCount = recs.length;
    const last = [...recs].sort((a,b)=> a._date.localeCompare(b._date)).slice(-10);
    const spark = last.map(r => {
      const weight = r._weight ?? 1;
      return weight ? r._score : 0;
    });
    const lastDate = last.length ? last[last.length-1]._date : '';
    const bucket = (()=>{ const t = thresholds(); if (avg >= t.high) return 'high'; if (avg >= t.low) return 'mid'; return 'low'; })();
    rows.push({ pid, name, avg, online, tardies, presents, excused, absent, sessionsCount, spark, lastDate, tags, pinned: pins.has(pid), bucket, exists: !!person });
  }
  const sortKey = trendsSort?.value || 'avg_desc';
  const cmp = {
    'avg_desc': (a,b)=> b.avg - a.avg,
    'avg_asc': (a,b)=> a.avg - b.avg,
    'tardy_desc': (a,b)=> b.tardies - a.tardies,
    'tardy_asc': (a,b)=> a.tardies - b.tardies,
    'name_asc': (a,b)=> a.name.localeCompare(b.name),
    'name_desc': (a,b)=> b.name.localeCompare(a.name),
    'sessions_desc': (a,b)=> b.sessionsCount - a.sessionsCount,
    'sessions_asc': (a,b)=> a.sessionsCount - b.sessionsCount,
  }[sortKey] || ((a,b)=> b.avg - a.avg);
  rows.sort(cmp);
  trendsRows = rows; trendsOffset = 0;
  renderTrendsSummary(records, applyEvent, eventWeightBySession);
  renderTrendsChunk(true);
  // Simple status by DOW heat rows (present vs absent)
  const statuses = [ { key:'present', label:'Present', color:'34,197,94', invert:false }, { key:'absent', label:'Absent', color:'239,68,68', invert:true } ]; const dayNames = ['Mon','Tue','Wed','Thu','Fri']; const denomByDow = {1:0,2:0,3:0,4:0,5:0,6:0,7:0}; const numByStatusDow = { present:{}, absent:{} }; for (let d=1; d<=7; d++) { denomByDow[d]=0; numByStatusDow.present[d]=0; numByStatusDow.absent[d]=0; }
  for (const r of records) {
    if (!r.status || r.status === 'non_service') continue;
    const s = sessions.find(s => s.id === r.sessionId); if (!s) continue;
    const w = applyEvent ? (eventWeightBySession.get(r.sessionId) ?? 1) : 1;
    denomByDow[s.dow] += w;
    if (numByStatusDow[r.status] && typeof numByStatusDow[r.status][s.dow] === 'number') numByStatusDow[r.status][s.dow] += w;
  }
  const section = [];
  for (const s of statuses) { const row = []; for (let d=1; d<=5; d++) { const eligible = denomByDow[d] || 0; const pct = eligible ? ((numByStatusDow[s.key][d] || 0) / eligible) : 0; const displayRate = s.invert ? (1 - pct) : pct; const style = heatStyle(displayRate, s.color); const textColor = displayRate >= 0.6 ? '#000000' : 'var(--text)'; row.push(`<div class="heat" title="${dayNames[d-1]} ${(pct*100).toFixed(0)}%" style="${style};color:${textColor}">${dayNames[d-1]}</div>`); } section.push(`<div class="trend-heat-row"><div class="trend-heat-title"><strong>${s.label}</strong></div><div class="heatmap">${row.join('')}</div></div>`); }
  trendsStatusDowEl.innerHTML = section.join('');
}

function renderTrendsSummary(records, applyEvent, eventWeightBySession) {
  if (!trendsSummaryEl) return;
  const eligible = records.filter(r => r.status && r.status !== 'non_service');
  const counts = { present:0, online:0, excused:0, tardy:0, absent:0, early_leave:0, very_early_leave:0 };
  for (const rec of eligible) accumulateRecordCounts(counts, rec);
  const weightForRecord = (sessionId) => applyEvent ? (eventWeightBySession?.get(sessionId) ?? 1) : 1;
  const avgWeightSum = eligible.reduce((sum, r) => sum + weightForRecord(r.sessionId), 0);
  const avgScoreSum = eligible.reduce((sum, r) => sum + (recordWeight(r) * weightForRecord(r.sessionId)), 0);
  const avgScore = avgWeightSum ? (avgScoreSum / avgWeightSum) : 0;
  trendsSummaryEl.innerHTML = `<div><strong>Present:</strong> ${counts.present||0}</div><div><strong>Excused:</strong> ${counts.excused||0}</div><div><strong>Tardy:</strong> ${counts.tardy||0}</div><div><strong>Absent:</strong> ${counts.absent||0}</div><div><strong>Avg:</strong> ${Math.round(avgScore*100)}%</div>`;
}

function sparklineSvg(values) {
  if (!values || values.length === 0) return '';
  const w = 120, h = 36, p = 2;
  const n = values.length;
  const xStep = (w - p * 2) / (Math.max(1, n - 1));
  const pts = values
    .map((v, i) => {
      const x = p + i * xStep;
      const y = p + (1 - Math.max(0, Math.min(1, v))) * (h - p * 2);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return `<svg class="sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path d="${pts}" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
}

function cardTemplate(r) {
  const cls = colorForRate(r.avg);
  const star = r.pinned ? '⭐' : '☆';
  const spark = sparklineSvg(r.spark);
  const rate = Math.round(r.avg * 100);
  const sessionsLabel = r.sessionsCount === 1 ? '1 session' : `${r.sessionsCount} sessions`;
  const lastSeen = r.lastDate ? dayjs(r.lastDate).format('MMM D') : null;
  const tags = (r.tags || []).slice(0, 3);
  const tagsHtml = tags.length
    ? `<div class="trend-card__tags">${tags.map(tag => `<span class="trend-tag">${tag}</span>`).join('')}</div>`
    : '';
  const stats = [
    { label: 'Present', value: r.presents },
    { label: 'Online', value: r.online },
    { label: 'Tardy', value: r.tardies },
    { label: 'Excused', value: r.excused },
    { label: 'Absent', value: r.absent }
  ];
  const statsHtml = stats
    .map(({ label, value }) => `<div class="trend-card__stat"><span>${label}</span><strong>${value}</strong></div>`)
    .join('');
  return (
    `<article class="card trend-card ${cls}" data-pid="${r.pid}">
      <header class="trend-card__header">
        <div class="trend-card__title">
          <strong class="trend-card__name">${r.name}</strong>
          ${tagsHtml}
        </div>
        <div class="trend-card__score">
          <span class="trend-card__rate">${rate}%</span>
          <button type="button" class="trend-card__pin" data-action="pin" aria-label="${r.pinned ? 'Unpin from highlights' : 'Pin to highlights'}">${star}</button>
        </div>
      </header>
      <div class="trend-card__meta">
        <span>${sessionsLabel}</span>
        <span>${lastSeen ? `Last ${lastSeen}` : 'No recent log'}</span>
      </div>
      <div class="trend-card__spark" aria-hidden="true">${spark}</div>
      <div class="trend-card__stats">
        ${statsHtml}
      </div>
      <div class="trend-card__actions">
        <button type="button" class="trend-card__btn" data-action="details">Details</button>
        <button type="button" class="trend-card__btn" data-action="profile">Profile</button>
        ${r.lastDate ? `<button type="button" class="trend-card__btn" data-action="open-take" data-date="${r.lastDate}">Open day</button>` : ''}
        <button type="button" class="trend-card__btn trend-card__btn--danger" data-action="delete-person">${r.exists ? 'Delete missionary' : 'Remove records'}</button>
      </div>
      <div class="trend-details" hidden>Present: ${r.presents} • Online: ${r.online} • Tardy: ${r.tardies} • Excused: ${r.excused} • Absent: ${r.absent}</div>
    </article>`
  ).trim();
}

function renderTrendsChunk(reset = false) {
  if (!trendsPeopleEl) return;
  if (reset) trendsPeopleEl.innerHTML = '';
  const pinned = trendsRows.filter(r => r.pinned);
  const others = trendsRows.filter(r => !r.pinned);
  if (reset) {
    if (pinned.length) {
      const header = `<h3>Pinned (${pinned.length})</h3>`;
      const html = pinned.map(cardTemplate).join('');
      trendsPeopleEl.insertAdjacentHTML('beforeend', header + html);
    }
  }
  const slice = others.slice(trendsOffset, trendsOffset + TRENDS_CHUNK);
  const groups = { high: [], mid: [], low: [] };
  for (const r of slice) groups[r.bucket].push(r);
  const parts = [];
  if (groups.high.length) parts.push(`<h3>High (${groups.high.length})</h3>` + groups.high.map(cardTemplate).join(''));
  if (groups.mid.length) parts.push(`<h3>Mid (${groups.mid.length})</h3>` + groups.mid.map(cardTemplate).join(''));
  if (groups.low.length) parts.push(`<h3>Low (${groups.low.length})</h3>` + groups.low.map(cardTemplate).join(''));
  trendsPeopleEl.insertAdjacentHTML('beforeend', parts.join(''));
  trendsOffset += slice.length;
  if (trendsLoadMoreBtn) trendsLoadMoreBtn.hidden = trendsOffset >= others.length;
}

// Person details view
async function renderPersonView() {
  if (!personSummaryEl) return;
  const pid = state.selectedPersonId;
  const person = state.people.find(p => p.id === pid);
  if (personTitleEl) personTitleEl.textContent = person ? `${person.displayName}` : 'Missionary Details';

  // Ensure defaults
  if (personFrom && !personFrom.value) personFrom.value = dayjs().subtract(60, 'day').format('YYYY-MM-DD');
  if (personTo && !personTo.value) personTo.value = dayjs().format('YYYY-MM-DD');

  const from = personFrom?.value || dayjs().subtract(60, 'day').format('YYYY-MM-DD');
  const to = personTo?.value || dayjs().format('YYYY-MM-DD');
  const eventTypeId = personEvent?.value || undefined;
  const applyEvent = !!personApplyEventWeight?.checked;

  const { sessions, records } = await DB.recordsForRange(from, to, eventTypeId);
  const eventWeightBySession = new Map(sessions.map(s => [s.id, (state.eventTypes.find(t => t.id===s.eventTypeId)?.weight) ?? 1]));
  const rawScore = (r) => recordWeight(r);
  const sessionWeight = (sessionId) => applyEvent ? (eventWeightBySession.get(sessionId) ?? 1) : 1;

  // Personal records
  const personRecords = records.filter(r => r.personId === pid && r.status && r.status !== 'non_service');
  const counts = { present:0, online:0, excused:0, tardy:0, absent:0, early_leave:0, very_early_leave:0 };
  for (const rec of personRecords) accumulateRecordCounts(counts, rec);
  const weightSum = personRecords.reduce((sum, r) => sum + sessionWeight(r.sessionId), 0);
  const avg = weightSum ? (personRecords.reduce((sum, r) => sum + rawScore(r) * sessionWeight(r.sessionId), 0) / weightSum) : 0;
  personSummaryEl.innerHTML = `<div><strong>Avg:</strong> ${Math.round(avg*100)}%</div><div><strong>Present:</strong> ${counts.present||0}</div><div><strong>Online:</strong> ${counts.online||0}</div><div><strong>Tardy:</strong> ${counts.tardy||0}</div><div><strong>Left Early:</strong> ${counts.early_leave||0}</div><div><strong>Left Very Early:</strong> ${counts.very_early_leave||0}</div><div><strong>Absent:</strong> ${counts.absent||0}</div>`;

  // Day-of-week (individual)
  if (personDOWIndEl) {
    personDOWIndEl.innerHTML = '';
    const rateSum = {1:0,2:0,3:0,4:0,5:0};
    const weightByDow = {1:0,2:0,3:0,4:0,5:0};
    for (const r of personRecords) {
      const s = sessions.find(s=>s.id===r.sessionId); if (!s) continue; if (s.dow < 1 || s.dow > 5) continue;
      const weight = sessionWeight(r.sessionId);
      rateSum[s.dow] += rawScore(r) * weight;
      weightByDow[s.dow] += weight;
    }
    const dayNames = ['Mon','Tue','Wed','Thu','Fri'];
    for (let d=1; d<=5; d++) {
      const avgD = weightByDow[d] ? (rateSum[d] / weightByDow[d]) : 0;
      const style = calendarCellStyle(avgD);
      const textColor = avgD >= 0.6 ? '#000000' : 'var(--text)';
      const cell = document.createElement('div');
      cell.className = 'heat'; cell.setAttribute('role','gridcell');
      cell.style = style + `;color:${textColor}`; cell.textContent = `${dayNames[d-1]}\n${Math.round(avgD*100)}%`;
      personDOWIndEl.appendChild(cell);
    }
  }

  // Day-of-week (team overall)
  if (personDOWTeamEl) {
    personDOWTeamEl.innerHTML = '';
    const rateSum = {1:0,2:0,3:0,4:0,5:0};
    const weightByDow = {1:0,2:0,3:0,4:0,5:0};
    for (const r of records) {
      if (!r.status || r.status === 'non_service') continue;
      const s = sessions.find(s=>s.id===r.sessionId); if (!s) continue; if (s.dow < 1 || s.dow > 5) continue;
      const weight = sessionWeight(r.sessionId);
      rateSum[s.dow] += rawScore(r) * weight;
      weightByDow[s.dow] += weight;
    }
    const dayNames = ['Mon','Tue','Wed','Thu','Fri'];
    for (let d=1; d<=5; d++) {
      const avgD = weightByDow[d] ? (rateSum[d] / weightByDow[d]) : 0;
      const style = calendarCellStyle(avgD);
      const textColor = avgD >= 0.6 ? '#000000' : 'var(--text)';
      const cell = document.createElement('div');
      cell.className = 'heat'; cell.setAttribute('role','gridcell');
      cell.style = style + `;color:${textColor}`; cell.textContent = `${dayNames[d-1]}\n${Math.round(avgD*100)}%`;
      personDOWTeamEl.appendChild(cell);
    }
  }

  // Daily breakdown for this person (weekdays only)
  if (personDaysEl) {
    const items = [];
    // Map by date
    const byDate = new Map();
    for (const r of personRecords) {
      const s = sessions.find(s=>s.id===r.sessionId); if (!s) continue; const d = s.date; byDate.set(d, { r, s });
    }
    const dates = [...byDate.keys()].sort();
    const weekdayDates = dates.filter(ds => { const wd = isoWeekday(ds); return wd>=1 && wd<=5; });
    const padCount = weekdayDates.length ? (isoWeekday(weekdayDates[0]) - 1) : 0;
    for (let i=0;i<padCount;i++) items.push(`<div class=\"card analytics-card empty\"></div>`);
    for (const d of weekdayDates) {
      const { r, s } = byDate.get(d);
      const score = rawScore(r);
      const textColor = score >= 0.6 ? '#000000' : 'var(--text)';
      const subColor = score >= 0.6 ? '#001014' : 'var(--muted)';
      const statuses = recordStatusKeys(r);
      const statusLabel = statuses.length ? statuses.map(statusLabelText).join(' + ') : 'Unmarked';
      const tardyMinutes = statuses.includes('tardy') && typeof r.minutesLate === 'number' ? ` (${r.minutesLate}m late)` : '';
      const ev = state.eventTypes.find(t => t.id === s.eventTypeId);
      items.push(`<div class=\"card analytics-card\" style=\"${calendarCellStyle(score)};color:${textColor}\" data-date=\"${d}\">`
        + `<div class=\"day-title\">${d} (${ev?.label||s.eventTypeId})</div>`
        + `<div class=\"kpis\" style=\"color:${subColor}\">Status: ${statusLabel}${tardyMinutes}</div>`
        + `<div class=\"cal-score percent-outline\">${Math.round(score*100)}%</div>`
        + `<div style=\"margin-top:6px; display:flex; gap:8px;\"><button type=\"button\" data-action=\"open-take\" data-date=\"${d}\">Open in Take</button></div>`
        + `</div>`);
    }
    personDaysEl.innerHTML = items.join('');
    personDaysEl.querySelectorAll('[data-action="open-take"]').forEach(btn => btn.addEventListener('click', async (e) => { const date = e.currentTarget.getAttribute('data-date'); takeDateEl.value = date; await ensureSession(); await renderPeopleList(); window.location.hash = '#/take'; }));
  }
}

// Calendar
function monthBounds(monthStr) { const first = dayjs(monthStr + '-01'); const last = first.endOf('month'); return { first, last }; }
function shiftCalendarMonth(delta) {
  if (!calMonthEl) return;
  const curr = calMonthEl.value || dayjs().format('YYYY-MM');
  const d = dayjs(curr + '-01').add(delta, 'month');
  calMonthEl.value = d.format('YYYY-MM');
  renderCalendar();
}
async function renderCalendar() {
  if (!calGridEl) return;
  const monthStr = calMonthEl?.value || dayjs().format('YYYY-MM');
  const { first, last } = monthBounds(monthStr);
  const from = first.format('YYYY-MM-DD');
  const to = last.format('YYYY-MM-DD');
  const eventTypeId = calEventEl?.value || undefined;
  const applyEvent = !!calApplyEventWeightEl?.checked;

  const { sessions, records } = await DB.recordsForRange(from, to, eventTypeId);
  const eventWeightBySession = new Map(sessions.map(s => [s.id, (state.eventTypes.find(t => t.id===s.eventTypeId)?.weight) ?? 1]));
  const rawScore = (r) => recordWeight(r);
  const sessionWeight = (sessionId) => applyEvent ? (eventWeightBySession.get(sessionId) ?? 1) : 1;

  const recsByDate = new Map();
  const sessionById = new Map(sessions.map(s => [s.id, s]));
  for (const r of records) {
    const s = sessionById.get(r.sessionId);
    if (!s) continue;
    if (!recsByDate.has(s.date)) recsByDate.set(s.date, []);
    recsByDate.get(s.date).push(r);
  }

  // Build list of weekday dates (Mon..Fri) for this month
  const weekdayDates = [];
  let cursor = first;
  while (cursor.isBefore(last) || cursor.isSame(last, 'day')) {
    const wd = isoWeekday(cursor.format('YYYY-MM-DD'));
    if (wd >= 1 && wd <= 5) weekdayDates.push(cursor);
    cursor = cursor.add(1, 'day');
  }

  const firstWD = weekdayDates[0];
  const startOffset = firstWD ? (isoWeekday(firstWD.format('YYYY-MM-DD')) - 1) : 0; // 0..4
  const cells = [];
  for (let i = 0; i < startOffset; i++) cells.push({ empty: true });
  for (const d of weekdayDates) {
    const ds = d.format('YYYY-MM-DD');
    const recs = (recsByDate.get(ds) || []).filter(r => r.status && r.status !== 'non_service');
    const weightSum = recs.reduce((sum, r) => sum + sessionWeight(r.sessionId), 0);
    const avg = weightSum ? recs.reduce((sum, r) => sum + rawScore(r) * sessionWeight(r.sessionId), 0) / weightSum : 0;
    const counts = { present:0, online:0, excused:0, tardy:0, absent:0, early_leave:0, very_early_leave:0, non_service:0 };
    for (const rec of recs) accumulateRecordCounts(counts, rec);
    cells.push({ date: ds, day: d.date(), avg, counts });
  }

  calGridEl.innerHTML = '';
  cells.forEach(cell => {
    const div = document.createElement('div');
    div.className = 'cal-cell' + (cell.empty ? ' empty' : '');
    if (cell.empty) { calGridEl.appendChild(div); return; }
    div.setAttribute('role', 'gridcell');
    div.setAttribute('tabindex', '0');
    div.dataset.date = cell.date;
    div.setAttribute('aria-label', `${cell.date}: ${Math.round(cell.avg*100)}% avg score`);
    div.style = calendarCellStyle(cell.avg);
    div.innerHTML = `<div class="cal-date">${cell.day}</div><div class="cal-badge">${(cell.counts.present||0)}P/${(cell.counts.online||0)}O/${(cell.counts.tardy||0)}T/${(cell.counts.excused||0)}E</div><div class="cal-score">${Math.round(cell.avg*100)}%</div>`;
    div.addEventListener('click', () => showCalendarDetail(cell.date, cell.counts, cell.avg));
    div.addEventListener('keydown', (e) => { if (e.key==='Enter' || e.key===' ') { e.preventDefault(); showCalendarDetail(cell.date, cell.counts, cell.avg); } });
    calGridEl.appendChild(div);
  });
  // Weekly summaries (Mon–Fri only)
  if (calWeeksEl) {
    // Build map weekStart (Mon) -> dates in that week
    const weekMap = new Map();
    for (const d of weekdayDates) {
      const ds = d.format('YYYY-MM-DD');
      const wd = isoWeekday(ds);
      const weekStart = d.subtract(wd-1, 'day').format('YYYY-MM-DD');
      if (!weekMap.has(weekStart)) weekMap.set(weekStart, []);
      weekMap.get(weekStart).push(ds);
    }
    const cards = [];
    for (const [wk, datesList] of weekMap) {
      let weightTotal = 0, rateAcc = 0;
      const agg = { present:0, online:0, excused:0, tardy:0, absent:0 };
      for (const ds of datesList) {
        const recs = (recsByDate.get(ds) || []).filter(r => r.status && r.status !== 'non_service');
        if (recs.length === 0) continue;
        for (const r of recs) {
          const weight = sessionWeight(r.sessionId);
          weightTotal += weight;
          rateAcc += rawScore(r) * weight;
          agg[r.status] = (agg[r.status]||0)+1;
        }
      }
      const avg = weightTotal ? (rateAcc/weightTotal) : 0;
      const textColor = avg >= 0.6 ? '#000000' : 'var(--text)';
      cards.push(`<div class=\"card\" style=\"${calendarCellStyle(avg)};color:${textColor}\"><div style=\"display:flex;justify-content:space-between;align-items:center;\"><strong>Week of ${wk}</strong><span class=\"kpi-rate percent-outline\">${Math.round(avg*100)}%</span></div><div style=\"margin-top:6px;color:${textColor === '#000000' ? '#001014' : 'var(--muted)'}\">${agg.present||0}P • ${agg.online||0}O • ${agg.tardy||0}T • ${agg.excused||0}E • ${agg.absent||0}A</div></div>`);
    }
    calWeeksEl.innerHTML = cards.join('');
  }
}
function showCalendarDetail(dateStr, counts, avg) { const html = `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;"><h3 style="margin:0;">${dateStr}</h3><div><strong>Avg:</strong> ${Math.round(avg*100)}%</div></div><div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:6px;"><span>Present: <strong>${counts.present||0}</strong></span><span>Online: <strong>${counts.online||0}</strong></span><span>Tardy: <strong>${counts.tardy||0}</strong></span><span>Excused: <strong>${counts.excused||0}</strong></span><span>Early: <strong>${counts.early_leave||0}</strong></span><span>Very Early: <strong>${counts.very_early_leave||0}</strong></span><span>Absent: <strong>${counts.absent||0}</strong></span></div><div style="margin-top:8px; display:flex; gap:8px;"><button type="button" id="cal-open-take">Open in Take</button></div>`; calDetailEl.innerHTML = html; document.getElementById('cal-open-take').addEventListener('click', async () => { takeDateEl.value = dateStr; await ensureSession(); await renderPeopleList(); window.location.hash = '#/take'; }); }

// Settings
const settingsForm = document.getElementById('settings-form');
const settingsTeamName = document.getElementById('settings-teamName');
const settingsTardy = document.getElementById('settings-tardy');
const settingsLow = document.getElementById('settings-low');
const settingsMid = document.getElementById('settings-mid');
const settingsHigh = document.getElementById('settings-high');
const eventTypesTbody = document.getElementById('event-types-tbody');
const addEventTypeBtn = document.getElementById('add-event-type');
const downloadJsonBtn = document.getElementById('download-json');
const uploadJsonBtn = document.getElementById('upload-json-btn');
const uploadJsonInput = document.getElementById('upload-json-input');
const importV1Btn = document.getElementById('import-v1-btn');
const clearDataBtn = document.getElementById('clear-data');

function renderEventTypesTable() {
  if (!eventTypesTbody) return;
  eventTypesTbody.innerHTML = state.eventTypes.map(et => `<tr data-id="${et.id}"><td contenteditable="true" data-col="label">${et.label}</td><td contenteditable="true" data-col="weight">${et.weight}</td><td><button data-action="delete" type="button">Delete</button></td></tr>`).join('');
}

function syncSettingsForm() {
  const s = state.settings || {};
  const thresholds = s.legendThresholds || DEFAULT_LEGEND_THRESHOLDS;
  if (settingsTeamName) settingsTeamName.value = s.teamName || '';
  if (settingsTardy) settingsTardy.value = s.tardyThresholdMins != null ? String(s.tardyThresholdMins) : '5';
  if (settingsLow) settingsLow.value = thresholds.low != null ? String(thresholds.low) : String(DEFAULT_LEGEND_THRESHOLDS.low);
  if (settingsMid) settingsMid.value = thresholds.mid != null ? String(thresholds.mid) : String(DEFAULT_LEGEND_THRESHOLDS.mid);
  if (settingsHigh) settingsHigh.value = thresholds.high != null ? String(thresholds.high) : String(DEFAULT_LEGEND_THRESHOLDS.high);
}

eventTypesTbody?.addEventListener('blur', async (e) => {
  const cell = e.target.closest('[data-col]'); if (!cell) return; const tr = cell.closest('tr'); const id = tr.dataset.id; const et = state.eventTypes.find(x=>x.id===id); if (!et) return; const col = cell.getAttribute('data-col'); let val = cell.textContent?.trim() || '';
  if (col==='label') { et.label = val; }
  if (col==='weight') { et.weight = Number(val) || 1; }
  await DB.saveEventType(et); await loadSettingsAndTypes();
}, true);

eventTypesTbody?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action="delete"]'); if (!btn) return; const tr = btn.closest('tr'); const id = tr.dataset.id; if (!confirm('Delete event type?')) return; await DB.deleteEventType(id); await loadSettingsAndTypes(); renderEventTypesTable(); hydrateEventTypeSelects(); buildEventStepper();
});

addEventTypeBtn?.addEventListener('click', async () => {
  const label = prompt('Event label'); if (!label) return; const weight = Number(prompt('Weight (0..1)', '1') || '1'); const id = label.toLowerCase().replace(/\s+/g,'_'); await DB.saveEventType({ id, label, weight: Number.isFinite(weight) ? weight : 1 }); await loadSettingsAndTypes(); renderEventTypesTable(); hydrateEventTypeSelects(); buildEventStepper();
});

async function downloadBackup({ filename = 'attendance_backup.json', toastMessage = 'Backup downloaded. Store the JSON in a safe spot before clearing data.', toastDuration = 2200, toast = true } = {}) {
  const data = await DB.exportAllAsJson();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  if (toast) showToast(toastMessage, toastDuration);
}

downloadJsonBtn?.addEventListener('click', () => {
  downloadBackup();
});
uploadJsonBtn?.addEventListener('click', () => {
  showToast('Select a backup JSON to restore. This will replace the current records.', 2600);
  uploadJsonInput?.click();
});
uploadJsonInput?.addEventListener('change', async () => {
  const file = uploadJsonInput.files?.[0];
  if (!file) {
    showToast('Restore canceled — no file selected.', 1600);
    return;
  }
  const text = await file.text();
  await DB.importAllFromJson(JSON.parse(text));
  await loadSettingsAndTypes();
  await loadPeople();
  await ensureSession();
  await renderPeopleList();
  renderTrackingStats();
  renderRoster();
  showToast('Backup restored. Double-check today’s session before continuing.', 2400);
});
importV1Btn?.addEventListener('click', async () => { const res = await DB.importFromV1IfPresent(); if (res.imported) { await loadSettingsAndTypes(); await loadPeople(); await ensureSession(); await renderPeopleList(); renderTrackingStats(); renderRoster(); showToast(`Imported v1 (${res.people} people, ${res.records} records)`, 2200); } else { showToast('No v1 data found'); } });
clearDataBtn?.addEventListener('click', async () => { if (!confirm('Really clear ALL data?')) return; await DB.dexie.delete(); window.location.reload(); });

settingsForm?.addEventListener('change', async () => {
  if (!state.settings) return;
  const s = state.settings;
  const nextTeamName = settingsTeamName?.value?.trim();
  if (nextTeamName !== undefined) s.teamName = nextTeamName || s.teamName || '';
  const parsedTardy = Number(settingsTardy?.value);
  if (Number.isFinite(parsedTardy)) s.tardyThresholdMins = parsedTardy;
  const currentThresholds = { ...DEFAULT_LEGEND_THRESHOLDS, ...(s.legendThresholds || {}) };
  const parsedLow = Number(settingsLow?.value);
  const parsedMid = Number(settingsMid?.value);
  const parsedHigh = Number(settingsHigh?.value);
  s.legendThresholds = {
    low: Number.isFinite(parsedLow) ? parsedLow : currentThresholds.low,
    mid: Number.isFinite(parsedMid) ? parsedMid : currentThresholds.mid,
    high: Number.isFinite(parsedHigh) ? parsedHigh : currentThresholds.high,
  };
  await DB.dexie.settings.put(s);
  titleEl.textContent = s.teamName || 'Attendance';
  showToast('Settings saved');
  syncSettingsForm();
});

// Wiring date/event controls
takeDatePrevBtn?.addEventListener('click', async () => { const d = dayjs((takeDateEl.value||state.currentDate)).subtract(1,'day'); takeDateEl.value = d.format('YYYY-MM-DD'); await ensureSession(); await renderPeopleList(); renderTrackingStats(); });
takeDateNextBtn?.addEventListener('click', async () => { const d = dayjs((takeDateEl.value||state.currentDate)).add(1,'day'); takeDateEl.value = d.format('YYYY-MM-DD'); await ensureSession(); await renderPeopleList(); renderTrackingStats(); });
takeDateTodayBtn?.addEventListener('click', async () => { takeDateEl.value = dayjs().format('YYYY-MM-DD'); await ensureSession(); await renderPeopleList(); renderTrackingStats(); });
takeDateEl?.addEventListener('change', async () => { await ensureSession(); await renderPeopleList(); renderTrackingStats(); });
takeEventEl?.addEventListener('change', async () => { localStorage.setItem('lastEventTypeId', takeEventEl.value); await ensureSession(); await renderPeopleList(); });
takeSearchEl?.addEventListener('input', debounce(renderPeopleList, 150));
takeShowAllEl?.addEventListener('change', () => { state.showAll = !!takeShowAllEl.checked; localStorage.setItem('take_show_all', String(state.showAll)); renderPeopleList(); });
takeHiddenToggleBtn?.addEventListener('click', () => { if (!takeShowAllEl) return; takeShowAllEl.checked = true; state.showAll = true; localStorage.setItem('take_show_all', 'true'); renderPeopleList(); });
takeHiddenHideBtn?.addEventListener('click', () => { if (!takeShowAllEl) return; takeShowAllEl.checked = false; state.showAll = false; localStorage.setItem('take_show_all', 'false'); renderPeopleList(); });

navigatorListEl?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-date]');
  if (!btn) return;
  const date = btn.getAttribute('data-date');
  if (!date) return;
  const type = btn.getAttribute('data-type') || 'pending';
  if (takeDateEl) takeDateEl.value = date;
  if (takeEventEl && state.eventTypes.some(t => t.id === REQUIRED_EVENT_ID)) {
    takeEventEl.value = REQUIRED_EVENT_ID;
    state.currentEventTypeId = REQUIRED_EVENT_ID;
    localStorage.setItem('lastEventTypeId', REQUIRED_EVENT_ID);
  }
  await ensureSession();
  await renderPeopleList();
  renderTrackingStats();
  const format = dayjs(date).format('MMM D');
  const message = type === 'blank'
    ? `Jumped to ${format}. Log everyone for Office.`
    : `Jumped to ${format}. Finish the remaining Office entries.`;
  showToast(message, 2200);
  window.location.hash = '#/take';
});

function updateHiddenInfoBar() {
  if (!takeHiddenInfoEl || !takeHiddenCountEl) return;
  const base = filterPeople(takeSearchEl?.value);
  const date = takeDateEl.value || state.currentDate;
  const hiddenCount = base.filter(p => !isPersonServingOn(date, p) || p.active === false).length;
  // Show the info bar whenever missionaries are hidden by service-day or inactive filters
  if (hiddenCount > 0) {
    takeHiddenCountEl.textContent = String(hiddenCount);
    takeHiddenInfoEl.hidden = false;
    if (takeHiddenToggleBtn) takeHiddenToggleBtn.disabled = !!state.showAll;
    if (takeHiddenHideBtn) takeHiddenHideBtn.disabled = !state.showAll;
  } else {
    takeHiddenInfoEl.hidden = true;
  }
}

// Insights/trends/cal events
analyticsRunBtn?.addEventListener('click', runAnalytics);
analyticsSmoothRate?.addEventListener('change', runAnalytics);
analyticsShowPresent?.addEventListener('change', runAnalytics);
analyticsShowOnline?.addEventListener('change', runAnalytics);
analyticsShowExcused?.addEventListener('change', runAnalytics);
analyticsShowTardy?.addEventListener('change', runAnalytics);
analyticsShowAbsent?.addEventListener('change', runAnalytics);
analyticsShowRate?.addEventListener('change', runAnalytics);
analyticsActiveOnly?.addEventListener('change', runAnalytics);
analyticsTag?.addEventListener('input', debounce(runAnalytics, 200));
analyticsRange14?.addEventListener('click', () => { analyticsFrom.value = dayjs().subtract(14,'day').format('YYYY-MM-DD'); analyticsTo.value = dayjs().format('YYYY-MM-DD'); runAnalytics(); });
analyticsRange30?.addEventListener('click', () => { analyticsFrom.value = dayjs().subtract(30,'day').format('YYYY-MM-DD'); analyticsTo.value = dayjs().format('YYYY-MM-DD'); runAnalytics(); });
analyticsRange90?.addEventListener('click', () => { analyticsFrom.value = dayjs().subtract(90,'day').format('YYYY-MM-DD'); analyticsTo.value = dayjs().format('YYYY-MM-DD'); runAnalytics(); });
analyticsExportCsvBtn?.addEventListener('click', () => {
  // Build CSV of daily series currently shown
  const from = analyticsFrom.value || dayjs().subtract(30,'day').format('YYYY-MM-DD');
  const to = analyticsTo.value || dayjs().format('YYYY-MM-DD');
  // We don't have direct access to series here; re-run minimal compute by reading chart labels and datasets
  const chart = trendChart; if (!chart) return;
  const labels = chart.data.labels || [];
  const datasets = chart.data.datasets || [];
  const present = datasets[0]?.data || [];
  const online = datasets[1]?.data || [];
  const excused = datasets[2]?.data || [];
  const tardy = datasets[3]?.data || [];
  const absent = datasets[4]?.data || [];
  const rate = datasets[5]?.data || [];
  const header = ['Date','Present','Online','Excused','Tardy','Absent','Rate%'];
  const lines = [header.join(',')];
  for (let i=0;i<labels.length;i++) {
    const row = [
      labels[i],
      present[i] ?? 0,
      online[i] ?? 0,
      excused[i] ?? 0,
      tardy[i] ?? 0,
      absent[i] ?? 0,
      Math.round(((rate[i] ?? 0) * 100))
    ];
    lines.push(row.join(','));
  }
  const blob = new Blob([lines.join('\n')], { type:'text/csv' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `insights_${from}_${to}.csv`; a.click(); setTimeout(()=>URL.revokeObjectURL(url), 0);
});
analyticsCompare?.addEventListener('change', runAnalytics);
trendsRunBtn?.addEventListener('click', runTrends);
trendsSearchEl?.addEventListener('input', debounce(runTrends, 200));
trendsActiveOnly?.addEventListener('change', runTrends);
trendsTag?.addEventListener('input', debounce(runTrends, 200));
trendsSort?.addEventListener('change', runTrends);
trendsRange14?.addEventListener('click', () => { trendsFrom.value = dayjs().subtract(14, 'day').format('YYYY-MM-DD'); trendsTo.value = dayjs().format('YYYY-MM-DD'); runTrends(); });
trendsRange30?.addEventListener('click', () => { trendsFrom.value = dayjs().subtract(30, 'day').format('YYYY-MM-DD'); trendsTo.value = dayjs().format('YYYY-MM-DD'); runTrends(); });
trendsRange90?.addEventListener('click', () => { trendsFrom.value = dayjs().subtract(90, 'day').format('YYYY-MM-DD'); trendsTo.value = dayjs().format('YYYY-MM-DD'); runTrends(); });
trendsExportCsvBtn?.addEventListener('click', () => {
  const header = ['Name','Avg %','Present','Online','Tardy','Excused','Absent','Sessions','Tags'];
  const lines = [header.join(',')];
  for (const r of trendsRows) {
    const row = [r.name, Math.round(r.avg*100), r.presents, r.online, r.tardies, r.excused, r.absent, r.sessionsCount, (r.tags||[]).join('|')];
    lines.push(row.map(v => String(v).includes(',') ? `"${String(v).replaceAll('"','""')}"` : String(v)).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'trends_export.csv'; a.click(); setTimeout(()=>URL.revokeObjectURL(url), 0);
});
trendsLoadMoreBtn?.addEventListener('click', () => renderTrendsChunk(false));

// Person view events
personFrom?.addEventListener('change', renderPersonView);
personTo?.addEventListener('change', renderPersonView);
personEvent?.addEventListener('change', renderPersonView);
personApplyEventWeight?.addEventListener('change', renderPersonView);
personBackTrendsBtn?.addEventListener('click', () => { window.location.hash = '#/trends'; });
function updateThresholdReadout() {
  if (!trendsThreshReadout) return;
  const low = Number(trendsThreshLow?.value || 0);
  const high = Number(trendsThreshHigh?.value || 0);
  trendsThreshReadout.textContent = `Low: ${Math.round(low*100)}% • High: ${Math.round(high*100)}% (High is green threshold)`;
}
trendsThreshLow?.addEventListener('input', () => { updateThresholdReadout(); runTrends(); });
trendsThreshHigh?.addEventListener('input', () => { updateThresholdReadout(); runTrends(); });
trendsThreshPreset?.addEventListener('change', () => {
  const v = trendsThreshPreset.value;
  const presets = { standard: { low: 0.75, high: 0.90 }, balanced: { low: 0.70, high: 0.85 }, strict: { low: 0.80, high: 0.95 } };
  const p = presets[v] || presets.standard;
  if (trendsThreshLow) trendsThreshLow.value = String(p.low);
  if (trendsThreshHigh) trendsThreshHigh.value = String(p.high);
  updateThresholdReadout();
  runTrends();
});
trendsApplyThresholdsBtn?.addEventListener('click', async () => {
  const s = state.settings; if (!s) return; s.legendThresholds = { ...s.legendThresholds, low: Number(trendsThreshLow.value)||s.legendThresholds.low, high: Number(trendsThreshHigh.value)||s.legendThresholds.high };
  await DB.dexie.settings.put(s); showToast('Thresholds applied to settings');
});

// Trends card actions (pin, details, profile, open-take)
trendsPeopleEl?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button'); if (!btn) return; const card = btn.closest('.trend-card'); if (!card) return; const pid = card.getAttribute('data-pid');
  const action = btn.getAttribute('data-action');
  if (action === 'pin') {
    const set = new Set(JSON.parse(localStorage.getItem('trends_pins') || '[]'));
    if (set.has(pid)) set.delete(pid); else set.add(pid);
    localStorage.setItem('trends_pins', JSON.stringify([...set]));
    runTrends();
  }
  if (action === 'details') {
    const det = card.querySelector('.trend-details'); if (det) det.hidden = !det.hidden;
  }
  if (action === 'profile') {
    state.selectedPersonId = pid;
    window.location.hash = '#/person';
  }
  if (action === 'open-take') {
    const date = btn.getAttribute('data-date'); if (!date) return; takeDateEl.value = date; await ensureSession(); await renderPeopleList(); window.location.hash = '#/take';
  }
  if (action === 'delete-person') {
    const confirmMsg = 'Delete this missionary and all attendance records? This cannot be undone.';
    if (!confirm(confirmMsg)) return;
    await DB.deletePerson(pid);
    state.currentRecords.delete(pid);
    if (state.selectedPersonId === pid) state.selectedPersonId = null;
    try {
      const pins = new Set(JSON.parse(localStorage.getItem('trends_pins') || '[]'));
      if (pins.delete(pid)) localStorage.setItem('trends_pins', JSON.stringify([...pins]));
    } catch (err) {
      // ignore storage issues
    }
    await loadPeople();
    renderRoster();
    await renderPeopleList();
    renderTrackingStats();
    await runTrends();
    const insightsView = document.getElementById('view-insights');
    if (insightsView && !insightsView.hidden) await runAnalytics();
    const personViewEl = document.getElementById('view-person');
    if (personViewEl && !personViewEl.hidden) await renderPersonView();
  }
});

const helpToc = document.getElementById('help-toc');
helpToc?.addEventListener('click', (e) => {
  const trigger = e.target.closest('button[data-target]');
  if (!trigger) return;
  e.preventDefault();
  const id = trigger.getAttribute('data-target');
  if (!id) return;
  const section = document.getElementById(id);
  if (!section) return;
  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (typeof section.focus === 'function') {
    try { section.focus({ preventScroll: true }); }
    catch (err) { section.focus(); }
  }
});
calMonthEl?.addEventListener('change', renderCalendar);
calEventEl?.addEventListener('change', renderCalendar);
calApplyEventWeightEl?.addEventListener('change', renderCalendar);
calTodayBtn?.addEventListener('click', () => { if (calMonthEl) calMonthEl.value = dayjs().format('YYYY-MM'); renderCalendar(); });
calMonthPrevBtn?.addEventListener('click', () => shiftCalendarMonth(-1));
calMonthNextBtn?.addEventListener('click', () => shiftCalendarMonth(1));

// Keyboard: ArrowLeft/ArrowRight to change month when Calendar view is active
window.addEventListener('keydown', (e) => {
  const calView = document.querySelector('[data-view="calendar"]');
  if (!calView || calView.hidden) return;
  const ae = document.activeElement;
  const tag = (ae?.tagName || '').toLowerCase();
  if (ae?.isContentEditable || tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); shiftCalendarMonth(-1); }
  if (e.key === 'ArrowRight') { e.preventDefault(); shiftCalendarMonth(1); }
});

// Utility: wait for CDN globals (Dexie/dayjs) before importing DB module
function waitForGlobal(name, timeout = 5000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function check() {
      if (typeof window[name] !== 'undefined') return resolve(window[name]);
      if (Date.now() - start > timeout) return reject(new Error(`${name} not available`));
      setTimeout(check, 25);
    })();
  });
}

async function ensureLibraries() {
  // Dexie and dayjs are required for DB; Chart/XLSX are optional until used
  await waitForGlobal('Dexie');
  await waitForGlobal('dayjs');
  const mod = await import('./db.js');
  DB = mod.DB;
}

// Init
async function init() {
  await ensureLibraries();
  await DB.seedDefaults();
  await loadSettingsAndTypes();
  await loadPeople();

  // Default date/event
  state.currentDate = dayjs().format('YYYY-MM-DD');
  takeDateEl.value = state.currentDate;
  takeEventEl.value = pickDefaultEventTypeId();
  state.currentEventTypeId = takeEventEl.value;
  // Restore "Show all" preference
  const showAllPref = localStorage.getItem('take_show_all');
  state.showAll = showAllPref ? (showAllPref === 'true') : false;
  if (takeShowAllEl) takeShowAllEl.checked = state.showAll;
  analyticsFrom.value = dayjs().subtract(30, 'day').format('YYYY-MM-DD');
  analyticsTo.value = dayjs().format('YYYY-MM-DD');
  analyticsEvent.value = '';
  trendsFrom.value = analyticsFrom.value; trendsTo.value = analyticsTo.value; trendsEvent.value = '';
  if (personFrom && personTo) {
    personFrom.value = dayjs().subtract(60, 'day').format('YYYY-MM-DD');
    personTo.value = dayjs().format('YYYY-MM-DD');
  }
  if (personEvent) personEvent.value = '';
  if (trendsThreshLow && trendsThreshHigh) {
    const s = state.settings?.legendThresholds || { low: 0.75, high: 0.9 };
    trendsThreshLow.value = String(s.low);
    trendsThreshHigh.value = String(s.high);
    if (trendsThreshReadout) trendsThreshReadout.textContent = `Low: ${trendsThreshLow.value} • High: ${trendsThreshHigh.value}`;
  }
  calMonthEl.value = dayjs().format('YYYY-MM');

  await ensureSession();
  await renderPeopleList();
  renderTrackingStats();
  renderRoster();

  initRouter('take');
}

init().catch(err => {
  console.error(err);
  const t = document.getElementById('toast');
  if (t) {
    t.hidden = false;
    t.textContent = 'Failed to load libraries. Please run via http://localhost and reload.';
  }
});
