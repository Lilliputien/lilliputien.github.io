/* ===== Hub de projets — app.js =====
   Aucune donnée personnelle dans ce fichier (repo public) :
   tout le contenu vient de Supabase, protégé par RLS (propriétaire uniquement). */

const SUPA_URL = 'https://jhkoamrjshnyucupnejm.supabase.co';
const SUPA_KEY = 'sb_publishable_RKw8L8_BVgNp3-0D49ITEQ_5mLMZ4PZ'; // clé publique, pas un secret

const CATS = {
  dev:     'Dev / Web',
  pro:     'Pro',
  immo:    'Immo / Admin',
  creatif: 'Créatif',
  perso:   'Perso',
};
const STATUS = { actif: 'Actif', bloque: 'Bloqué', pause: 'En pause', termine: 'Terminé' };
const SOON_DAYS = 14;

const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const show = (id, on = true) => $(id).classList.toggle('hidden', !on);

let sb = null;
let DATA = { projects: [], ideas: [], journal: [], recap: null, platforms: [], settings: {} };
let FILTER = 'all';
let EDITING = null;       // id du projet en cours d'édition, ou null pour un nouveau
let PROMOTING = null;     // id de l'idée en cours de promotion
let BOOTED = false;

/* ---------- utilitaires ---------- */
function withTimeout(p, ms, label) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label || 'timeout')), ms))]);
}
function daysUntil(d) {
  if (!d) return null;
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((new Date(d + 'T00:00:00') - t) / 86400000);
}
function ago(ts) {
  if (!ts) return '';
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  const d = Math.floor(s / 86400);
  if (d === 1) return 'hier';
  if (d < 30) return `il y a ${d} j`;
  return new Date(ts).toLocaleDateString('fr-BE', { day: 'numeric', month: 'short' });
}
function fmtDate(d) {
  return new Date(d + 'T00:00:00').toLocaleDateString('fr-BE', { day: 'numeric', month: 'short' });
}
function lastActivity(p) {
  const a = p.last_activity_at ? new Date(p.last_activity_at).getTime() : 0;
  const c = p.last_commit_at ? new Date(p.last_commit_at).getTime() : 0;
  return Math.max(a, c) || null;
}
function isStale(p) {
  if (p.status !== 'actif') return false;
  const la = lastActivity(p);
  const days = Number(DATA.settings.stale_days ?? 14);
  return !la || (Date.now() - la) / 86400000 > days;
}
function slugify(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'projet';
}
function safeUrl(u) {
  try { const x = new URL(u); return (x.protocol === 'https:' || x.protocol === 'http:') ? x.href : null; }
  catch { return null; }
}

/* ---------- thème ---------- */
function applyTheme(t) {
  if (t === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
}
function initTheme() {
  let t = null;
  try { t = localStorage.getItem('hub-theme'); } catch {}
  applyTheme(t);
}
function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  applyTheme(next);
  try { localStorage.setItem('hub-theme', next); } catch {}
}

/* ---------- authentification ---------- */
async function init() {
  initTheme();
  if (!window.supabase) { showLogin('Impossible de charger Supabase (réseau ?).'); return; }
  sb = window.supabase.createClient(SUPA_URL, SUPA_KEY, {
    auth: { storageKey: 'hub-auth', persistSession: true, autoRefreshToken: true },
  });
  sb.auth.onAuthStateChange((ev) => { if (ev === 'SIGNED_OUT') { BOOTED = false; showLogin(); } });
  try {
    const { data } = await withTimeout(sb.auth.getSession(), 8000, 'session-timeout');
    if (data.session) await boot(); else showLogin();
  } catch (e) {
    showLogin('Supabase ne répond pas. Le projet est peut-être en pause.');
  }
}
function showLogin(msg = '') {
  show('#splash', false); show('#app', false); show('#denied', false); show('#login', true);
  $('#loginMsg').textContent = msg;
}
async function doLogin(ev) {
  ev.preventDefault();
  const btn = $('#loginBtn');
  if (btn.disabled) return;
  btn.disabled = true; $('#loginMsg').textContent = '';
  try {
    const { error } = await withTimeout(
      sb.auth.signInWithPassword({ email: $('#email').value.trim(), password: $('#pass').value }),
      10000, 'login-timeout');
    if (error) throw error;
    $('#pass').value = '';
    await boot();
  } catch (e) {
    $('#loginMsg').textContent = e.message === 'login-timeout'
      ? 'Délai dépassé. Le projet Supabase est peut-être en pause.'
      : 'Connexion impossible : vérifie ton email et ton mot de passe.';
  } finally { btn.disabled = false; }
}
async function logout() { await sb.auth.signOut(); }

