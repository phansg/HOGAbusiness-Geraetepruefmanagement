import { connectFirebase } from './firebase-client.js';

const $ = id => document.getElementById(id);
const view = $('view');
const dialog = $('dialog');
$('login-form').addEventListener('submit', event => event.preventDefault());
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const button = (label, action, cls = '') => `<button type="button" data-action="${esc(action)}" class="${cls}">${esc(label)}</button>`;
const select = (name, label, options, value = '') => `<label>${label}<select name="${name}">${options.map(option => {
  const [id, caption] = Array.isArray(option) ? option : [option, option];
  return `<option value="${esc(id)}" ${id === value ? 'selected' : ''}>${esc(caption || 'Bitte wählen')}</option>`;
}).join('')}</select></label>`;
const field = (name, label, value, type = 'text', extra = '') => `<label>${label}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
const area = (name, label, value) => `<label>${label}<textarea name="${name}">${esc(value)}</textarea></label>`;
const checkbox = (name, label, value) => `<label><input type="checkbox" name="${name}" ${value ? 'checked' : ''}>${label}</label>`;
const card = (title, contents) => `<section class="card"><h2>${title}</h2>${contents}</section>`;
const data = form => Object.fromEntries([...new FormData(form)]);
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date());
const monthAhead = () => { const day = new Date(today() + 'T12:00:00Z'); day.setUTCDate(day.getUTCDate() + 30); return day.toISOString().slice(0, 10); };
const ordered = (values, name) => [...values].sort((a, b) => String(a[name]).localeCompare(String(b[name]), 'de'));
const rows = (heads, entries) => entries.length ? `<table><thead><tr>${heads.map(h => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${entries.map(row => `<tr>${row.map((cell, i) => `<td ${heads[i] ? 'data-label="' + heads[i] + '"' : ''}>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '<p>Keine Einträge vorhanden.</p>';
let archiveFilters = {};
let draftTimer;
let auth, callable, session, workspace, tenant = '', tab = '', wizard, archive = [], cursor, archiveDevice = '', globalData, activePdf, busy = false;
const captions = { Dashboard: 'Dashboard', Geräte: 'Geräte', Prüfarchiv: 'Prüfarchiv', Mandant: 'Standorte und Zugänge', System: 'Systemverwaltung' };
function status(message, error = false) {
  $('sync').textContent = message;
  $('sync').classList.toggle('error', error);
  if (dialog.open && $('dialog-status')) $('dialog-status').textContent = error ? message : '';
}
function errorMessage(e) {
  return ({ 'auth/invalid-credential': 'E-Mail, Passwort oder Anmeldebereich prüfen.', 'auth/user-not-found': 'E-Mail, Passwort oder Anmeldebereich prüfen.', 'auth/wrong-password': 'E-Mail, Passwort oder Anmeldebereich prüfen.', 'functions/unavailable': 'Prüfserver nicht erreichbar. Verbindung und Einrichtung prüfen.' })[e.code] || e.message;
}
async function run(action) {
  if (busy) return;
  busy = true;
  try { await action(); } catch (e) { status(errorMessage(e), true); }
  finally { busy = false; }
}
async function call(action, input = {}, message = 'Synchronisiert') {
  status('Synchronisierung läuft …');
  const result = (await callable({ action, input: { tenant, ...input } })).data;
  status(message);
  return result;
}
function modal(title, html, callback) {
  dialog.innerHTML = `<div class="actions">${button('Schließen', 'close')}</div><h2>${esc(title)}</h2><p id="dialog-status" class="bad" role="alert"></p>${html}`;
  dialog.onsubmit = e => { e.preventDefault(); if (callback) run(() => callback(e.target)); };
  if (!dialog.open) dialog.showModal();
}
dialog.addEventListener('close', () => { if (activePdf) URL.revokeObjectURL(activePdf); activePdf = null; dialog.replaceChildren(); });
function edit(title, content, callback) {
  modal(title, `<form><div class="grid">${content}</div><button class="primary">Speichern</button></form>`, async form => {
    await callback(data(form), form);
    dialog.close();
  });
}
function downloadJson(filename, value) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function refreshSession() {
  session = await call('session');
  $('tenant').innerHTML = session.tenants.map(t => `<option value="${esc(t.id)}">${esc(t.name + (t.active === false ? ' (inaktiv)' : ''))}</option>`).join('');
  if (!session.tenants.some(t => t.id === tenant && t.active !== false)) tenant = session.tenants.find(t => t.active !== false)?.id || '';
  $('tenant').value = tenant;
  $('greeting').textContent = session.name;
  await refreshWorkspace();
}
async function refreshWorkspace() {
  workspace = tenant ? await call('workspace') : null;
}
function nav() {
  const tabs = [...(workspace ? ['Dashboard', 'Geräte', 'Prüfarchiv'] : []), ...(workspace?.admin ? ['Mandant'] : []), ...(session.system ? ['System'] : [])];
  $('navigation').innerHTML = tabs.map(label => `<button type="button" data-action="tab:${label}" aria-current="${label === tab}">${captions[label]}</button>`).join('');
}
async function show(next) {
  wizard = null; tab = next;
  nav();
  if (next === 'Dashboard') renderDashboard();
  else if (next === 'Geräte') renderDevices();
  else if (next === 'Mandant') renderTenant();
  else if (next === 'System') { globalData = await call('global'); renderSystem(); }
  else if (next === 'Prüfarchiv') { archive = []; cursor = null; view.innerHTML = ''; await loadArchive(); }
  else view.innerHTML = card('Kein aktiver Mandant', '<p>Für diesen Zugang ist derzeit kein Mandant freigeschaltet.</p>');
}
function dashboardTab() { return workspace ? 'Dashboard' : session.system ? 'System' : ''; }
function renderDashboard() {
  const active = workspace.devices.filter(d => d.status === 'Aktiv');
  const late = active.filter(d => d.nextDue && d.nextDue < today());
  const soon = active.filter(d => d.nextDue >= today() && d.nextDue <= monthAhead());
  const unclear = active.filter(d => !d.nextDue);
  const defects = workspace.devices.filter(d => d.lastOutcome && d.lastOutcome !== 'Bestanden');
  view.innerHTML = `<h2>${esc(workspace.tenant.name)}</h2><div class="grid">${[[workspace.devices, 'Geräte'], [late, 'Überfällig'], [soon, 'Fällig in 30 Tagen'], [unclear, 'Ohne Fälligkeit']].map(([items, label]) => `<div class="card stat"><strong>${items.length}</strong>${label}</div>`).join('')}</div>` +
    card('Prüffälligkeiten', rows(['Gerät', 'Inventar', 'Fällig'], ordered([...late, ...soon], 'nextDue').map(d => [esc(d.name), esc(d.inventory), esc(d.nextDue)]))) +
    card('Letzte Prüfung mit negativem Ergebnis oder Abbruch', rows(['Gerät', 'Inventar', 'Ergebnis', ''], defects.map(d => [esc(d.name), esc(d.inventory), esc(d.lastOutcome), button('Historie', 'history:' + d.id)])));
}
function renderDevices() {
  view.innerHTML = card('Geräte', `<div class="grid">${field('search', 'Suche', '', 'search')}${select('status', 'Gerätestatus', [['', 'Alle'], 'Aktiv', 'Außer Betrieb', 'Ausgesondert'])}${select('site', 'Standort', [['', 'Alle'], ...workspace.locations.map(l => [l.id, l.name])])}</div>
  <div class="actions">${workspace.admin || workspace.examiner ? button('Gerät erfassen', 'device:new', 'primary') : ''}</div><div id="devices"></div>`);
  view.oninput = renderDeviceRows;
  renderDeviceRows();
}
function renderDeviceRows() {
  if (!$('devices')) return;
  const value = name => view.querySelector('[name="' + name + '"]').value;
  const query = value('search').trim().toLowerCase();
  const list = ordered(workspace.devices.filter(d => (!value('site') || d.locationId === value('site')) && (!value('status') || d.status === value('status')) &&
    [d.name, d.id, d.inventory, d.manufacturer, d.model, d.serial].some(s => String(s || '').toLowerCase().includes(query))), 'inventory');
  $('devices').innerHTML = rows(['Inventar / Gerät', 'Standort', 'Status / Ergebnis', 'Fälligkeit', 'Aktionen'], list.map(d => [
    `<strong>${esc(d.inventory)} · ${esc(d.name)}</strong><br><small>${esc(d.id)} · ${esc(d.manufacturer)} ${esc(d.model)}</small>`,
    esc(workspace.locations.find(l => l.id === d.locationId)?.name),
    `${esc(d.status)}<br><span class="${d.lastOutcome && d.lastOutcome !== 'Bestanden' ? 'bad' : ''}">${esc(d.lastOutcome || 'Keine Prüfung')}</span>`,
    esc(d.nextDue || 'Offen'),
    button('Details', 'details:' + d.id) + ' ' + button('Historie', 'history:' + d.id) +
    (workspace.admin || workspace.examiner ? ' ' + button('Bearbeiten', 'device:' + d.id) : '') +
    (workspace.examiner ? ' ' + button('Prüfen', 'wizard:' + d.id, 'primary') : '')
  ]));
}
const labels = { inventory: 'Inventarnummer', name: 'Bezeichnung', manufacturer: 'Hersteller', model: 'Typ', serial: 'Seriennummer', voltage: 'Nennspannung', power: 'Nennleistung', protection: 'Schutzklasse', connection: 'Anschluss', interval: 'Prüfintervall in Monaten', nextDue: 'Nächste Fälligkeit', status: 'Gerätestatus', conditions: 'Einsatzbedingungen', notes: 'Bemerkungen' };
function editDevice(d = {}) {
  edit(d.id ? 'Gerät bearbeiten' : 'Gerät erfassen',
    ['inventory', 'name', 'manufacturer', 'model', 'serial', 'voltage', 'power'].map(k => field(k, labels[k], d[k], 'text', ['inventory', 'name'].includes(k) ? 'required' : '')).join('') +
    select('protection', labels.protection, ['I', 'II', 'III', 'Ungeklärt'], d.protection || 'Ungeklärt') +
    select('connection', labels.connection, ['Schuko', 'CEE', 'Festanschluss', 'Sonstige'], d.connection || 'Schuko') +
    select('locationId', 'Standort', [['', 'Bitte wählen'], ...workspace.locations.map(l => [l.id, l.name])], d.locationId) +
    select('status', labels.status, ['Aktiv', 'Außer Betrieb', 'Ausgesondert'], d.status || 'Aktiv') +
    field('interval', labels.interval, d.interval || 12, 'number', 'required min="1" max="120"') +
    field('nextDue', labels.nextDue, d.nextDue, 'date', d.lastReport ? 'disabled' : '') +
    area('conditions', labels.conditions, d.conditions) + area('notes', labels.notes, d.notes),
    async values => { await call('device', { ...values, device: d.id || crypto.randomUUID(), revision: d.revision || 0 }); await refreshWorkspace(); renderDevices(); }
  );
}
function details(d) {
  modal('Gerätedetails', `<dl><dt>Gerätenummer</dt><dd>${esc(d.id)}</dd>${Object.entries(labels).map(([k, label]) => `<dt>${label}</dt><dd>${esc(d[k] ?? '–')}</dd>`).join('')}</dl>` +
    (workspace.admin || workspace.examiner ? button('Stammdatenhistorie', 'changes:' + d.id) : ''));
}
function renderTenant() {
  view.innerHTML = card('Standorte', button('Standort hinzufügen', 'location:new', 'primary') +
    rows(['Standort', 'Anschrift', ''], workspace.locations.map(l => [esc(l.name), esc(l.address), button('Bearbeiten', 'location:' + l.id)]))) +
    card('Zugänge und Prüferzuordnung', button('Zuordnung anlegen', 'membership:new') +
    rows(['Name', 'Rolle', 'Status', ''], workspace.members.map(m => [esc(m.name), (m.role === 'admin' ? 'Mandantenadministrator' : 'Betrachter') + (m.examiner ? ' · Prüferzuordnung' : ''), m.active ? 'Aktiv' : 'Inaktiv', session.system || (m.examiner && m.role !== 'admin') ? button('Bearbeiten', 'membership:' + m.id) : '']))) +
    card('Datenausfuhr', button('Geräte und Archiv als JSON exportieren', 'export'));
}
function editLocation(l = {}) {
  edit('Standort', field('name', 'Bezeichnung', l.name, 'text', 'required') + field('address', 'Anschrift', l.address),
    async values => { await call('location', { ...values, id: l.id || crypto.randomUUID() }); await refreshWorkspace(); renderTenant(); });
}
async function editMembership(m = {}) {
  const options = session.system ? (await call('global')).users : workspace.examiners;
  const all = options.map(u => [u.id, u.name]);
  if (m.id && !all.some(([id]) => id === m.id)) all.unshift([m.id, m.name]);
  edit('Mandantenzuordnung', select('target', 'Benutzer', m.id ? all.filter(([id]) => id === m.id) : [['', 'Bitte wählen'], ...all], m.id) +
    (session.system ? select('role', 'Mandantenrolle', [['viewer', 'Betrachter'], ['admin', 'Mandantenadministrator']], m.role) : '') +
    checkbox('active', 'Aktive Zuordnung', m.active ?? true) + checkbox('examiner', 'Als Prüfer zuordnen', m.examiner ?? !session.system),
    async v => { await call('member', { ...v, active: Boolean(v.active), examiner: Boolean(v.examiner) }); await refreshWorkspace(); renderTenant(); });
}
function renderSystem() {
  view.innerHTML = card('Mandanten', button('Mandant anlegen', 'tenantEdit:new', 'primary') + rows(['Name', 'Status', ''], session.tenants.map(t => [esc(t.name), t.active ? 'Aktiv' : 'Inaktiv', button('Bearbeiten', 'tenantEdit:' + t.id)]))) +
    card('Benutzer und Prüferfreigaben', button('Vorhandenes Auth-Konto zuordnen', 'user:new') + rows(['Benutzer', 'Anmeldebereich', 'Rechte', ''], globalData.users.map(u => [esc(u.name), u.area === 'staff' ? 'Intern' : 'Kundenportal', [u.active ? 'Aktiv' : 'Inaktiv', u.system && 'Systemadmin', u.approved && 'Prüferfreigabe'].filter(Boolean).join(' · '), button('Bearbeiten', 'user:' + u.id)]))) +
    card('Messgeräte', button('Messgerät anlegen', 'equipment:new') + rows(['Messgerät', 'Seriennummer', 'Kalibrierung', ''], globalData.equipment.map(m => [esc(m.name), esc(m.serial), esc(m.calibration), button('Bearbeiten', 'equipment:' + m.id)]))) +
    card('Einstellungen', `<p>${esc(globalData.settings.provider || 'Prüfdienstleister offen')}</p><p>${esc(globalData.profile.label)} · Version ${esc(globalData.profile.version)}</p>` + button('Prüfdienstleister bearbeiten', 'settings') + ' ' + button('Systemereignisse', 'audit'));
}
async function saveGlobal(action, values) { await call(action, values); await refreshSession(); await show('System'); }
function editTenant(t = {}) {
  edit('Mandant', field('name', 'Name', t.name, 'text', 'required') + field('contact', 'Kontakt / Anschrift', t.contact) + checkbox('active', 'Aktiv', t.active ?? true),
    v => saveGlobal('saveTenant', { ...v, id: t.id || crypto.randomUUID(), active: Boolean(v.active) }));
}
function editUser(u = {}) {
  edit('Benutzerprofil', field('uid', 'UID des vorhandenen Auth-Kontos', u.uid, 'text', u.uid ? 'readonly' : 'required') +
    select('area', 'Anmeldebereich', u.area ? [[u.area, u.area === 'staff' ? 'Intern' : 'Kundenportal']] : [['staff', 'Intern'], ['customer', 'Kundenportal']], u.area) +
    field('name', 'Anzeigename', u.name, 'text', 'required') + checkbox('active', 'Aktiv', u.active ?? true) +
    checkbox('system', 'Systemadministrator (intern)', u.system) + checkbox('approved', 'Prüferrolle für den Testbetrieb (intern)', u.approved),
    v => saveGlobal('saveUser', { ...v, active: Boolean(v.active), system: Boolean(v.system), approved: Boolean(v.approved) }));
}
function editEquipment(m = {}) {
  edit('Messgerät', field('name', 'Bezeichnung', m.name, 'text', 'required') + field('serial', 'Seriennummer', m.serial, 'text', 'required') +
    field('calibration', 'Letzte Kalibrierung', m.calibration, 'date', 'required') + area('methods', 'Dokumentierte Verfahren', m.methods) + checkbox('active', 'Aktiv', m.active ?? true),
    v => saveGlobal('saveEquipment', { ...v, id: m.id || crypto.randomUUID(), active: Boolean(v.active) }));
}
async function loadArchive() {
  const page = await call('archive', { device: archiveDevice, cursor, ...archiveFilters });
  archive.push(...page.results); cursor = page.cursor;
  renderArchive();
}
function renderArchive() {
  view.innerHTML = card('Prüfarchiv', `<form id="archive-filters"><div class="grid">${select('archive-device', 'Gerät', [['', 'Alle Geräte'], ...workspace.devices.map(d => [d.id, d.inventory + ' · ' + d.name])], archiveDevice)}
    ${select('outcome', 'Ergebnis', [['', 'Alle'], 'Bestanden', 'Nicht bestanden', 'Abgebrochen'], archiveFilters.outcome)}
    ${field('examiner', 'Prüfer (vollständiger Name)', archiveFilters.examiner)}
    ${field('from', 'Prüfdatum von', archiveFilters.from, 'date')}${field('to', 'Prüfdatum bis', archiveFilters.to, 'date')}
    </div><div class="actions"><button>Filtern</button>${button('Filter zurücksetzen', 'resetArchive')}</div></form>` +
    rows(['Protokoll / Gerät', 'Prüfdatum', 'Ergebnis', ''], archive.map(r => [
      `<strong>${esc(r.device.inventory)} · ${esc(r.device.name)}</strong><br><small>${esc(r.id)}</small>`,
      esc(r.preparation?.day || r.at.slice(0, 10)),
      r.corrects ? 'Berichtigung' : `<span class="${r.outcome === 'Bestanden' ? '' : 'bad'}">${esc(r.outcome)}</span>`,
      button('Details und PDF', 'report:' + r.id)
    ])) + (cursor ? button('Weitere Protokolle laden', 'more') : ''));
  $('archive-filters').onsubmit = event => {
    event.preventDefault();
    const { 'archive-device': device, ...filters } = data(event.target);
    run(async () => { archiveDevice = device; archiveFilters = filters; await show('Prüfarchiv'); });
  };
}
function reportDetails(r) {
  const visual = r.visual?.filter(v => v.result === 'Mangel').map(v => v.point + ' · ' + v.severity + ' · ' + v.note) || [];
  const measurements = Object.values(r.stages || {}).flatMap(stage => stage.points.filter(p => p.rating === 'Mangel').map(p => p.point + ' · ' + p.note));
  const findings = [...visual, ...measurements, ...(r.functionTest?.result === 'Mit Auffälligkeit' ? [r.functionTest.note] : [])];
  modal(r.corrects ? 'Berichtigung' : r.outcome,
    `<p>${esc(r.device.name)} · ${esc(r.examiner.name)}</p><p>${esc(r.assessment || r.reason)}</p>` +
    (r.corrects ? `<p>Original ${esc(r.corrects)}</p><p>${esc(r.note)}</p>` : '') +
    (findings.length ? '<h3>Mängel</h3><ul>' + findings.map(f => '<li>' + esc(f) + '</li>').join('') + '</ul>' : '') +
    (r.actions ? `<p><strong>Maßnahmen</strong> ${esc(r.actions)}</p>` : '') +
    `<div class="actions">${button('PDF-Vorschau', 'preview:' + r.id)}${button('PDF herunterladen', 'pdf:' + r.id)}${workspace.examiner && !r.corrects ? button('Berichtigung erfassen', 'correct:' + r.id) : ''}</div><div id="preview"></div>`);
}
const steps = ['Prüfvorbereitung', 'Sichtprüfung', 'Schutzleiterprüfung', 'Isolationsprüfung', 'Ableitstromprüfung', 'Funktionsprüfung', 'Gesamtbewertung'];
const stages = ['protective', 'insulation', 'leakage'];
const operators = ['=', '<', '≤', '>', '≥'];
function blankPoint() { return { operator: '=', limitOperator: '≤', at: new Date().toISOString() }; }
function fresh() {
  return {
    preparation: { day: today() },
    visual: ['Gehäuse', 'Anschlussleitung und Stecker', 'Kennzeichnung'].map(point => ({ point })),
    stages: Object.fromEntries(stages.map(name => [name, { points: [] }])),
    functionTest: {}
  };
}
async function startWizard(device) {
  const saved = await call('draft', { device: device.id });
  wizard = { device, form: saved?.data || fresh(), step: 0, revision: saved?.revision || 0, requestId: Date.now() + '-' + crypto.randomUUID() };
  tab = 'Prüfung'; nav(); renderWizard();
}
function renderWizard() {
  const { device, form, step } = wizard;
  let content;
  if (step === 0) {
    const p = form.preparation;
    content = `<p>${esc(device.inventory)} · Schutzklasse ${esc(device.protection)} · ${esc(device.connection)} · ${esc(session.name)}</p><p>Manuelles Testprofil v1. Prüfaufbau und Eignung dokumentieren. Nur fiktive Geräte und Messwerte verwenden.</p><div class="grid">` +
      field('day', 'Prüfdatum', p.day, 'date') + select('type', 'Prüfart', ['', 'Wiederholungsprüfung', 'Prüfung nach Reparatur', 'Sonstige'], p.type) +
      field('basis', 'Prüfgrundlage und Ausgabe', p.basis) + select('equipmentId', 'Messgerät', ['', ...workspace.equipment.map(e => [e.id, e.name + ' · ' + e.serial])], p.equipmentId) + '</div>' +
      area('suitability', 'Eignung, Aufbau und Besonderheiten', p.suitability);
  } else if (step === 1) {
    content = form.visual.map((v, i) => `<fieldset><legend>Sichtprüfpunkt ${i + 1}</legend><div class="grid">` +
      field('point' + i, 'Prüfpunkt', v.point) + select('result' + i, 'Ergebnis', ['', 'OK', 'Mangel', 'Nicht zutreffend'], v.result) +
      select('severity' + i, 'Schwere', ['', 'Sonstig', 'Sicherheitsrelevant'], v.severity) + area('note' + i, 'Beschreibung / Begründung', v.note) +
      '</div>' + button('Prüfpunkt entfernen', 'remove:' + i) + '</fieldset>').join('') + button('Sichtprüfpunkt hinzufügen', 'add');
  } else if (step <= 4) {
    const stage = form.stages[stages[step - 2]];
    content = select('status', 'Messstatus', ['', 'Gemessen', 'Nicht erforderlich', 'Nicht durchführbar'], stage.status) +
      area('reason', 'Begründung / Abweichung', stage.reason) +
      stage.points.map((p, i) => `<fieldset><legend>Messpunkt ${i + 1}</legend><div class="grid">` +
        field('point' + i, 'Messpunkt', p.point) + field('method' + i, 'Tatsächliches Messverfahren', p.method) +
        select('operator' + i, 'Messwertoperator', operators, p.operator) + field('value' + i, 'Messwert', p.value, 'number', 'step="any"') +
        field('unit' + i, 'Einheit', p.unit) + field('conditions' + i, 'Prüfspannung / Messbedingungen', p.conditions) + field('at' + i, 'Messzeitpunkt (ISO 8601)', p.at) +
        select('limitOperator' + i, 'Grenzwertoperator', operators, p.limitOperator) + field('limit' + i, 'Grenzwert', p.limit, 'number', 'step="any"') +
        field('source' + i, 'Grenzwertquelle oder Begründung', p.source) + select('rating' + i, 'Fachliche Einzelbewertung', ['', 'OK', 'Mangel'], p.rating) +
        area('note' + i, 'Bemerkung / Mangel', p.note) + '</div>' + button('Messpunkt entfernen', 'remove:' + i) + '</fieldset>').join('') +
      button('Messpunkt hinzufügen', 'add');
  } else if (step === 5) {
    const f = form.functionTest;
    content = select('result', 'Funktion', ['', 'Ohne Auffälligkeit', 'Mit Auffälligkeit', 'Nicht durchgeführt'], f.result) + area('note', 'Beschreibung / Begründung', f.note);
  } else {
    content = select('outcome', 'Gesamtergebnis', ['', 'Bestanden', 'Nicht bestanden', 'Abgebrochen'], form.outcome) +
      area('assessment', 'Fachliche Bewertung / Abbruchgrund', form.assessment) +
      area('actions', 'Maßnahmen', form.actions) +
      checkbox('confirm', 'Ich bestätige den Abschluss des fiktiven Testprotokolls.', form.confirm);
  }
  view.innerHTML = card((step + 1) + ' / 7 · ' + steps[step], `<p>${esc(device.name)}</p><progress max="7" value="${step + 1}" aria-label="Prüffortschritt"></progress><form id="wizard-form">${content}
    <div class="actions">${step > 0 ? button('Zurück', 'step:-1') : ''}${button('Entwurf speichern', 'saveDraft')}
    ${step < 6 ? button('Speichern und weiter', 'step:1', 'primary') : button('Prüfung abschließen', 'finish', 'primary')}</div></form>`);
  $('wizard-form').onsubmit = event => event.preventDefault();
  $('wizard-form').addEventListener('input', scheduleDraft);
}
function capture() {
  const { form, step } = wizard;
  const values = data($('wizard-form'));
  const subset = (keys, i) => Object.fromEntries(keys.map(key => [key, values[key + i]]));
  if (step === 0) form.preparation = values;
  else if (step === 1) form.visual = form.visual.map((_, i) => subset(['point', 'result', 'severity', 'note'], i));
  else if (step <= 4) {
    const stage = form.stages[stages[step - 2]];
    stage.status = values.status;
    stage.reason = values.reason;
    stage.points = stage.points.map((_, i) => {
      const p = subset(['point', 'method', 'operator', 'value', 'unit', 'conditions', 'limitOperator', 'limit', 'source', 'rating', 'note', 'at'], i);
      for (const k of ['value', 'limit']) p[k] = p[k] === '' ? null : Number(p[k]);
      return p;
    });
  } else if (step === 5) form.functionTest = values;
  else Object.assign(form, values, { confirm: Boolean(values.confirm) });
}
function draftInput() {
  const { device, form, revision, requestId } = wizard;
  return { device: device.id, form, revision, requestId };
}
function scheduleDraft() {
  if (!wizard) return;
  wizard.dirty = true;
  clearTimeout(draftTimer);
  status('Entwurf enthält ungespeicherte Änderungen.');
  draftTimer = setTimeout(() => {
    if (!wizard?.dirty) return;
    if (busy) { scheduleDraft(); return; }
    run(saveDraft);
  }, 1300);
}
async function saveDraft() {
  clearTimeout(draftTimer);
  capture();
  const sent = JSON.stringify(wizard.form);
  const result = await call('saveDraft', draftInput(), 'Entwurf gespeichert');
  wizard.revision = result.revision;
  capture();
  wizard.dirty = sent !== JSON.stringify(wizard.form);
  if (wizard.dirty) scheduleDraft();
}
async function leaveWizard() {
  if (wizard) { do { await saveDraft(); } while (wizard.dirty); }
}
const lookup = (source, id) => source.find(entry => entry.id === id);
async function handle(action) {
  const colon = action.indexOf(':');
  const name = colon < 0 ? action : action.slice(0, colon);
  const value = colon < 0 ? '' : action.slice(colon + 1);
  const d = workspace && lookup(workspace.devices, value);
  const r = lookup(archive, value);
  switch (name) {
    case 'close': dialog.close(); break;
    case 'tab': await leaveWizard(); if (value === 'Prüfarchiv') archiveDevice = ''; await show(value); break;
    case 'device': editDevice(d); break;
    case 'details': details(d); break;
    case 'history': archiveFilters = {}; archiveDevice = value; await show('Prüfarchiv'); break;
    case 'changes': {
      const entries = await call('deviceHistory', { device: value });
      modal('Stammdatenhistorie', ordered(entries, 'at').reverse().map(e => card(esc(e.at), `<p>${esc(e.actor)}</p><dl>${Object.entries(labels).filter(([key]) => e.previous?.[key] !== e.current[key]).map(([key, label]) => `<dt>${label}</dt><dd>${esc(e.previous?.[key] || '–')} → ${esc(e.current[key] || '–')}</dd>`).join('')}</dl>`)).join(''));
      break;
    }
    case 'location': editLocation(lookup(workspace.locations, value)); break;
    case 'membership': await editMembership(lookup(workspace.members, value)); break;
    case 'tenantEdit': editTenant(lookup(session.tenants, value)); break;
    case 'user': editUser(lookup(globalData.users, value)); break;
    case 'equipment': editEquipment(lookup(globalData.equipment, value)); break;
    case 'settings': edit('Systemeinstellungen', field('provider', 'Prüfdienstleister', globalData.settings.provider, 'text', 'required'), v => saveGlobal('saveSettings', v)); break;
    case 'export': downloadJson('geraetepruefung-' + tenant + '.json', await call('export')); break;
    case 'resetArchive': archiveDevice = ''; archiveFilters = {}; await show('Prüfarchiv'); break;
    case 'audit': {
      const log = await call('audit');
      modal('Letzte 50 Systemereignisse', rows(['Zeitpunkt', 'Aktion', 'Konto', 'Details'], log.map(e => [esc(e.at), esc(e.event), esc(e.actor), esc(JSON.stringify(e.detail))])));
      break;
    }
    case 'more': await loadArchive(); break;
    case 'report': reportDetails(r); break;
    case 'pdf': (await import('./pdf.js')).makePdf(r).save('Pruefprotokoll-' + r.id + '.pdf'); break;
    case 'preview': {
      if (activePdf) URL.revokeObjectURL(activePdf);
      activePdf = URL.createObjectURL((await import('./pdf.js')).makePdf(r).output('blob'));
      const frame = document.createElement('iframe'); frame.title = 'Prüfprotokoll als PDF'; frame.src = activePdf;
      $('preview').replaceChildren(frame);
      break;
    }
    case 'correct': edit('Berichtigung erfassen', area('reason', 'Grund', '') + area('note', 'Berichtigung', ''), async v => {
      await call('correction', { ...v, original: r.id, device: r.deviceId, requestId: crypto.randomUUID() });
      await show('Prüfarchiv');
    }); break;
    case 'wizard': await startWizard(d); break;
    case 'step': await leaveWizard(); wizard.step += Number(value); renderWizard(); view.querySelector('h2').scrollIntoView(); break;
    case 'saveDraft': await saveDraft(); break;
    case 'add':
    case 'remove': {
      capture();
      const visual = wizard.step === 1;
      const list = visual ? wizard.form.visual : wizard.form.stages[stages[wizard.step - 2]].points;
      if (name === 'add' && list.length < (visual ? 30 : 50)) list.push(visual ? {} : blankPoint());
      if (name === 'remove') list.splice(Number(value), 1);
      renderWizard();
      scheduleDraft();
      break;
    }
    case 'finish': {
      capture();
      if (!window.confirm('Fiktives Testprotokoll verbindlich archivieren?')) break;
      clearTimeout(draftTimer);
      await call('finish', draftInput(), 'Fiktive Prüfung archiviert');
      archiveDevice = wizard.device.id;
      await refreshWorkspace();
      await show('Prüfarchiv');
      break;
    }
  }
}
document.addEventListener('click', e => {
  const target = e.target.closest('[data-action]');
  if (!target) return;
  if (target.dataset.action === 'close') { dialog.close(); return; }
  run(async () => {
    target.disabled = true;
    try { await handle(target.dataset.action); } finally { target.disabled = false; }
  });
});
$('tenant').onchange = e => {
  const selected = e.target.value;
  run(async () => {
    try { await leaveWizard(); } catch (error) { $('tenant').value = tenant; throw error; }
    tenant = selected; archiveDevice = ''; archiveFilters = {};
    await refreshWorkspace(); await show(dashboardTab());
  });
};
view.addEventListener('change', e => {
  if (e.target.name === 'archive-device') $('archive-filters').requestSubmit();
});
window.addEventListener('beforeunload', e => { if (wizard?.dirty) { e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('offline', () => status('Offline · Änderungen sind erst nach bestätigter Speicherung synchronisiert.', true));
window.addEventListener('online', () => status('Verbindung wieder verfügbar. Speicherung erneut ausführen.'));
function clearSession() {
  clearTimeout(draftTimer);
  if (dialog.open) dialog.close();
  wizard = null; workspace = null; session = null; globalData = null; archive = []; archiveDevice = ''; archiveFilters = {}; tenant = '';
  view.replaceChildren(); $('navigation').replaceChildren(); $('workspace').hidden = true; $('logout').hidden = true; $('login').hidden = false;
}
async function start() {
  const local = ['localhost', '127.0.0.1'].includes(location.hostname) &&
    new URLSearchParams(location.search).get('emulator') === '1';
  const emulator = local ? await import('../firebase/test/browser-emulator.js') : null;
  const config = emulator ? await emulator.readEmulatorConfig() : await import('./firebase-config.js')
    .then(module => module.firebaseConfig)
    .catch(() => { throw Error('Firebase-Konfiguration konnte nicht geladen werden. Bitte js/firebase-config.js und ihren Inhalt prüfen.'); });
  if (!emulator && (
    config?.enabled !== true || config.firebase?.projectId !== 'hogasports' ||
    ![config.firebase.apiKey, config.firebase.authDomain, config.firebase.appId].every(value =>
      typeof value === 'string' && value.trim().length > 0
    ) || ![config.authTenants?.staff, config.authTenants?.customer].every(value =>
      typeof value === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(value)
    ) || config.authTenants.staff === config.authTenants.customer
  )) {
    throw Error('Online-Test noch nicht eingerichtet. Bitte Firebase und beide Auth-Mandanten in js/firebase-config.js eintragen und die Konfiguration aktivieren.');
  }
  const areas = config.authTenants;
  const client = await connectFirebase(config.firebase, emulator?.connectEmulators);
  ({ auth, callable } = client);
  const { signInWithEmailAndPassword, signOut, onAuthStateChanged } = client.authApi;
  $('logout').onclick = () => run(async () => { await leaveWizard(); await signOut(auth); });
  $('login-form').onsubmit = e => {
    e.preventDefault();
    run(async () => {
      const v = data(e.target);
      auth.tenantId = areas[v.area];
      status('Anmeldung läuft …');
      await signInWithEmailAndPassword(auth, v.email, v.password);
      e.target.elements.password.value = '';
    });
  };
  $('login-form').querySelector('button').disabled = false;
  onAuthStateChanged(auth, async user => {
    if (!user) { clearSession(); return; }
    try {
      if (![areas.staff, areas.customer].includes(user.tenantId)) throw Error('Anmeldebereich nicht zugelassen.');
      auth.tenantId = user.tenantId;
      await refreshSession();
      $('login').hidden = true; $('workspace').hidden = false; $('logout').hidden = false;
      await show(dashboardTab());
    } catch (e) {
      await signOut(auth);
      status(errorMessage(e), true);
    }
  });
}
start().catch(e => { status(errorMessage(e), true); $('login-form').querySelector('button').disabled = true; });