async function boot() {
  show('#login', false); show('#splash', true);
  try {
    const { data: ok, error } = await withTimeout(sb.rpc('is_hub_owner'), 8000, 'owner-timeout');
    if (error) throw error;
    if (!ok) { show('#splash', false); show('#denied', true); return; }
    await loadAll();
    BOOTED = true;
    show('#splash', false); show('#app', true);
    render();
  } catch (e) {
    showLogin('Erreur de chargement : ' + (e.message || e));
  }
}

/* ---------- données ---------- */
async function loadAll() {
  const q = (p) => p.then(r => { if (r.error) throw r.error; return r.data; });
  const [projects, ideas, journal, recaps, platforms, settings] = await withTimeout(Promise.all([
    q(sb.from('hub_projects').select('*').order('sort').order('name')),
    q(sb.from('hub_ideas').select('*').eq('status', 'nouvelle').order('created_at', { ascending: false })),
    q(sb.from('hub_journal').select('*').order('created_at', { ascending: false }).limit(30)),
    q(sb.from('hub_recaps').select('*').order('week_start', { ascending: false }).limit(1)),
    q(sb.from('hub_platforms').select('*').order('sort')),
    q(sb.from('hub_settings').select('*')),
  ]), 12000, 'load-timeout');
  DATA = {
    projects, ideas, journal, platforms,
    recap: recaps[0] || null,
    settings: Object.fromEntries(settings.map(s => [s.key, s.value])),
  };
}
async function refresh() { await loadAll(); render(); }

/* ---------- rendu ---------- */
function render() {
  renderKpis(); renderRecap(); renderNow(); renderFilters(); renderProjects();
  renderIdeas(); renderNoteSelect(); renderPlatforms(); renderJournal(); renderSync();
}

function renderKpis() {
  const P = DATA.projects;
  const active = P.filter(p => p.status === 'actif').length;
  const blocked = P.filter(p => p.status === 'bloque').length;
  const soon = P.filter(p => p.status !== 'termine' && (() => { const d = daysUntil(p.deadline); return d !== null && d <= SOON_DAYS; })()).length
    + P.filter(p => p.urgent && p.status !== 'termine' && !p.deadline).length;
  const limit = Number(DATA.settings.wip_limit ?? 3);
  $('#kpis').innerHTML = `
    <div class="kpi ${active > limit ? 'alert' : ''}"><b>${active}<small class="muted" style="font-size:14px"> / ${limit}</small></b><span>actifs</span></div>
    <div class="kpi ${blocked ? 'danger' : ''}"><b>${blocked}</b><span>bloqué${blocked > 1 ? 's' : ''}</span></div>
    <div class="kpi ${soon ? 'alert' : ''}"><b>${soon}</b><span>urgent / échéance</span></div>
    <div class="kpi"><b>${DATA.ideas.length}</b><span>idée${DATA.ideas.length > 1 ? 's' : ''} en attente</span></div>`;
  const warn = $('#wipWarn');
  if (active > limit) {
    warn.textContent = `${active} projets actifs pour une limite de ${limit}. Mets-en ${active - limit} en pause pour te concentrer.`;
    show('#wipWarn', true);
  } else show('#wipWarn', false);
}

function renderRecap() {
  const r = DATA.recap;
  if (r) {
    $('#recap').innerHTML = `<div class="label">Récap · semaine du ${esc(fmtDate(r.week_start))}</div><p>${esc(r.content)}</p>`;
  } else {
    const week = DATA.journal.filter(j => Date.now() - new Date(j.created_at) < 7 * 86400000).length;
    $('#recap').innerHTML = `<div class="label">Récap de la semaine</div><p>Le premier récap arrivera dimanche soir. ${week} entrée${week > 1 ? 's' : ''} au journal cette semaine.</p>`;
  }
}

function nowItems() {
  const items = [];
  for (const p of DATA.projects) {
    if (p.status === 'termine' || p.status === 'pause') continue;
    const d = daysUntil(p.deadline);
    let tag, cls, rank, text = p.next_step;
    if (d !== null && d < 0) { tag = 'EN RETARD'; cls = 'bloque'; rank = 0; }
    else if (p.urgent) { tag = d !== null ? `J-${d}` : 'URGENT'; cls = 'urgent'; rank = 1; }
    else if (d !== null && d <= SOON_DAYS) { tag = `J-${d}`; cls = 'urgent'; rank = 2; }
    else if (p.status === 'bloque') { tag = 'BLOQUÉ'; cls = 'bloque'; rank = 3; text = p.blocker || p.next_step; }
    else if (isStale(p)) { tag = 'OUBLIÉ ?'; cls = 'stale'; rank = 4; }
    else { tag = 'À FAIRE'; cls = 'actif'; rank = 5; }
    items.push({ p, tag, cls, rank, text, d: d ?? 999 });
  }
  return items.sort((a, b) => a.rank - b.rank || a.d - b.d || a.p.sort - b.p.sort).slice(0, 7);
}
function renderNow() {
  const items = nowItems();
  $('#now').innerHTML = items.length ? items.map(i => `
    <li data-edit="${esc(i.p.id)}">
      <span class="tag pill ${i.cls}">${esc(i.tag)}</span>
      <span><span class="proj">${esc(i.p.name)}</span> · ${esc(i.text || 'Prochaine étape à définir')}</span>
    </li>`).join('') : '<li class="empty">Rien d\'urgent. Profites-en.</li>';
}

function renderFilters() {
  const counts = {};
  DATA.projects.forEach(p => { if (p.status !== 'termine') counts[p.category] = (counts[p.category] || 0) + 1; });
  const chips = [`<button class="chip ${FILTER === 'all' ? 'on' : ''}" data-filter="all">Tous</button>`]
    .concat(Object.entries(CATS).filter(([k]) => counts[k]).map(([k, v]) =>
      `<button class="chip ${FILTER === k ? 'on' : ''}" data-filter="${k}" data-cat="${k}"><span class="dot"></span>${esc(v)} <span class="muted">${counts[k]}</span></button>`));
  $('#filters').innerHTML = chips.join('');
}

function cardHtml(p) {
  const d = daysUntil(p.deadline);
  const pills = [`<span class="pill ${p.status}">${STATUS[p.status]}</span>`];
  if (p.urgent && p.status !== 'termine') pills.unshift('<span class="pill urgent">Urgent</span>');
  else if (isStale(p)) pills.unshift('<span class="pill stale">Oublié ?</span>');
  const meta = [];
  if (p.deadline) meta.push(d < 0 ? `⚠ échéance dépassée (${fmtDate(p.deadline)})` : `échéance ${fmtDate(p.deadline)} · J-${d}`);
  if (p.last_commit_at) meta.push(`commit ${ago(p.last_commit_at)}`);
  meta.push(`maj ${ago(p.updated_at)}${p.updated_by === 'claude' ? ' par Claude' : p.updated_by === 'auto' ? ' (auto)' : ''}`);
  const links = (Array.isArray(p.links) ? p.links : []).map(l => {
    const u = safeUrl(l.url); return u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(l.label || new URL(u).hostname)}</a>` : '';
  }).join('');
  return `
    <article class="card ${p.status === 'termine' ? 'done' : ''}" data-cat="${esc(p.category)}" data-edit="${esc(p.id)}">
      <div class="row"><div><div class="t">${esc(p.name)}</div><div class="cat">${esc(CATS[p.category] || p.category)}</div></div><div class="pills">${pills.join('')}</div></div>
      ${p.next_step ? `<div class="next"><b>→</b> ${esc(p.next_step)}</div>` : ''}
      ${p.status === 'bloque' && p.blocker ? `<div class="blocker">⛔ ${esc(p.blocker)}</div>` : ''}
      ${links ? `<div class="links">${links}</div>` : ''}
      <div class="meta">${meta.map(esc).join('<span>·</span>')}</div>
    </article>`;
}
function renderProjects() {
  const P = DATA.projects.filter(p => FILTER === 'all' || p.category === FILTER);
  const groups = [
    ['Actifs', P.filter(p => p.status === 'actif').sort((a, b) => (b.urgent - a.urgent) || a.sort - b.sort)],
    ['Bloqués', P.filter(p => p.status === 'bloque')],
    ['En pause', P.filter(p => p.status === 'pause')],
  ];
  const done = P.filter(p => p.status === 'termine');
  let html = groups.filter(([, l]) => l.length).map(([t, l]) =>
    `<div class="group-title">${t} · ${l.length}</div><div class="cards">${l.map(cardHtml).join('')}</div>`).join('');
  if (done.length) html += `<details class="done-group"><summary class="group-title">▸ Terminés · ${done.length}</summary><div class="cards">${done.map(cardHtml).join('')}</div></details>`;
  $('#projects').innerHTML = html || '<p class="muted">Aucun projet dans cette catégorie.</p>';
}

function renderIdeas() {
  $('#ideaCount').textContent = DATA.ideas.length ? `${DATA.ideas.length}` : '';
  $('#ideas').innerHTML = DATA.ideas.map(i => `
    <li>
      <div class="it">${esc(i.title)}</div>
      ${i.note ? `<div class="in">${esc(i.note)}</div>` : ''}
      <div class="ia">
        <button class="link-btn" data-promote="${i.id}">→ en faire un projet</button>
        <button class="link-btn" data-drop="${i.id}">abandonner</button>
      </div>
    </li>`).join('') || '<li class="muted">Aucune idée en attente.</li>';
}

function renderNoteSelect() {
  const sel = $('#noteProject'); const cur = sel.value;
  sel.innerHTML = '<option value="">Général</option>' + DATA.projects
    .filter(p => p.status !== 'termine')
    .map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  sel.value = cur;
}

function renderPlatforms() {
  const groups = {};
  DATA.platforms.forEach(p => { (groups[p.category || 'Autres'] ||= []).push(p); });
  $('#platforms').innerHTML = Object.entries(groups).map(([g, list]) => `
    <div class="pf-group"><div class="label">${esc(g)}</div><div class="pf-links">
      ${list.map(p => { const u = safeUrl(p.url); return u ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(p.name)}</a>` : ''; }).join('')}
    </div></div>`).join('');
}

function renderJournal() {
  const names = Object.fromEntries(DATA.projects.map(p => [p.id, p.name]));
  const src = { claude: 'Claude', max: 'toi', auto: 'auto' };
  $('#journal').innerHTML = DATA.journal.map(j => `
    <li>
      <div class="jh">${esc(ago(j.created_at))} · ${esc(src[j.source] || j.source)}${j.project_id ? ` · <span class="jp">${esc(names[j.project_id] || j.project_id)}</span>` : ''}</div>
      <div>${esc(j.content)}</div>
      ${j.next_step ? `<div class="muted">→ ${esc(j.next_step)}</div>` : ''}
    </li>`).join('') || '<li class="muted">Journal vide.</li>';
}

function renderSync() {
  const ts = [...DATA.projects.map(p => p.updated_at), ...DATA.journal.map(j => j.created_at)].filter(Boolean).sort().pop();
  $('#syncInfo').textContent = ts ? `MAJ ${ago(ts)}` : '';
}

/* ---------- édition ---------- */
function openEditor(id, preset) {
  EDITING = id;
  const p = id ? DATA.projects.find(x => x.id === id) : { category: 'dev', status: 'actif', links: [], ...preset };
  const f = $('#editForm');
  $('#editTitle').textContent = id ? 'Modifier le projet' : 'Nouveau projet';
  f.name.value = p.name || '';
  f.category.value = p.category || 'dev';
  f.status.value = p.status || 'actif';
  f.deadline.value = p.deadline || '';
  f.urgent.checked = !!p.urgent;
  f.next_step.value = p.next_step || '';
  f.blocker.value = p.blocker || '';
  f.summary.value = p.summary || '';
  f.links.value = (p.links || []).map(l => `${l.label} | ${l.url}`).join('\n');
  f.repo.value = p.repo || '';
  $('#editMsg').textContent = '';
  $('#editor').showModal();
}
function closeEditor() { $('#editor').close(); EDITING = null; PROMOTING = null; }

function parseLinks(txt) {
  const out = [];
  for (const line of txt.split('\n').map(s => s.trim()).filter(Boolean)) {
    const parts = line.split('|').map(s => s.trim());
    const url = safeUrl(parts.length > 1 ? parts.slice(1).join('|') : parts[0]);
    if (!url) throw new Error(`Lien invalide : « ${line} »`);
    out.push({ label: parts.length > 1 ? parts[0] : new URL(url).hostname, url });
  }
  return out;
}

async function saveEditor(ev) {
  ev.preventDefault();
  const f = $('#editForm');
  let links;
  try { links = parseLinks(f.links.value); } catch (e) { $('#editMsg').textContent = e.message; return; }
  const row = {
    name: f.name.value.trim(),
    category: f.category.value,
    status: f.status.value,
    deadline: f.deadline.value || null,
    urgent: f.urgent.checked,
    next_step: f.next_step.value.trim() || null,
    blocker: f.blocker.value.trim() || null,
    summary: f.summary.value.trim() || null,
    links,
    repo: f.repo.value.trim() || null,
    updated_by: 'max',
    last_activity_at: new Date().toISOString(),
  };
  const before = EDITING ? DATA.projects.find(p => p.id === EDITING) : null;
  try {
    let id = EDITING;
    if (EDITING) {
      const { error } = await sb.from('hub_projects').update(row).eq('id', EDITING);
      if (error) throw error;
    } else {
      id = slugify(row.name);
      if (DATA.projects.some(p => p.id === id)) id += '-' + Date.now().toString(36).slice(-4);
      const { error } = await sb.from('hub_projects').insert({ id, ...row });
      if (error) throw error;
      if (PROMOTING) await sb.from('hub_ideas').update({ status: 'promue' }).eq('id', PROMOTING);
    }
    // une ligne de journal seulement si quelque chose d'important a changé
    const changes = [];
    if (!before) changes.push('Projet créé');
    else {
      if (before.status !== row.status) changes.push(`Statut : ${STATUS[before.status]} → ${STATUS[row.status]}`);
      if ((before.next_step || null) !== row.next_step && row.next_step) changes.push('Prochaine étape mise à jour');
      if ((before.blocker || null) !== row.blocker && row.blocker) changes.push(`Blocage : ${row.blocker}`);
    }
    if (changes.length) {
      await sb.from('hub_journal').insert({ project_id: id, source: 'max', content: changes.join(' · '), next_step: row.next_step });
    }
    closeEditor();
    await refresh();
  } catch (e) {
    $('#editMsg').textContent = 'Erreur : ' + (e.message || e);
  }
}

/* ---------- idées et notes ---------- */
async function addIdea(ev) {
  ev.preventDefault();
  const title = $('#ideaInput').value.trim();
  if (!title) return;
  const { error } = await sb.from('hub_ideas').insert({ title });
  if (error) { alertInline('#ideaInput', error.message); return; }
  $('#ideaInput').value = '';
  await refresh();
}
async function dropIdea(id) {
  await sb.from('hub_ideas').update({ status: 'abandonnee' }).eq('id', id);
  await refresh();
}
function promoteIdea(id) {
  const i = DATA.ideas.find(x => String(x.id) === String(id));
  if (!i) return;
  PROMOTING = i.id;
  openEditor(null, { name: i.title, summary: i.note || '', category: i.category || 'perso', status: 'actif' });
}
async function addNote(ev) {
  ev.preventDefault();
  const content = $('#noteText').value.trim();
  if (!content) return;
  const project_id = $('#noteProject').value || null;
  const { error } = await sb.from('hub_journal').insert({ project_id, source: 'max', content });
  if (error) { alertInline('#noteText', error.message); return; }
  if (project_id) await sb.from('hub_projects').update({ last_activity_at: new Date().toISOString() }).eq('id', project_id);
  $('#noteText').value = '';
  $('#journalBox').open = true;
  await refresh();
}
function alertInline(sel, msg) {
  const el = $(sel); el.setCustomValidity(msg); el.reportValidity(); setTimeout(() => el.setCustomValidity(''), 3000);
}

/* ---------- événements ---------- */
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-action]');
  if (a) {
    const act = a.dataset.action;
    if (act === 'logout') logout();
    else if (act === 'theme') toggleTheme();
    else if (act === 'new-project') { PROMOTING = null; openEditor(null); }
    else if (act === 'close-editor') closeEditor();
    return;
  }
  if (e.target.closest('a')) return; // liens des cartes : ne pas ouvrir l'éditeur
  const f = e.target.closest('[data-filter]');
  if (f) { FILTER = f.dataset.filter; renderFilters(); renderProjects(); return; }
  const pr = e.target.closest('[data-promote]');
  if (pr) { promoteIdea(pr.dataset.promote); return; }
  const dr = e.target.closest('[data-drop]');
  if (dr) { dropIdea(dr.dataset.drop); return; }
  const ed = e.target.closest('[data-edit]');
  if (ed) openEditor(ed.dataset.edit);
});
$('#loginForm').addEventListener('submit', doLogin);
$('#editForm').addEventListener('submit', saveEditor);
$('#editor').addEventListener('close', () => { EDITING = null; PROMOTING = null; });
$('#ideaForm').addEventListener('submit', addIdea);
$('#noteForm').addEventListener('submit', addNote);

// retour sur l'onglet : rafraîchir les données (le hub peut avoir été mis à jour par Claude)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && BOOTED) refresh().catch(() => {});
});

init();
