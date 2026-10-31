// ============================================================================
// Hub Feijó Souza — aba Comercial (CRM). Só administradores.
// ============================================================================
// Carregado depois do app.js. Usa as globais dele (sb, currentUser,
// currentProfile, escapeHtml, formatDateBR, toISODate, addDaysISO,
// parseMoneyBRL, formatMoneyBRL, studySafeFileName) e expõe só window.renderCrm.
// A trava de verdade é a RLS do banco (seção 26 do _db/schema.sql): mesmo que
// alguém abra esta tela, quem não é administrador não recebe nenhum dado.

(function () {
  "use strict";

  // --------------------------------------------------------------------------
  // Listas (vêm da aba "Listas" da planilha CRM_FSA)
  // --------------------------------------------------------------------------

  const STAGES = [
    { name: "Lead Gerado", bar: "bg-slate-400", chip: "bg-slate-100 text-slate-700", fill: "bg-slate-400" },
    { name: "Tentativa de Contato", bar: "bg-sky-400", chip: "bg-sky-100 text-sky-800", fill: "bg-sky-400" },
    { name: "Lead qualificado", bar: "bg-indigo-400", chip: "bg-indigo-100 text-indigo-800", fill: "bg-indigo-400" },
    { name: "Agendamento", bar: "bg-violet-400", chip: "bg-violet-100 text-violet-800", fill: "bg-violet-400" },
    { name: "Diagnóstico realizado", bar: "bg-amber-400", chip: "bg-amber-100 text-amber-800", fill: "bg-amber-400" },
    { name: "Proposta enviada", bar: "bg-orange-400", chip: "bg-orange-100 text-orange-800", fill: "bg-orange-400" },
    { name: "Contrato fechado", bar: "bg-emerald-500", chip: "bg-emerald-100 text-emerald-800", fill: "bg-emerald-500" },
    { name: "Atendimento recusado", bar: "bg-rose-400", chip: "bg-rose-100 text-rose-800", fill: "bg-rose-400" },
  ];
  const STAGE_NAMES = STAGES.map((s) => s.name);
  const STAGE_BY_NAME = Object.fromEntries(STAGES.map((s, i) => [s.name, { ...s, rank: i }]));
  const ST_CLOSED = "Contrato fechado";
  const ST_REFUSED = "Atendimento recusado";
  const ST_PROPOSAL = "Proposta enviada";
  const ST_QUALIFIED_RANK = STAGE_BY_NAME["Lead qualificado"].rank;
  const ST_SCHEDULED_RANK = STAGE_BY_NAME["Agendamento"].rank;
  const ST_DIAGNOSIS_RANK = STAGE_BY_NAME["Diagnóstico realizado"].rank;

  const SOURCES = ["Indicação", "Anúncio/Inbound", "Prospecção/Outbound", "Evento", "Site", "Parceiro"];
  const SECTORS = ["Tecnologia", "Serviços", "Comércio", "Indústria", "Saúde", "Educação", "Financeiro", "Outro"];
  const PRODUCTS = [
    "Licitações", "Contrato Administrativo", "Processo Administrativo", "Servidor Público", "Concurso",
    "Compliance e Governança", "Societário", "Tributário", "Contratual", "Contencioso", "Outro",
  ];
  const LOST_REASONS = ["Preço", "Já atendido por outro escritório", "Sem interesse", "Sem orçamento", "Sem retorno", "Outro"];
  const TRACKS = { urgente: "Urgente", consultivo: "Consultivo" };
  const FEE_TYPES = { pontual: "Pontual", mensal: "Mensal", exito: "Êxito", misto: "Misto" };
  const PROPOSAL_STATUS = {
    enviada: { label: "Enviada", cls: "bg-amber-100 text-amber-800" },
    aceita: { label: "Aceita", cls: "bg-emerald-100 text-emerald-800" },
    recusada: { label: "Recusada", cls: "bg-rose-100 text-rose-800" },
  };
  const SCRIPT_CATEGORIES = {
    abertura: "Mensagens de abertura",
    ligacao: "Ligação",
    transicao: "Transição para o diagnóstico",
    posvenda: "Pós-venda",
  };

  const FILE_MAX_BYTES = 20 * 1024 * 1024;
  const FILE_EXTENSIONS = ["pdf", "doc", "docx", "jpg", "jpeg", "png", "webp"];
  const DEFAULT_GOALS = { revenue_month: 170000, clients_month: 4, leads_week: 15, meetings_week: 4 };

  // --------------------------------------------------------------------------
  // Estado
  // --------------------------------------------------------------------------

  const crm = {
    wired: false,
    ready: false,
    token: 0,
    leads: [],
    proposals: [],
    admins: [],
    scripts: [],
    goals: { ...DEFAULT_GOALS },
    tab: "quadro",
    q: "",
    fOwner: "",
    fSource: "",
    fProduct: "",
    fFup: false,
    showRefused: true,
    sort: { key: "created_on", dir: "desc" },
    propStatus: "all",
    period: "month",
    editGoals: false,
    scriptContact: "",
    scriptMe: "",
    scriptEditing: null, // id, "new" ou null
    drawer: null, // { id|null, draft, notice, history, suggestion }
    flashTimer: null,
  };

  const $ = (id) => document.getElementById(id);
  const isAdmin = () => !!currentProfile?.is_admin;
  const todayIso = () => toISODate(new Date());

  // --------------------------------------------------------------------------
  // Utilidades
  // --------------------------------------------------------------------------

  function esc(v) {
    return escapeHtml(v);
  }

  function money(v) {
    return formatMoneyBRL(v);
  }

  function pct(n, d) {
    if (!d) return null;
    return (n / d) * 100;
  }

  function fmtPct(v) {
    return v == null ? "—" : `${Math.round(v)}%`;
  }

  function daysBetween(aIso, bIso) {
    const [ay, am, ad] = aIso.split("-").map(Number);
    const [by, bm, bd] = bIso.split("-").map(Number);
    return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
  }

  function initials(p) {
    const name = (p?.full_name || "").trim();
    if (name) {
      const parts = name.split(/\s+/);
      const first = parts[0][0] || "";
      const last = parts.length > 1 ? parts[parts.length - 1][0] : parts[0][1] || "";
      return (first + last).toUpperCase();
    }
    return String(p?.email || "?").slice(0, 2).toUpperCase();
  }

  function ownerOf(lead) {
    return crm.admins.find((a) => a.id === lead.owner_id) || null;
  }

  function ownerName(lead) {
    const o = ownerOf(lead);
    return o ? o.full_name || o.email || "" : "";
  }

  function isActive(lead) {
    return lead.stage !== ST_CLOSED && lead.stage !== ST_REFUSED;
  }

  function proposalsOf(leadId) {
    return crm.proposals
      .filter((p) => p.lead_id === leadId)
      .sort((a, b) => (a.sent_on < b.sent_on ? 1 : a.sent_on > b.sent_on ? -1 : b.id - a.id));
  }

  // Valor que aparece no cartão: valor fechado do lead; se não houver, o da
  // proposta (aceita, senão a mais recente).
  function leadAmount(lead) {
    if (lead.value != null) return { v: Number(lead.value), kind: lead.stage === ST_CLOSED ? "fechado" : "valor" };
    const ps = proposalsOf(lead.id);
    const pick = ps.find((p) => p.status === "aceita") || ps[0];
    return pick ? { v: Number(pick.value), kind: "proposto" } : null;
  }

  function fupState(lead) {
    if (!lead.follow_up_date || !isActive(lead)) return null;
    const diff = daysBetween(todayIso(), lead.follow_up_date);
    if (diff < 0) return { kind: "late", diff };
    if (diff === 0) return { kind: "today", diff };
    return { kind: "soon", diff };
  }

  function fupChip(lead) {
    const s = fupState(lead);
    if (!s) return "";
    const date = formatDateBR(lead.follow_up_date).slice(0, 5);
    if (s.kind === "late")
      return `<span class="rounded-full px-2 py-0.5 text-[11px] font-medium bg-rose-100 text-rose-700" title="Follow-up atrasado">FUP ${date} · atrasado</span>`;
    if (s.kind === "today")
      return `<span class="rounded-full px-2 py-0.5 text-[11px] font-medium bg-amber-100 text-amber-800" title="Follow-up para hoje">FUP hoje</span>`;
    return `<span class="rounded-full px-2 py-0.5 text-[11px] font-medium bg-slate-100 text-brand-slate">FUP ${date}</span>`;
  }

  function safeUrl(text) {
    const t = String(text || "").trim();
    return /^https?:\/\/[^\s<>"']+$/i.test(t) ? t : null;
  }

  // Telefone/e-mail/LinkedIn em várias linhas: só vira link o que é https:// ou e-mail.
  function contactInfoHtml(text) {
    return String(text || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const url = safeUrl(line);
        if (url) {
          const short = url.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "");
          return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" class="text-sky-700 underline break-all">${esc(short)}</a>`;
        }
        if (/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(line))
          return `<a href="mailto:${esc(line)}" class="text-sky-700 underline break-all">${esc(line)}</a>`;
        return `<span class="break-all">${esc(line)}</span>`;
      })
      .join("<br>");
  }

  function optionsHtml(list, current, blankLabel) {
    const items = current && !list.includes(current) ? [...list, current] : list;
    return (
      (blankLabel != null ? `<option value="">${esc(blankLabel)}</option>` : "") +
      items.map((v) => `<option value="${esc(v)}"${v === current ? " selected" : ""}>${esc(v)}</option>`).join("")
    );
  }

  function flash(text, kind = "ok") {
    const el = $("crm-flash");
    if (!el) return;
    el.textContent = text;
    el.className =
      "mb-3 rounded-lg px-3 py-2 text-sm " +
      (kind === "error" ? "bg-rose-50 text-rose-700 border border-rose-200" : "bg-emerald-50 text-emerald-800 border border-emerald-200");
    clearTimeout(crm.flashTimer);
    crm.flashTimer = setTimeout(() => el.classList.add("hidden"), kind === "error" ? 8000 : 3500);
  }

  async function fetchAll(makeQuery) {
    const PAGE = 1000;
    const out = [];
    for (let from = 0; from < 20000; from += PAGE) {
      const { data, error } = await makeQuery().range(from, from + PAGE - 1);
      if (error) throw error;
      const rows = data || [];
      out.push(...rows);
      if (rows.length < PAGE) break;
    }
    return out;
  }

  async function loadData() {
    const [leads, proposals, adminsRes, scriptsRes, goalsRes] = await Promise.all([
      fetchAll(() => sb.from("crm_leads").select("*").order("created_at", { ascending: false })),
      fetchAll(() => sb.from("crm_proposals").select("*").order("sent_on", { ascending: false })),
      sb.from("profiles").select("id, full_name, email").eq("is_admin", true).order("full_name"),
      sb.from("crm_scripts").select("*").order("sort_order", { ascending: true }).order("id", { ascending: true }),
      sb.from("crm_settings").select("value").eq("key", "goals").maybeSingle(),
    ]);
    crm.leads = leads;
    crm.proposals = proposals;
    crm.admins = adminsRes.data || [];
    crm.scripts = scriptsRes.data || [];
    crm.goals = { ...DEFAULT_GOALS, ...(goalsRes.data?.value || {}) };
  }

  // --------------------------------------------------------------------------
  // Filtros
  // --------------------------------------------------------------------------

  function filteredLeads() {
    const q = crm.q.trim().toLowerCase();
    return crm.leads.filter((l) => {
      if (crm.fOwner && l.owner_id !== crm.fOwner) return false;
      if (crm.fSource && l.source !== crm.fSource) return false;
      if (crm.fProduct && l.product !== crm.fProduct) return false;
      if (crm.fFup) {
        const s = fupState(l);
        if (!s || s.kind === "soon") return false;
      }
      if (q) {
        const hay = [l.company, l.contact_name, l.contact_info, l.city, l.notes, l.last_update, l.product, l.source, ownerName(l)]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  // --------------------------------------------------------------------------
  // Casca da tela
  // --------------------------------------------------------------------------

  const TABS = [
    ["quadro", "Quadro"],
    ["lista", "Lista"],
    ["propostas", "Propostas"],
    ["painel", "Painel"],
    ["scripts", "Scripts"],
  ];

  const INPUT = "border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white";

  function shellHtml() {
    return `
      <div class="flex flex-wrap items-center gap-2 mb-3">
        <h2 class="font-heading text-lg font-semibold text-brand-navy mr-auto">Comercial</h2>
        <button type="button" data-crm="refresh" class="text-sm text-brand-slate underline">Atualizar</button>
        <button type="button" data-crm="new-lead" class="btn-primary">Novo lead</button>
      </div>
      <p class="text-xs text-brand-slate mb-3">Visível somente para administradores. Os arquivos das propostas ficam em uma pasta privada.</p>
      <div id="crm-flash" class="hidden"></div>
      <div id="crm-fup-banner" class="hidden"></div>
      <div id="crm-tabs" class="flex flex-wrap gap-1 border-b border-slate-200 mb-4"></div>
      <div id="crm-filters" class="flex flex-wrap items-center gap-2 mb-4">
        <input id="crm-q" type="search" placeholder="Buscar empresa, contato, cidade..." class="${INPUT} w-full sm:w-64" />
        <select id="crm-f-owner" class="${INPUT}"></select>
        <select id="crm-f-source" class="${INPUT}"></select>
        <select id="crm-f-product" class="${INPUT}"></select>
        <label class="flex items-center gap-1.5 text-sm text-brand-slate"><input id="crm-f-fup" type="checkbox" /> Só FUP de hoje ou atrasado</label>
        <label id="crm-refused-wrap" class="flex items-center gap-1.5 text-sm text-brand-slate"><input id="crm-f-refused" type="checkbox" checked /> Mostrar recusados</label>
        <button type="button" data-crm="export-csv" class="text-sm text-brand-slate underline ml-auto">Exportar CSV</button>
      </div>
      <div id="crm-body"></div>
      <div id="crm-drawer"></div>`;
  }

  function renderTabs() {
    $("crm-tabs").innerHTML = TABS.map(
      ([key, label]) =>
        `<button type="button" data-crm="tab" data-tab="${key}" class="px-4 py-2 text-sm font-medium -mb-px border-b-2 ${
          crm.tab === key ? "border-brand-navy text-brand-navy" : "border-transparent text-brand-slate hover:text-brand-navy"
        }">${label}</button>`
    ).join("");
    const showFilters = ["quadro", "lista", "propostas"].includes(crm.tab);
    $("crm-filters").classList.toggle("hidden", !showFilters);
    $("crm-refused-wrap").classList.toggle("hidden", crm.tab !== "quadro");
    document.querySelector('[data-crm="export-csv"]').classList.toggle("hidden", crm.tab !== "lista");
    document.querySelector('[data-crm="new-lead"]').classList.toggle("hidden", crm.tab === "scripts");
  }

  function renderFilterOptions() {
    const sel = (id, html) => {
      const el = $(id);
      const keep = el.value;
      el.innerHTML = html;
      el.value = keep;
    };
    sel(
      "crm-f-owner",
      `<option value="">Todos os responsáveis</option>` +
        crm.admins.map((a) => `<option value="${esc(a.id)}">${esc(a.full_name || a.email)}</option>`).join("")
    );
    sel("crm-f-source", optionsHtml(SOURCES, "", "Todas as origens"));
    sel("crm-f-product", optionsHtml(PRODUCTS, "", "Todos os produtos"));
    $("crm-f-owner").value = crm.fOwner;
    $("crm-f-source").value = crm.fSource;
    $("crm-f-product").value = crm.fProduct;
  }

  function renderFupBanner() {
    const el = $("crm-fup-banner");
    const late = crm.leads.filter((l) => fupState(l)?.kind === "late").length;
    const today = crm.leads.filter((l) => fupState(l)?.kind === "today").length;
    if (!late && !today) {
      el.classList.add("hidden");
      return;
    }
    const parts = [];
    if (late) parts.push(`${late} atrasado${late > 1 ? "s" : ""}`);
    if (today) parts.push(`${today} para hoje`);
    el.className = "mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900";
    el.innerHTML = `<span>Follow-ups: <b>${parts.join(" e ")}</b>.</span>
      <button type="button" data-crm="show-fup" class="underline font-medium">${crm.fFup ? "Mostrar todos" : "Ver só esses"}</button>`;
  }

  function renderBody() {
    renderTabs();
    renderFupBanner();
    const el = $("crm-body");
    if (crm.tab === "quadro") el.innerHTML = boardHtml();
    else if (crm.tab === "lista") el.innerHTML = listHtml();
    else if (crm.tab === "propostas") el.innerHTML = proposalsViewHtml();
    else if (crm.tab === "painel") el.innerHTML = dashboardHtml();
    else el.innerHTML = scriptsHtml();
  }

  // --------------------------------------------------------------------------
  // Quadro (kanban)
  // --------------------------------------------------------------------------

  function cardHtml(l) {
    const owner = ownerOf(l);
    const amt = leadAmount(l);
    const props = proposalsOf(l.id);
    const chips = [];
    if (l.product) chips.push(`<span class="rounded-full px-2 py-0.5 text-[11px] bg-slate-100 text-brand-slate">${esc(l.product)}</span>`);
    if (l.track === "urgente") chips.push(`<span class="rounded-full px-2 py-0.5 text-[11px] font-medium bg-rose-50 text-rose-700">Urgente</span>`);
    const fup = fupChip(l);
    return `
      <div draggable="true" data-crm="open-lead" data-lead="${l.id}" class="crm-card rounded-xl border border-slate-200 bg-white p-3 shadow-sm hover:shadow cursor-pointer">
        <div class="flex items-start justify-between gap-2">
          <p class="font-medium text-sm text-brand-navy leading-snug break-words min-w-0">${esc(l.company)}</p>
          ${
            owner
              ? `<span class="shrink-0 w-6 h-6 rounded-full bg-brand-navy text-white text-[10px] font-semibold flex items-center justify-center" title="${esc(owner.full_name || owner.email)}">${esc(initials(owner))}</span>`
              : ""
          }
        </div>
        ${l.contact_name ? `<p class="text-xs text-brand-slate mt-0.5 truncate">${esc(l.contact_name)}</p>` : ""}
        ${chips.length ? `<div class="flex flex-wrap gap-1 mt-2">${chips.join("")}</div>` : ""}
        <div class="flex flex-wrap items-center gap-1.5 mt-2">
          ${fup}
          ${props.length ? `<span class="rounded-full px-2 py-0.5 text-[11px] bg-slate-100 text-brand-slate">${props.length} proposta${props.length > 1 ? "s" : ""}</span>` : ""}
          ${
            amt
              ? `<span class="ml-auto text-xs font-semibold ${amt.kind === "fechado" ? "text-emerald-700" : "text-brand-navy"}" title="${amt.kind === "proposto" ? "Valor da proposta" : amt.kind === "fechado" ? "Valor fechado" : "Valor"}">${money(amt.v)}</span>`
              : ""
          }
        </div>
      </div>`;
  }

  function boardHtml() {
    const leads = filteredLeads();
    const cols = STAGES.filter((s) => crm.showRefused || s.name !== ST_REFUSED);
    if (!crm.leads.length)
      return `<div class="card text-sm text-brand-slate">Nenhum lead cadastrado ainda. Clique em <b>Novo lead</b> para começar.</div>`;
    return `<div class="flex gap-3 overflow-x-auto pb-3 items-start" id="crm-board">${cols
      .map((s) => {
        const items = leads.filter((l) => l.stage === s.name);
        const total = items.reduce((sum, l) => sum + (leadAmount(l)?.v || 0), 0);
        return `
        <div class="crm-col w-[270px] shrink-0 rounded-xl bg-slate-50 border border-slate-200" data-stage="${esc(s.name)}">
          <div class="h-1.5 rounded-t-xl ${s.bar}"></div>
          <div class="px-3 pt-2 pb-1">
            <div class="flex items-center justify-between gap-2">
              <p class="text-sm font-semibold text-brand-navy leading-tight">${esc(s.name)}</p>
              <span class="text-xs rounded-full bg-white border border-slate-200 px-2 py-0.5 text-brand-slate">${items.length}</span>
            </div>
            <p class="text-[11px] text-brand-slate h-4">${total ? money(total) : ""}</p>
          </div>
          <div class="crm-drop flex flex-col gap-2 px-2 pb-2 min-h-[80px]">
            ${items.map(cardHtml).join("") || `<p class="text-xs text-brand-mist text-center py-4">Arraste um cartão para cá</p>`}
          </div>
        </div>`;
      })
      .join("")}</div>
      <p class="text-xs text-brand-slate mt-1">Dica: arraste os cartões entre as colunas para mudar a etapa; clique para abrir e editar.</p>`;
  }

  // --------------------------------------------------------------------------
  // Lista
  // --------------------------------------------------------------------------

  const LIST_COLS = [
    ["company", "Empresa"],
    ["stage", "Etapa"],
    ["product", "Produto"],
    ["source", "Origem"],
    ["owner", "Resp."],
    ["amount", "Valor"],
    ["follow_up_date", "FUP"],
    ["created_on", "Cadastro"],
  ];

  function sortValue(l, key) {
    if (key === "owner") return ownerName(l).toLowerCase();
    if (key === "amount") return leadAmount(l)?.v ?? -1;
    if (key === "stage") return STAGE_BY_NAME[l.stage]?.rank ?? 99;
    const v = l[key];
    return typeof v === "string" ? v.toLowerCase() : v ?? "";
  }

  function listHtml() {
    const dir = crm.sort.dir === "asc" ? 1 : -1;
    const rows = filteredLeads().sort((a, b) => {
      const x = sortValue(a, crm.sort.key);
      const y = sortValue(b, crm.sort.key);
      return x < y ? -dir : x > y ? dir : 0;
    });
    const head = LIST_COLS.map(
      ([key, label]) =>
        `<th class="text-left font-medium px-3 py-2 whitespace-nowrap"><button type="button" data-crm="sort" data-key="${key}" class="hover:text-brand-navy">${label}${
          crm.sort.key === key ? (crm.sort.dir === "asc" ? " ↑" : " ↓") : ""
        }</button></th>`
    ).join("");
    const body = rows
      .map((l) => {
        const st = STAGE_BY_NAME[l.stage];
        const amt = leadAmount(l);
        const owner = ownerOf(l);
        return `<tr data-crm="open-lead" data-lead="${l.id}" class="border-t border-slate-100 hover:bg-slate-50 cursor-pointer">
          <td class="px-3 py-2"><p class="font-medium text-brand-navy">${esc(l.company)}</p>${l.contact_name ? `<p class="text-xs text-brand-slate">${esc(l.contact_name)}</p>` : ""}</td>
          <td class="px-3 py-2 whitespace-nowrap"><span class="rounded-full px-2 py-0.5 text-xs ${st ? st.chip : ""}">${esc(l.stage)}</span></td>
          <td class="px-3 py-2">${esc(l.product || "—")}</td>
          <td class="px-3 py-2">${esc(l.source || "—")}</td>
          <td class="px-3 py-2">${owner ? esc(initials(owner)) : "—"}</td>
          <td class="px-3 py-2 whitespace-nowrap">${amt ? money(amt.v) : "—"}</td>
          <td class="px-3 py-2 whitespace-nowrap">${fupChip(l) || (l.follow_up_date ? formatDateBR(l.follow_up_date).slice(0, 5) : "—")}</td>
          <td class="px-3 py-2 whitespace-nowrap">${formatDateBR(l.created_on)}</td>
        </tr>`;
      })
      .join("");
    return `<div class="card !p-0 overflow-x-auto">
      <table class="w-full text-sm"><thead class="text-xs text-brand-slate bg-slate-50"><tr>${head}</tr></thead>
      <tbody>${body || `<tr><td colspan="8" class="px-3 py-6 text-center text-brand-slate">Nenhum lead encontrado.</td></tr>`}</tbody></table>
    </div>
    <p class="text-xs text-brand-slate mt-2">${rows.length} lead${rows.length === 1 ? "" : "s"}</p>`;
  }

  function csvCell(v) {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // evita que o Excel execute como fórmula
    return `"${s.replace(/"/g, '""')}"`;
  }

  function exportCsv() {
    const header = [
      "ID", "Empresa", "Contato", "Telefone/E-mail/LinkedIn", "Cidade", "Origem", "Setor", "Produto", "Trilha", "Etapa",
      "Data de cadastro", "Data da reunião", "Data de fechamento", "Valor (R$)", "Responsável", "Data para FUP",
      "Último andamento", "Motivo da recusa", "Observações",
    ];
    const lines = [header.map(csvCell).join(";")];
    filteredLeads().forEach((l) =>
      lines.push(
        [
          l.id, l.company, l.contact_name, l.contact_info, l.city, l.source, l.sector, l.product, TRACKS[l.track] || "",
          l.stage, l.created_on, l.meeting_date, l.closed_date, l.value, ownerName(l), l.follow_up_date,
          l.last_update, l.lost_reason, l.notes,
        ]
          .map(csvCell)
          .join(";")
      )
    );
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `leads-${todayIso()}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // --------------------------------------------------------------------------
  // Propostas (visão geral — "quanto cobramos")
  // --------------------------------------------------------------------------

  function avg(list) {
    return list.length ? list.reduce((s, n) => s + n, 0) / list.length : null;
  }

  function proposalsInView() {
    const leadsById = new Map(filteredLeads().map((l) => [l.id, l]));
    return crm.proposals
      .filter((p) => leadsById.has(p.lead_id) && (crm.propStatus === "all" || p.status === crm.propStatus))
      .map((p) => ({ p, lead: leadsById.get(p.lead_id) }));
  }

  function groupAvgTable(title, rows, keyFn, labelFn) {
    const groups = new Map();
    rows.forEach(({ p, lead }) => {
      const k = keyFn(p, lead) || "—";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(Number(p.value));
    });
    const body = [...groups.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(
        ([k, vals]) =>
          `<tr class="border-t border-slate-100"><td class="py-1.5 pr-3">${esc(labelFn(k))}</td><td class="py-1.5 pr-3 text-right">${vals.length}</td><td class="py-1.5 text-right font-medium">${money(avg(vals))}</td></tr>`
      )
      .join("");
    return `<div class="card">
      <p class="text-sm font-medium mb-2">${title}</p>
      <table class="w-full text-sm"><thead class="text-xs text-brand-slate"><tr><th class="text-left font-medium">Grupo</th><th class="text-right font-medium">Propostas</th><th class="text-right font-medium">Valor médio</th></tr></thead>
      <tbody>${body || `<tr><td colspan="3" class="py-3 text-brand-slate">Sem dados.</td></tr>`}</tbody></table></div>`;
  }

  function proposalsViewHtml() {
    const rows = proposalsInView();
    const values = rows.map(({ p }) => Number(p.value));
    const accepted = rows.filter(({ p }) => p.status === "aceita");
    const decided = rows.filter(({ p }) => p.status !== "enviada");
    const stat = (label, value, sub) =>
      `<div class="card"><p class="text-xs text-brand-slate">${label}</p><p class="text-xl font-semibold text-brand-navy mt-1">${value}</p>${sub ? `<p class="text-xs text-brand-slate mt-0.5">${sub}</p>` : ""}</div>`;
    const chips = [["all", "Todas"], ["enviada", "Enviadas"], ["aceita", "Aceitas"], ["recusada", "Recusadas"]]
      .map(
        ([k, label]) =>
          `<button type="button" data-crm="prop-status" data-status="${k}" class="rounded-full px-3 py-1 text-sm border ${
            crm.propStatus === k ? "bg-brand-navy text-white border-brand-navy" : "bg-white text-brand-slate border-slate-200"
          }">${label}</button>`
      )
      .join("");
    const table = rows
      .sort((a, b) => (a.p.sent_on < b.p.sent_on ? 1 : -1))
      .map(({ p, lead }) => {
        const stt = PROPOSAL_STATUS[p.status];
        return `<tr class="border-t border-slate-100 hover:bg-slate-50 cursor-pointer" data-crm="open-lead" data-lead="${lead.id}">
          <td class="px-3 py-2 font-medium text-brand-navy">${esc(lead.company)}</td>
          <td class="px-3 py-2">${esc(p.title)}${p.attachment_path ? ` <span class="text-xs text-brand-slate">(arquivo)</span>` : ""}</td>
          <td class="px-3 py-2">${esc(FEE_TYPES[p.fee_type] || "—")}</td>
          <td class="px-3 py-2 whitespace-nowrap font-medium">${money(p.value)}</td>
          <td class="px-3 py-2 whitespace-nowrap">${formatDateBR(p.sent_on)}</td>
          <td class="px-3 py-2"><span class="rounded-full px-2 py-0.5 text-xs ${stt.cls}">${stt.label}</span></td>
          <td class="px-3 py-2">${esc(lead.product || "—")}</td>
        </tr>`;
      })
      .join("");
    return `
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        ${stat("Propostas", rows.length)}
        ${stat("Valor médio", values.length ? money(avg(values)) : "—", values.length ? `Total proposto: ${money(values.reduce((s, n) => s + n, 0))}` : "")}
        ${stat("Taxa de aceite", decided.length ? fmtPct(pct(accepted.length, decided.length)) : "—", decided.length ? `${accepted.length} de ${decided.length} decididas` : "nenhuma decidida ainda")}
        ${stat("Valor médio aceito", accepted.length ? money(avg(accepted.map(({ p }) => Number(p.value)))) : "—", accepted.length ? `${accepted.length} aceita${accepted.length > 1 ? "s" : ""}` : "")}
      </div>
      <div class="flex flex-wrap gap-2 mb-3">${chips}</div>
      <div class="card !p-0 overflow-x-auto mb-4">
        <table class="w-full text-sm"><thead class="text-xs text-brand-slate bg-slate-50"><tr>
          <th class="text-left font-medium px-3 py-2">Lead</th><th class="text-left font-medium px-3 py-2">Proposta</th><th class="text-left font-medium px-3 py-2">Cobrança</th>
          <th class="text-left font-medium px-3 py-2">Valor</th><th class="text-left font-medium px-3 py-2">Enviada em</th><th class="text-left font-medium px-3 py-2">Situação</th><th class="text-left font-medium px-3 py-2">Produto</th>
        </tr></thead><tbody>${table || `<tr><td colspan="7" class="px-3 py-6 text-center text-brand-slate">Nenhuma proposta ainda. Abra um lead e anexe a proposta enviada.</td></tr>`}</tbody></table>
      </div>
      <div class="grid md:grid-cols-2 gap-3">
        ${groupAvgTable("Valor médio por produto", rows, (p, l) => l.product, (k) => k)}
        ${groupAvgTable("Valor médio por tipo de cobrança", rows, (p) => p.fee_type, (k) => FEE_TYPES[k] || "Não informado")}
      </div>
      <p class="text-xs text-brand-slate mt-2">Os valores são os da proposta, não são convertidos: propostas mensais e pontuais aparecem juntas, por isso vale olhar o tipo de cobrança.</p>`;
  }

  // --------------------------------------------------------------------------
  // Painel: metas, funil, origem/setor/produto e KPIs
  // --------------------------------------------------------------------------

  const PERIODS = [["week", "Semana"], ["month", "Mês"], ["quarter", "Trimestre"], ["year", "Ano"]];

  function periodBounds(period) {
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const y = now.getFullYear();
    const m = now.getMonth();
    let start;
    let end;
    if (period === "week") {
      start = getMondayOfWeek(now);
      end = new Date(start);
      end.setDate(start.getDate() + 6);
    } else if (period === "month") {
      start = new Date(y, m, 1);
      end = new Date(y, m + 1, 0);
    } else if (period === "quarter") {
      const qm = Math.floor(m / 3) * 3;
      start = new Date(y, qm, 1);
      end = new Date(y, qm + 3, 0);
    } else {
      start = new Date(y, 0, 1);
      end = new Date(y, 11, 31);
    }
    return [toISODate(start), toISODate(end)];
  }

  // Mesmas contas da aba Dashboard da planilha: faturamento e clientes são metas
  // mensais; leads e reuniões são metas semanais.
  function goalFor(kind, period) {
    const g = crm.goals;
    if (kind === "revenue" || kind === "clients") {
      const m = Number(kind === "revenue" ? g.revenue_month : g.clients_month) || 0;
      return { week: (m * 12) / 52, month: m, quarter: m * 3, year: m * 12 }[period];
    }
    const w = Number(kind === "leads" ? g.leads_week : g.meetings_week) || 0;
    return { week: w, month: (w * 52) / 12, quarter: w * 13, year: w * 52 }[period];
  }

  function actualFor(kind, period) {
    const [from, to] = periodBounds(period);
    const inRange = (iso) => iso && iso >= from && iso <= to;
    if (kind === "revenue")
      return crm.leads.filter((l) => l.stage === ST_CLOSED && l.value != null && inRange(l.closed_date)).reduce((s, l) => s + Number(l.value), 0);
    if (kind === "clients") return crm.leads.filter((l) => l.stage === ST_CLOSED && inRange(l.closed_date)).length;
    if (kind === "leads") return crm.leads.filter((l) => inRange(l.created_on)).length;
    return crm.leads.filter((l) => inRange(l.meeting_date)).length;
  }

  function numBR(n) {
    return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(".", ",");
  }

  function goalCardHtml(kind, label, period) {
    const goal = goalFor(kind, period);
    const actual = actualFor(kind, period);
    const ratio = goal > 0 ? actual / goal : null;
    const w = ratio == null ? 0 : Math.min(100, Math.round(ratio * 100));
    const color = ratio == null ? "bg-slate-300" : ratio >= 1 ? "bg-emerald-500" : ratio >= 0.5 ? "bg-amber-400" : "bg-rose-400";
    const show = (n) => (kind === "revenue" ? money(n) : numBR(n));
    return `<div class="card">
      <p class="text-xs text-brand-slate">${label}</p>
      <p class="text-xl font-semibold text-brand-navy mt-1">${show(actual)}</p>
      <p class="text-xs text-brand-slate">meta: ${goal ? show(goal) : "—"}</p>
      <div class="h-2 rounded-full bg-slate-100 mt-2 overflow-hidden"><div class="h-2 ${color}" style="width:${w}%"></div></div>
      <p class="text-xs text-brand-slate mt-1">${ratio == null ? "sem meta definida" : `${Math.round(ratio * 100)}% da meta`}</p>
    </div>`;
  }

  function goalsFormHtml() {
    const g = crm.goals;
    const field = (id, label, val) =>
      `<label class="text-xs text-brand-slate">${label}<input id="${id}" type="text" inputmode="decimal" value="${esc(String(val ?? "").replace(".", ","))}" class="${INPUT} w-full mt-1" /></label>`;
    return `<div class="card mb-4">
      <p class="text-sm font-medium mb-3">Metas</p>
      <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        ${field("crm-g-revenue", "Faturamento por mês (R$)", g.revenue_month)}
        ${field("crm-g-clients", "Novos clientes por mês", g.clients_month)}
        ${field("crm-g-leads", "Novos leads por semana", g.leads_week)}
        ${field("crm-g-meetings", "Novas reuniões por semana", g.meetings_week)}
      </div>
      <p id="crm-g-error" class="text-sm text-red-500 mt-2 hidden"></p>
      <div class="flex gap-2 mt-3">
        <button type="button" data-crm="save-goals" class="btn-primary">Salvar metas</button>
        <button type="button" data-crm="toggle-goals" class="text-sm text-brand-slate underline">Cancelar</button>
      </div>
    </div>`;
  }

  function barList(title, items, total) {
    const rows = items.filter((i) => i.n > 0).sort((a, b) => b.n - a.n);
    const max = rows.length ? rows[0].n : 1;
    return `<div class="card">
      <p class="text-sm font-medium mb-3">${title}</p>
      ${
        rows.length
          ? rows
              .map(
                (r) => `<div class="mb-2">
          <div class="flex justify-between text-xs mb-0.5"><span class="text-brand-navy">${esc(r.label)}</span>
            <span class="text-brand-slate">${r.n}${total ? ` (${Math.round((r.n / total) * 100)}%)` : ""}${r.closed ? ` · ${r.closed} fechado${r.closed > 1 ? "s" : ""}` : ""}</span></div>
          <div class="h-2 rounded-full bg-slate-100 overflow-hidden"><div class="h-2 ${r.fill || "bg-brand-navy"}" style="width:${Math.max(4, Math.round((r.n / max) * 100))}%"></div></div>
        </div>`
              )
              .join("")
          : `<p class="text-sm text-brand-slate">Sem dados.</p>`
      }
    </div>`;
  }

  function groupCount(keyFn) {
    const map = new Map();
    crm.leads.forEach((l) => {
      const k = keyFn(l) || "Não informado";
      const cur = map.get(k) || { label: k, n: 0, closed: 0 };
      cur.n += 1;
      if (l.stage === ST_CLOSED) cur.closed += 1;
      map.set(k, cur);
    });
    return [...map.values()];
  }

  // Definições (a planilha só tinha as metas; o "valor atual" é calculado aqui).
  const KPIS = [
    { label: "Tempo de 1ª Resposta", goal: "Até 5 minutos", alert: "Acima de 15 min = lead esfria", kind: "none" },
    { label: "Taxa de Resposta Inicial", goal: "Acima de 60%", alert: "Abaixo de 40% = revisar mensagem de abertura", kind: "none" },
    { label: "Taxa de Conexão (Ligação)", goal: "Acima de 35%", alert: "Abaixo de 15% = testar horários e abordagem", kind: "none" },
    { id: "qual", label: "Taxa de Leads Qualificados", goal: "Acima de 50%", alert: "Verificar qualidade da campanha e do anúncio", kind: "rate", min: 50, how: "Leads em “Lead qualificado” ou etapa seguinte, sobre o total de leads." },
    { id: "sched", label: "Taxa de Diagnósticos Agendados", goal: "Acima de 45%", alert: "Revisar perguntas de qualificação", kind: "rate", min: 45, how: "Leads com data de reunião, ou em “Agendamento” ou adiante, sobre os leads qualificados." },
    { id: "close", label: "Taxa de Fechamento pós-Diagnóstico", goal: "Acima de 30%", alert: "Revisar objeções e proposta", kind: "rate", min: 30, how: "Contratos fechados sobre os leads que chegaram ao diagnóstico ou receberam proposta." },
    { id: "urg", label: "Tempo Médio até Fechar (casos urgentes)", goal: "Até 48h", alert: "Acima disso = risco de perda de prazo legal", kind: "days", max: 2, alertAbove: 2, track: "urgente", how: "Da data de cadastro à de fechamento, nos leads com trilha Urgente." },
    { id: "cons", label: "Tempo Médio até Fechar (casos consultivos)", goal: "Até 10 dias", alert: "Acima de 15 dias = revisar régua de FUP", kind: "days", max: 10, alertAbove: 15, track: "consultivo", how: "Da data de cadastro à de fechamento, nos leads com trilha Consultivo." },
    { id: "ind", label: "Taxa de Indicação", goal: "Acima de 10%", alert: "Abaixo de 5% = não está sendo pedida", kind: "rate", min: 10, alertBelow: 5, how: "Leads com origem “Indicação” sobre o total de leads." },
  ];

  function computeKpi(k) {
    const L = crm.leads;
    const rank = (l) => STAGE_BY_NAME[l.stage]?.rank ?? -1;
    const live = (l) => l.stage !== ST_REFUSED;
    if (k.kind === "days") {
      const ds = L.filter((l) => l.stage === ST_CLOSED && l.track === k.track && l.closed_date && l.created_on).map((l) => daysBetween(l.created_on, l.closed_date));
      return ds.length ? { value: avg(ds), n: ds.length } : null;
    }
    let num = 0;
    let den = 0;
    if (k.id === "qual") {
      num = L.filter((l) => live(l) && rank(l) >= ST_QUALIFIED_RANK).length;
      den = L.length;
    } else if (k.id === "sched") {
      const sched = (l) => l.meeting_date || (live(l) && rank(l) >= ST_SCHEDULED_RANK);
      num = L.filter(sched).length;
      den = L.filter((l) => sched(l) || (live(l) && rank(l) >= ST_QUALIFIED_RANK)).length;
    } else if (k.id === "close") {
      const diagnosed = (l) => (live(l) && rank(l) >= ST_DIAGNOSIS_RANK) || (l.stage === ST_REFUSED && proposalsOf(l.id).length > 0);
      num = L.filter((l) => l.stage === ST_CLOSED).length;
      den = L.filter(diagnosed).length;
    } else if (k.id === "ind") {
      num = L.filter((l) => l.source === "Indicação").length;
      den = L.length;
    }
    return den ? { value: (num / den) * 100, n: num, den } : null;
  }

  function kpiStatus(k, r) {
    if (!r) return "na";
    if (k.kind === "rate") {
      if (r.value >= k.min) return "ok";
      return k.alertBelow != null && r.value < k.alertBelow ? "alert" : "warn";
    }
    if (r.value <= k.max) return "ok";
    return k.alertAbove != null && r.value > k.alertAbove ? "alert" : "warn";
  }

  const KPI_STYLE = {
    ok: "bg-emerald-100 text-emerald-800",
    warn: "bg-amber-100 text-amber-800",
    alert: "bg-rose-100 text-rose-800",
    na: "bg-slate-100 text-brand-slate",
  };

  function kpiTableHtml() {
    const rows = KPIS.map((k) => {
      const r = k.kind === "none" ? null : computeKpi(k);
      const st = kpiStatus(k, r);
      let val = "Não medido";
      if (k.kind !== "none") {
        if (!r) val = "Sem dados";
        else if (k.kind === "rate") val = `${fmtPct(r.value)} <span class="font-normal">(${r.n} de ${r.den})</span>`;
        else val = `${numBR(Math.round(r.value * 10) / 10)} dia${r.value >= 2 ? "s" : ""} <span class="font-normal">(${r.n} fechamento${r.n > 1 ? "s" : ""})</span>`;
      }
      return `<tr class="border-t border-slate-100 align-top">
        <td class="px-3 py-2"><p class="font-medium text-brand-navy">${esc(k.label)}</p>${k.how ? `<p class="text-xs text-brand-slate mt-0.5">${esc(k.how)}</p>` : ""}</td>
        <td class="px-3 py-2 whitespace-nowrap">${esc(k.goal)}</td>
        <td class="px-3 py-2 text-brand-slate">${esc(k.alert)}</td>
        <td class="px-3 py-2 whitespace-nowrap"><span class="rounded-full px-2 py-0.5 text-xs font-medium ${KPI_STYLE[st]}">${val}</span></td>
      </tr>`;
    }).join("");
    return `<div class="card !p-0 overflow-x-auto">
      <table class="w-full text-sm"><thead class="text-xs text-brand-slate bg-slate-50"><tr>
        <th class="text-left font-medium px-3 py-2">Indicador</th><th class="text-left font-medium px-3 py-2">Meta ideal</th><th class="text-left font-medium px-3 py-2">Alerta</th><th class="text-left font-medium px-3 py-2">Hoje</th>
      </tr></thead><tbody>${rows}</tbody></table></div>
      <p class="text-xs text-brand-slate mt-2">“Não medido”: tempo de 1ª resposta e as taxas de resposta e de conexão dependem de registrar o horário do primeiro contato e as tentativas, o que o Hub ainda não guarda.</p>`;
  }

  function dashboardHtml() {
    const L = crm.leads;
    const active = L.filter(isActive);
    const inProposal = L.filter((l) => l.stage === ST_PROPOSAL);
    const proposalValue = inProposal.reduce((s, l) => s + (leadAmount(l)?.v || 0), 0);
    const closed = L.filter((l) => l.stage === ST_CLOSED);
    const closedValue = closed.reduce((s, l) => s + (l.value != null ? Number(l.value) : 0), 0);
    const stat = (label, value, sub) =>
      `<div class="card"><p class="text-xs text-brand-slate">${label}</p><p class="text-xl font-semibold text-brand-navy mt-1">${value}</p>${sub ? `<p class="text-xs text-brand-slate mt-0.5">${sub}</p>` : ""}</div>`;

    const fups = L.filter((l) => {
      const s = fupState(l);
      return s && s.kind !== "soon";
    }).sort((a, b) => (a.follow_up_date < b.follow_up_date ? -1 : 1));
    const fupCard = `<div class="card mb-4">
      <p class="text-sm font-medium mb-2">Follow-ups de hoje e atrasados</p>
      ${
        fups.length
          ? fups
              .slice(0, 8)
              .map(
                (l) => `<button type="button" data-crm="open-lead" data-lead="${l.id}" class="w-full text-left flex items-center gap-2 py-1.5 border-t border-slate-100 first:border-0 hover:bg-slate-50">
              <span class="text-sm text-brand-navy font-medium min-w-0 truncate">${esc(l.company)}</span>
              <span class="text-xs text-brand-slate truncate hidden sm:inline">${esc(l.last_update || "")}</span>
              <span class="ml-auto shrink-0">${fupChip(l)}</span></button>`
              )
              .join("") + (fups.length > 8 ? `<p class="text-xs text-brand-slate mt-1">e mais ${fups.length - 8}</p>` : "")
          : `<p class="text-sm text-brand-slate">Nenhum follow-up pendente.</p>`
      }
    </div>`;

    const periodTabs = PERIODS.map(
      ([k, label]) =>
        `<button type="button" data-crm="period" data-period="${k}" class="rounded-full px-3 py-1 text-sm border ${
          crm.period === k ? "bg-brand-navy text-white border-brand-navy" : "bg-white text-brand-slate border-slate-200"
        }">${label}</button>`
    ).join("");
    const [pf, pt] = periodBounds(crm.period);

    const funnel = STAGES.map((s) => ({ label: s.name, n: L.filter((l) => l.stage === s.name).length, fill: s.fill }));

    return `
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        ${stat("Leads ativos", active.length, `${L.length} no total`)}
        ${stat("Em proposta", inProposal.length, inProposal.length ? `${money(proposalValue)} em aberto` : "")}
        ${stat("Contratos fechados", closed.length, closed.length ? `${money(closedValue)} fechados` : "")}
        ${stat("Conversão geral", L.length ? fmtPct(pct(closed.length, L.length)) : "—", "fechados sobre o total de leads")}
      </div>
      ${fupCard}
      <div class="flex flex-wrap items-center gap-2 mb-3">
        <p class="text-sm font-medium mr-2">Metas</p>${periodTabs}
        <span class="text-xs text-brand-slate">${formatDateBR(pf)} a ${formatDateBR(pt)}</span>
        <button type="button" data-crm="toggle-goals" class="text-sm text-brand-slate underline ml-auto">Editar metas</button>
      </div>
      ${crm.editGoals ? goalsFormHtml() : ""}
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        ${goalCardHtml("revenue", "Faturamento fechado", crm.period)}
        ${goalCardHtml("clients", "Novos clientes", crm.period)}
        ${goalCardHtml("leads", "Novos leads", crm.period)}
        ${goalCardHtml("meetings", "Novas reuniões", crm.period)}
      </div>
      <div class="grid md:grid-cols-2 gap-3 mb-4">
        ${barList("Leads por etapa", funnel, L.length)}
        ${barList("Leads por origem", groupCount((l) => l.source), L.length)}
        ${barList("Leads por setor", groupCount((l) => l.sector), L.length)}
        ${barList("Leads por produto", groupCount((l) => l.product), L.length)}
      </div>
      <p class="text-sm font-medium mb-2">Indicadores</p>
      ${kpiTableHtml()}`;
  }

  // --------------------------------------------------------------------------
  // Scripts
  // --------------------------------------------------------------------------

  function scriptFormHtml(s) {
    const isNew = s === "new";
    const cur = isNew ? { title: "", category: "abertura", body: "" } : s;
    return `<div class="card mb-3 border-brand-navy">
      <p class="text-sm font-medium mb-3">${isNew ? "Novo script" : "Editar script"}</p>
      <div class="grid sm:grid-cols-2 gap-3 mb-3">
        <input id="crm-s-title" type="text" maxlength="200" placeholder="Título" value="${esc(cur.title)}" class="${INPUT}" />
        <select id="crm-s-cat" class="${INPUT}">${Object.entries(SCRIPT_CATEGORIES)
          .map(([k, label]) => `<option value="${k}"${k === cur.category ? " selected" : ""}>${label}</option>`)
          .join("")}</select>
      </div>
      <textarea id="crm-s-body" rows="7" maxlength="5000" placeholder="Texto da mensagem. Use [Nome] e [Seu Nome] para preencher ao copiar." class="${INPUT} w-full">${esc(cur.body)}</textarea>
      <p id="crm-s-error" class="text-sm text-red-500 mt-2 hidden"></p>
      <div class="flex gap-2 mt-3">
        <button type="button" data-crm="save-script" class="btn-primary">Salvar</button>
        <button type="button" data-crm="cancel-script" class="text-sm text-brand-slate underline">Cancelar</button>
      </div>
    </div>`;
  }

  function scriptsHtml() {
    const sections = Object.entries(SCRIPT_CATEGORIES)
      .map(([cat, label]) => {
        const items = crm.scripts.filter((s) => s.category === cat);
        if (!items.length) return "";
        return `<h3 class="font-heading text-sm font-semibold text-brand-navy mt-5 mb-2">${label}</h3>
          <div class="grid md:grid-cols-2 gap-3">${items
            .map((s) =>
              crm.scriptEditing === s.id
                ? scriptFormHtml(s)
                : `<div class="card">
              <div class="flex items-center gap-2 mb-2">
                <p class="text-sm font-medium text-brand-navy mr-auto">${esc(s.title)}</p>
                <button type="button" data-crm="copy-script" data-script="${s.id}" class="text-xs rounded-lg border border-slate-200 px-2 py-1 hover:bg-slate-50">Copiar</button>
                <button type="button" data-crm="edit-script" data-script="${s.id}" class="text-xs text-brand-slate underline">Editar</button>
                <button type="button" data-crm="delete-script" data-script="${s.id}" class="text-xs text-red-500 underline">Excluir</button>
              </div>
              ${s.body ? `<p class="text-sm text-brand-charcoal whitespace-pre-wrap break-words">${esc(s.body)}</p>` : `<p class="text-sm text-brand-mist italic">Sem texto ainda. Clique em Editar para preencher.</p>`}
            </div>`
            )
            .join("")}</div>`;
      })
      .join("");
    return `
      <div class="card mb-3">
        <p class="text-sm font-medium mb-2">Preencher ao copiar</p>
        <div class="grid sm:grid-cols-2 gap-3">
          <input id="crm-script-contact" type="text" maxlength="80" placeholder="Nome do contato (troca [Nome])" value="${esc(crm.scriptContact)}" class="${INPUT}" />
          <input id="crm-script-me" type="text" maxlength="80" placeholder="Seu nome (troca [Seu Nome])" value="${esc(crm.scriptMe)}" class="${INPUT}" />
        </div>
        <div class="mt-3"><button type="button" data-crm="new-script" class="btn-primary">Novo script</button></div>
      </div>
      ${crm.scriptEditing === "new" ? scriptFormHtml("new") : ""}
      ${sections || `<div class="card text-sm text-brand-slate">Nenhum script cadastrado.</div>`}`;
  }

  // --------------------------------------------------------------------------
  // Gaveta do lead (cadastro/edição, propostas e histórico)
  // --------------------------------------------------------------------------

  function newDraft() {
    const me = crm.admins.find((a) => a.id === currentUser?.id);
    return {
      company: "", contact_name: "", contact_info: "", city: "", source: "", sector: "", product: "", track: "",
      stage: "Lead Gerado", owner_id: me ? me.id : "", created_on: todayIso(), meeting_date: "", follow_up_date: "",
      value: "", closed_date: "", lost_reason: "", last_update: "", notes: "",
    };
  }

  function draftFromLead(l) {
    const d = newDraft();
    Object.keys(d).forEach((k) => {
      const v = l[k];
      d[k] = v == null ? "" : k === "value" ? String(v).replace(".", ",") : v;
    });
    return d;
  }

  function openDrawer(id, notice) {
    const lead = id ? crm.leads.find((l) => l.id === id) : null;
    crm.drawer = {
      id: lead ? lead.id : null,
      draft: lead ? draftFromLead(lead) : newDraft(),
      notice: notice || "",
      suggestion: null,
      history: [],
      confirmDeleteLead: false,
      confirmDeleteProp: null,
    };
    renderDrawer();
    if (lead) loadHistory(lead.id);
  }

  function closeDrawer() {
    crm.drawer = null;
    $("crm-drawer").innerHTML = "";
  }

  async function loadHistory(leadId) {
    const { data } = await sb.from("crm_stage_log").select("*").eq("lead_id", leadId).order("changed_at", { ascending: false }).limit(50);
    if (crm.drawer && crm.drawer.id === leadId) {
      crm.drawer.history = data || [];
      const box = $("crm-d-history");
      if (box) box.innerHTML = historyHtml();
    }
  }

  function historyHtml() {
    const h = crm.drawer?.history || [];
    if (!h.length) return `<p class="text-sm text-brand-slate">Sem histórico ainda.</p>`;
    return h
      .map((r) => {
        const who = crm.admins.find((a) => a.id === r.changed_by);
        const when = new Date(r.changed_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
        return `<p class="text-sm py-1 border-t border-slate-100 first:border-0"><span class="text-brand-slate">${esc(when)}</span> · ${
          r.from_stage ? `${esc(r.from_stage)} → <b>${esc(r.to_stage)}</b>` : `Cadastrado em <b>${esc(r.to_stage)}</b>`
        }${who ? ` · ${esc(initials(who))}` : ""}</p>`;
      })
      .join("");
  }

  function captureDraft() {
    if (!crm.drawer || !$("crm-d-company")) return;
    const v = (id) => ($(id) ? $(id).value : "");
    const d = crm.drawer.draft;
    d.company = v("crm-d-company");
    d.contact_name = v("crm-d-contact");
    d.contact_info = v("crm-d-info");
    d.city = v("crm-d-city");
    d.source = v("crm-d-source");
    d.sector = v("crm-d-sector");
    d.product = v("crm-d-product");
    d.track = v("crm-d-track");
    d.stage = v("crm-d-stage");
    d.owner_id = v("crm-d-owner");
    d.created_on = v("crm-d-created");
    d.meeting_date = v("crm-d-meeting");
    d.follow_up_date = v("crm-d-fup");
    d.value = v("crm-d-value");
    d.closed_date = v("crm-d-closed");
    d.lost_reason = v("crm-d-lost");
    d.last_update = v("crm-d-last");
    d.notes = v("crm-d-notes");
  }

  function proposalRowHtml(p) {
    const stt = PROPOSAL_STATUS[p.status];
    const confirming = crm.drawer.confirmDeleteProp === p.id;
    return `<div class="rounded-lg border border-slate-200 p-3 mb-2">
      <div class="flex flex-wrap items-center gap-2">
        <p class="text-sm font-medium text-brand-navy mr-auto break-words min-w-0">${esc(p.title)}</p>
        <span class="text-sm font-semibold">${money(p.value)}</span>
      </div>
      <div class="flex flex-wrap items-center gap-2 mt-1 text-xs text-brand-slate">
        <span>${formatDateBR(p.sent_on)}</span>
        ${p.fee_type ? `<span class="rounded-full px-2 py-0.5 bg-slate-100">${esc(FEE_TYPES[p.fee_type])}</span>` : ""}
        <select data-crm-change="prop-status" data-prop="${p.id}" class="rounded-lg border border-slate-200 px-2 py-1 text-xs ${stt.cls}">${Object.entries(PROPOSAL_STATUS)
          .map(([k, s]) => `<option value="${k}"${k === p.status ? " selected" : ""}>${s.label}</option>`)
          .join("")}</select>
        ${p.attachment_path ? `<button type="button" data-crm="open-proposal-file" data-prop="${p.id}" class="underline text-sky-700">Abrir ${esc(p.attachment_name || "arquivo")}</button>` : `<span>sem arquivo</span>`}
        <button type="button" data-crm="delete-proposal" data-prop="${p.id}" class="ml-auto underline ${confirming ? "text-red-600 font-medium" : "text-red-500"}">${confirming ? "Confirmar exclusão" : "Excluir"}</button>
      </div>
      ${p.notes ? `<p class="text-xs text-brand-slate mt-1 whitespace-pre-wrap break-words">${esc(p.notes)}</p>` : ""}
    </div>`;
  }

  function drawerHtml() {
    const dr = crm.drawer;
    const d = dr.draft;
    const isNew = dr.id == null;
    const lead = isNew ? null : crm.leads.find((l) => l.id === dr.id);
    const fld = (label, inner, cls = "") => `<label class="block text-xs text-brand-slate ${cls}">${label}${inner}</label>`;
    const text = (id, val, ph = "", max = 200) =>
      `<input id="${id}" type="text" maxlength="${max}" value="${esc(val)}" placeholder="${esc(ph)}" class="${INPUT} w-full mt-1" />`;
    const date = (id, val) => `<input id="${id}" type="date" value="${esc(val)}" class="${INPUT} w-full mt-1" />`;
    const select = (id, inner) => `<select id="${id}" class="${INPUT} w-full mt-1">${inner}</select>`;
    const props = isNew ? [] : proposalsOf(dr.id);

    const proposalsBlock = isNew
      ? `<p class="text-sm text-brand-slate">Salve o lead para poder anexar as propostas enviadas.</p>`
      : `${props.map(proposalRowHtml).join("") || `<p class="text-sm text-brand-slate mb-2">Nenhuma proposta registrada.</p>`}
      <div class="rounded-lg bg-slate-50 border border-slate-200 p-3 mt-3">
        <p class="text-sm font-medium mb-2">Adicionar proposta enviada</p>
        <div class="grid sm:grid-cols-2 gap-3">
          ${fld("Título", text("crm-p-title", "Proposta", "Ex.: Assessoria em licitações"))}
          ${fld("Tipo de cobrança", select("crm-p-fee", `<option value="">Não informado</option>${Object.entries(FEE_TYPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}`))}
          ${fld("Valor (R$)", `<input id="crm-p-value" type="text" inputmode="decimal" maxlength="14" placeholder="Ex.: 4.500,00" class="${INPUT} w-full mt-1" />`)}
          ${fld("Enviada em", date("crm-p-date", todayIso()))}
          ${fld("Situação", select("crm-p-status", Object.entries(PROPOSAL_STATUS).map(([k, s]) => `<option value="${k}">${s.label}</option>`).join("")))}
          ${fld("Arquivo (PDF, Word ou imagem, até 20 MB)", `<input id="crm-p-file" type="file" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.webp" class="block text-sm mt-1" />`)}
        </div>
        ${fld("Observações (opcional)", `<textarea id="crm-p-notes" rows="2" maxlength="2000" class="${INPUT} w-full mt-1"></textarea>`, "mt-3")}
        <p id="crm-p-error" class="text-sm text-red-500 mt-2 hidden"></p>
        <button type="button" data-crm="add-proposal" id="crm-p-add" class="btn-primary mt-3">Adicionar proposta</button>
      </div>`;

    return `
    <div class="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="${isNew ? "Novo lead" : "Lead"}">
      <div class="absolute inset-0 bg-black/40" data-crm="close-drawer"></div>
      <div class="relative w-full sm:w-[640px] bg-white h-full overflow-y-auto shadow-xl">
        <div class="sticky top-0 z-10 bg-white border-b border-slate-200 px-5 py-3 flex items-center gap-3">
          <h3 class="font-heading text-base font-semibold text-brand-navy mr-auto truncate">${isNew ? "Novo lead" : esc(lead?.company || "Lead")}</h3>
          <button type="button" data-crm="close-drawer" class="text-sm text-brand-slate underline">Fechar</button>
        </div>
        <div class="p-5">
          ${dr.notice ? `<div class="mb-4 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900">${esc(dr.notice)}</div>` : ""}
          ${
            dr.suggestion
              ? `<div class="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 flex flex-wrap items-center gap-2">
                  <span class="mr-auto">${esc(dr.suggestion.text)}</span>
                  <button type="button" data-crm="apply-suggestion" class="rounded-lg bg-amber-600 text-white px-3 py-1 text-sm">${esc(dr.suggestion.label)}</button>
                  <button type="button" data-crm="dismiss-suggestion" class="text-sm underline">Agora não</button>
                </div>`
              : ""
          }
          <div class="grid sm:grid-cols-2 gap-3">
            ${fld("Nome / Empresa *", text("crm-d-company", d.company, "Nome da empresa"), "sm:col-span-2")}
            <p id="crm-d-dup" class="text-xs text-amber-700 sm:col-span-2 hidden"></p>
            ${fld("Contato", text("crm-d-contact", d.contact_name, "Nome e cargo"))}
            ${fld("Cidade", text("crm-d-city", d.city, "", 120))}
            ${fld("Telefone / E-mail / LinkedIn (um por linha)", `<textarea id="crm-d-info" rows="2" maxlength="1000" class="${INPUT} w-full mt-1">${esc(d.contact_info)}</textarea>`, "sm:col-span-2")}
            ${fld("Tipo de lead (origem)", select("crm-d-source", optionsHtml(SOURCES, d.source, "Não informado")))}
            ${fld("Setor", select("crm-d-sector", optionsHtml(SECTORS, d.sector, "Não informado")))}
            ${fld("Produto", select("crm-d-product", optionsHtml(PRODUCTS, d.product, "Não informado")))}
            ${fld("Trilha", select("crm-d-track", `<option value="">Não definida</option>${Object.entries(TRACKS).map(([k, v]) => `<option value="${k}"${k === d.track ? " selected" : ""}>${v}</option>`).join("")}`))}
            ${fld("Etapa", select("crm-d-stage", optionsHtml(STAGE_NAMES, d.stage)))}
            ${fld("Responsável", select("crm-d-owner", `<option value="">Sem responsável</option>${crm.admins.map((a) => `<option value="${esc(a.id)}"${a.id === d.owner_id ? " selected" : ""}>${esc(a.full_name || a.email)} (${esc(initials(a))})</option>`).join("")}`))}
            ${fld("Data de cadastro", date("crm-d-created", d.created_on))}
            ${fld("Data da reunião", date("crm-d-meeting", d.meeting_date))}
            <div>
              ${fld("Data para FUP", date("crm-d-fup", d.follow_up_date))}
              <div class="flex flex-wrap gap-1 mt-1">
                ${[1, 3, 7].map((n) => `<button type="button" data-crm="fup-add" data-days="${n}" class="rounded-full border border-slate-200 px-2 py-0.5 text-xs text-brand-slate hover:bg-slate-50">+${n} dia${n > 1 ? "s" : ""}</button>`).join("")}
                <button type="button" data-crm="fup-clear" class="rounded-full border border-slate-200 px-2 py-0.5 text-xs text-brand-slate hover:bg-slate-50">Limpar</button>
              </div>
            </div>
            ${fld("Valor fechado (R$)", text("crm-d-value", d.value, "Preencha ao fechar", 14))}
            ${fld("Data de fechamento", date("crm-d-closed", d.closed_date))}
            <div id="crm-d-lost-wrap" class="${d.stage === ST_REFUSED ? "" : "hidden"}">${fld("Motivo da recusa", select("crm-d-lost", optionsHtml(LOST_REASONS, d.lost_reason, "Não informado")))}</div>
            ${fld("Último andamento", text("crm-d-last", d.last_update, "", 1000), "sm:col-span-2")}
            ${fld("Observações", `<textarea id="crm-d-notes" rows="3" maxlength="5000" class="${INPUT} w-full mt-1">${esc(d.notes)}</textarea>`, "sm:col-span-2")}
          </div>
          <p id="crm-d-error" class="text-sm text-red-500 mt-3 hidden"></p>
          <div class="flex flex-wrap items-center gap-3 mt-4">
            <button type="button" data-crm="save-lead" id="crm-d-save" class="btn-primary">${isNew ? "Criar lead" : "Salvar"}</button>
            <button type="button" data-crm="close-drawer" class="text-sm text-brand-slate underline">Cancelar</button>
            ${
              isNew
                ? ""
                : `<button type="button" data-crm="delete-lead" class="ml-auto text-sm underline ${dr.confirmDeleteLead ? "text-red-600 font-medium" : "text-red-500"}">${dr.confirmDeleteLead ? "Confirmar: apagar lead e propostas" : "Excluir lead"}</button>`
            }
          </div>

          <h4 class="font-heading text-sm font-semibold text-brand-navy mt-8 mb-2">Propostas enviadas</h4>
          ${proposalsBlock}

          ${isNew ? "" : `<h4 class="font-heading text-sm font-semibold text-brand-navy mt-8 mb-2">Histórico de etapas</h4><div id="crm-d-history">${historyHtml()}</div>`}
        </div>
      </div>
    </div>`;
  }

  function renderDrawer() {
    $("crm-drawer").innerHTML = crm.drawer ? drawerHtml() : "";
  }

  function showDrawerError(id, msg) {
    const el = $(id);
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle("hidden", !msg);
  }

  // --------------------------------------------------------------------------
  // Gravações
  // --------------------------------------------------------------------------

  async function updateLead(id, patch) {
    const idx = crm.leads.findIndex((l) => l.id === id);
    const { data, error } = await sb.from("crm_leads").update(patch).eq("id", id).select().single();
    if (error) throw error;
    const row = data || { ...crm.leads[idx], ...patch };
    if (idx >= 0) crm.leads[idx] = row;
    return row;
  }

  async function moveLead(id, stage) {
    const lead = crm.leads.find((l) => l.id === id);
    if (!lead || lead.stage === stage) return;
    const prevStage = lead.stage;
    lead.stage = stage; // atualiza a tela na hora; volta se der erro
    renderBody();
    try {
      const row = await updateLead(id, { stage });
      renderBody();
      if (stage === ST_CLOSED && row.value == null)
        openDrawer(id, "Contrato fechado! Informe o valor fechado e anexe a proposta aceita.");
      else if (stage === ST_REFUSED && !row.lost_reason) openDrawer(id, "Atendimento recusado. Informe o motivo da recusa para entrar nas métricas.");
      else if (stage === ST_PROPOSAL && proposalsOf(id).length === 0)
        openDrawer(id, "Anexe a proposta enviada para registrarmos quanto foi cobrado.");
    } catch (e) {
      lead.stage = prevStage;
      renderBody();
      flash("Não foi possível mover o lead: " + (e.message || e), "error");
    }
  }

  function readLeadPayload() {
    const g = (id) => ($(id) ? $(id).value.trim() : "");
    const nul = (v) => (v === "" ? null : v);
    const company = g("crm-d-company");
    if (!company) return { error: "Informe o nome da empresa." };
    const valueText = g("crm-d-value");
    let value = null;
    if (valueText) {
      value = parseMoneyBRL(valueText);
      if (value === null) return { error: "Valor inválido. Exemplo: 4.500,00" };
    }
    const stage = g("crm-d-stage");
    const meeting = g("crm-d-meeting");
    const created = g("crm-d-created");
    const closed = g("crm-d-closed");
    if (!created) return { error: "Informe a data de cadastro." };
    if (closed && closed < created) return { error: "A data de fechamento não pode ser anterior à de cadastro." };
    return {
      payload: {
        company,
        contact_name: nul(g("crm-d-contact")),
        contact_info: nul(g("crm-d-info")),
        city: nul(g("crm-d-city")),
        source: nul(g("crm-d-source")),
        sector: nul(g("crm-d-sector")),
        product: nul(g("crm-d-product")),
        track: nul(g("crm-d-track")),
        stage,
        owner_id: nul(g("crm-d-owner")),
        created_on: created,
        meeting_date: nul(meeting),
        follow_up_date: nul(g("crm-d-fup")),
        value,
        closed_date: nul(closed),
        lost_reason: stage === ST_REFUSED ? nul(g("crm-d-lost")) : null,
        last_update: nul(g("crm-d-last")),
        notes: nul(g("crm-d-notes")),
      },
    };
  }

  async function saveLead() {
    showDrawerError("crm-d-error", "");
    const { payload, error } = readLeadPayload();
    if (error) return showDrawerError("crm-d-error", error);
    const btn = $("crm-d-save");
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Salvando...";
    try {
      if (crm.drawer.id == null) {
        const { data, error: err } = await sb.from("crm_leads").insert(payload).select().single();
        if (err) throw err;
        if (data) crm.leads.unshift(data);
        else await loadData();
        const created = data || crm.leads.find((l) => l.company === payload.company) || null;
        renderBody();
        flash("Lead criado.");
        if (created) openDrawer(created.id, "Lead criado. Agora você pode anexar as propostas enviadas.");
        else closeDrawer();
      } else {
        await updateLead(crm.drawer.id, payload);
        renderBody();
        flash("Lead salvo.");
        closeDrawer();
      }
    } catch (e) {
      showDrawerError("crm-d-error", "Não foi possível salvar: " + (e.message || e));
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  async function deleteLead() {
    const dr = crm.drawer;
    if (!dr || dr.id == null) return;
    if (!dr.confirmDeleteLead) {
      captureDraft();
      dr.confirmDeleteLead = true;
      renderDrawer();
      return;
    }
    const paths = proposalsOf(dr.id).map((p) => p.attachment_path).filter(Boolean);
    try {
      if (paths.length) await sb.storage.from("crm").remove(paths);
      const { error } = await sb.from("crm_leads").delete().eq("id", dr.id);
      if (error) throw error;
      crm.leads = crm.leads.filter((l) => l.id !== dr.id);
      crm.proposals = crm.proposals.filter((p) => p.lead_id !== dr.id);
      closeDrawer();
      renderBody();
      flash("Lead excluído.");
    } catch (e) {
      showDrawerError("crm-d-error", "Não foi possível excluir: " + (e.message || e));
    }
  }

  function suggestionFor(lead, p) {
    if (!lead) return null;
    const rank = STAGE_BY_NAME[lead.stage]?.rank ?? 0;
    if (p.status === "aceita" && lead.stage !== ST_CLOSED)
      return { text: `Proposta aceita. Marcar o lead como Contrato fechado com valor de ${money(p.value)}?`, label: "Marcar como fechado", patch: { stage: ST_CLOSED, value: Number(p.value) } };
    if (p.status === "recusada" && isActive(lead))
      return { text: "Proposta recusada. Marcar o lead como Atendimento recusado?", label: "Marcar como recusado", patch: { stage: ST_REFUSED } };
    if (p.status === "enviada" && isActive(lead) && rank < STAGE_BY_NAME[ST_PROPOSAL].rank)
      return { text: "Mover o lead para “Proposta enviada”?", label: "Mover", patch: { stage: ST_PROPOSAL } };
    return null;
  }

  async function applySuggestion() {
    const dr = crm.drawer;
    if (!dr?.suggestion) return;
    captureDraft();
    try {
      const row = await updateLead(dr.id, dr.suggestion.patch);
      dr.draft = draftFromLead(row);
      dr.suggestion = null;
      dr.notice = row.stage === ST_REFUSED ? "Lead atualizado. Informe o motivo da recusa." : "Lead atualizado.";
      renderDrawer();
      renderBody();
    } catch (e) {
      showDrawerError("crm-d-error", "Não foi possível atualizar: " + (e.message || e));
    }
  }

  function validFile(file) {
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    if (!FILE_EXTENSIONS.includes(ext)) return "Anexe um PDF, documento Word ou imagem (JPG, PNG ou WebP).";
    if (file.size > FILE_MAX_BYTES) return "Arquivo maior que 20 MB. Envie um arquivo menor.";
    return "";
  }

  async function addProposal() {
    const dr = crm.drawer;
    if (!dr || dr.id == null) return;
    showDrawerError("crm-p-error", "");
    const title = $("crm-p-title").value.trim();
    const value = parseMoneyBRL($("crm-p-value").value);
    const sentOn = $("crm-p-date").value;
    const file = $("crm-p-file").files[0];
    if (!title) return showDrawerError("crm-p-error", "Informe o título da proposta.");
    if (value === null) return showDrawerError("crm-p-error", "Informe o valor da proposta. Exemplo: 4.500,00");
    if (!sentOn) return showDrawerError("crm-p-error", "Informe a data de envio.");
    if (file) {
      const problem = validFile(file);
      if (problem) return showDrawerError("crm-p-error", problem);
    }
    const btn = $("crm-p-add");
    btn.disabled = true;
    btn.textContent = "Enviando...";
    let path = null;
    try {
      if (file) {
        path = `${dr.id}/${crypto.randomUUID()}-${studySafeFileName(file.name).slice(-100)}`;
        const { error: upErr } = await sb.storage.from("crm").upload(path, file);
        if (upErr) throw upErr;
      }
      const row = {
        lead_id: dr.id,
        title,
        fee_type: $("crm-p-fee").value || null,
        value,
        sent_on: sentOn,
        status: $("crm-p-status").value,
        notes: $("crm-p-notes").value.trim() || null,
        attachment_path: path,
        attachment_name: file ? file.name.slice(0, 255) : null,
      };
      const { data, error } = await sb.from("crm_proposals").insert(row).select().single();
      if (error) throw error;
      crm.proposals.unshift(data || { id: Date.now(), ...row });
      captureDraft();
      dr.suggestion = suggestionFor(crm.leads.find((l) => l.id === dr.id), data || row);
      dr.notice = "Proposta registrada.";
      renderDrawer();
      renderBody();
    } catch (e) {
      if (path) await sb.storage.from("crm").remove([path]);
      showDrawerError("crm-p-error", "Não foi possível salvar a proposta: " + (e.message || e));
      btn.disabled = false;
      btn.textContent = "Adicionar proposta";
    }
  }

  async function changeProposalStatus(propId, status) {
    const p = crm.proposals.find((x) => x.id === propId);
    if (!p || p.status === status) return;
    const { error } = await sb.from("crm_proposals").update({ status }).eq("id", propId);
    if (error) {
      flash("Não foi possível alterar a situação: " + error.message, "error");
      captureDraft();
      renderDrawer();
      return;
    }
    p.status = status;
    captureDraft();
    if (crm.drawer) {
      crm.drawer.suggestion = suggestionFor(crm.leads.find((l) => l.id === crm.drawer.id), p);
      renderDrawer();
    }
    renderBody();
  }

  async function deleteProposal(propId) {
    const dr = crm.drawer;
    const p = crm.proposals.find((x) => x.id === propId);
    if (!dr || !p) return;
    if (dr.confirmDeleteProp !== propId) {
      captureDraft();
      dr.confirmDeleteProp = propId;
      renderDrawer();
      return;
    }
    if (p.attachment_path) await sb.storage.from("crm").remove([p.attachment_path]);
    const { error } = await sb.from("crm_proposals").delete().eq("id", propId);
    if (error) return flash("Não foi possível excluir a proposta: " + error.message, "error");
    crm.proposals = crm.proposals.filter((x) => x.id !== propId);
    captureDraft();
    dr.confirmDeleteProp = null;
    renderDrawer();
    renderBody();
  }

  async function openProposalFile(propId) {
    const p = crm.proposals.find((x) => x.id === propId);
    if (!p?.attachment_path) return;
    // Abre a aba antes do await, para o navegador não bloquear o pop-up.
    const tab = window.open("", "_blank");
    if (tab) {
      try {
        tab.opener = null;
      } catch (e) {}
    }
    const { data, error } = await sb.storage.from("crm").createSignedUrl(p.attachment_path, 300);
    if (error || !data?.signedUrl) {
      if (tab) tab.close();
      flash("Não foi possível abrir o arquivo agora. Tente novamente.", "error");
      return;
    }
    if (tab) tab.location.href = data.signedUrl;
  }

  // --------------------------------------------------------------------------
  // Metas e scripts
  // --------------------------------------------------------------------------

  async function saveGoals() {
    const num = (id) => {
      const t = $(id).value.trim().replace(/\./g, "").replace(",", ".");
      if (t === "") return 0;
      const n = Number(t);
      return Number.isFinite(n) && n >= 0 && n < 1e9 ? n : null;
    };
    const value = {
      revenue_month: num("crm-g-revenue"),
      clients_month: num("crm-g-clients"),
      leads_week: num("crm-g-leads"),
      meetings_week: num("crm-g-meetings"),
    };
    if (Object.values(value).some((v) => v === null)) return showDrawerError("crm-g-error", "Use apenas números. Exemplo: 170000");
    const { error } = await sb.from("crm_settings").upsert({ key: "goals", value, updated_by: currentUser.id, updated_at: new Date().toISOString() });
    if (error) return showDrawerError("crm-g-error", "Não foi possível salvar as metas: " + error.message);
    crm.goals = { ...DEFAULT_GOALS, ...value };
    crm.editGoals = false;
    renderBody();
    flash("Metas salvas.");
  }

  async function copyScript(id, btn) {
    const s = crm.scripts.find((x) => x.id === id);
    if (!s) return;
    let text = s.body || "";
    if (crm.scriptMe.trim()) text = text.split("[Seu Nome]").join(crm.scriptMe.trim());
    if (crm.scriptContact.trim()) text = text.split("[Nome]").join(crm.scriptContact.trim());
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        ok = document.execCommand("copy");
      } catch (e2) {}
      ta.remove();
    }
    btn.textContent = ok ? "Copiado" : "Não copiou";
    setTimeout(() => {
      if (btn.isConnected) btn.textContent = "Copiar";
    }, 1500);
  }

  async function saveScript() {
    const title = $("crm-s-title").value.trim();
    const body = $("crm-s-body").value.trim();
    const category = $("crm-s-cat").value;
    if (!title) return showDrawerError("crm-s-error", "Informe o título do script.");
    try {
      if (crm.scriptEditing === "new") {
        const order = crm.scripts.reduce((m, s) => Math.max(m, s.sort_order || 0), 0) + 1;
        const { data, error } = await sb.from("crm_scripts").insert({ title, body, category, sort_order: order }).select().single();
        if (error) throw error;
        if (data) crm.scripts.push(data);
        else await loadData();
      } else {
        const { error } = await sb.from("crm_scripts").update({ title, body, category }).eq("id", crm.scriptEditing);
        if (error) throw error;
        const s = crm.scripts.find((x) => x.id === crm.scriptEditing);
        if (s) Object.assign(s, { title, body, category });
      }
      crm.scriptEditing = null;
      renderBody();
    } catch (e) {
      showDrawerError("crm-s-error", "Não foi possível salvar: " + (e.message || e));
    }
  }

  let scriptConfirm = null;
  async function deleteScript(id, btn) {
    if (scriptConfirm !== id) {
      scriptConfirm = id;
      btn.textContent = "Confirmar";
      setTimeout(() => {
        if (scriptConfirm === id) {
          scriptConfirm = null;
          if (btn.isConnected) btn.textContent = "Excluir";
        }
      }, 4000);
      return;
    }
    scriptConfirm = null;
    const { error } = await sb.from("crm_scripts").delete().eq("id", id);
    if (error) return flash("Não foi possível excluir o script: " + error.message, "error");
    crm.scripts = crm.scripts.filter((s) => s.id !== id);
    renderBody();
  }

  // --------------------------------------------------------------------------
  // Eventos (delegados no contêiner)
  // --------------------------------------------------------------------------

  function wire(root) {
    root.addEventListener("click", (e) => {
      const t = e.target.closest("[data-crm]");
      if (!t || !root.contains(t)) return;
      const act = t.dataset.crm;
      const leadId = t.dataset.lead ? Number(t.dataset.lead) : null;
      const propId = t.dataset.prop ? Number(t.dataset.prop) : null;
      const wrap = (p) => p.catch((err) => flash("Erro: " + (err.message || err), "error"));
      switch (act) {
        case "tab": crm.tab = t.dataset.tab; renderBody(); break;
        case "refresh": wrap(loadData().then(() => { renderFilterOptions(); renderBody(); flash("Dados atualizados."); })); break;
        case "new-lead": openDrawer(null); break;
        case "open-lead": openDrawer(leadId); break;
        case "close-drawer": closeDrawer(); break;
        case "save-lead": wrap(saveLead()); break;
        case "delete-lead": wrap(deleteLead()); break;
        case "show-fup": crm.fFup = !crm.fFup; $("crm-f-fup").checked = crm.fFup; renderBody(); break;
        case "sort":
          crm.sort = { key: t.dataset.key, dir: crm.sort.key === t.dataset.key && crm.sort.dir === "asc" ? "desc" : "asc" };
          renderBody();
          break;
        case "export-csv": exportCsv(); break;
        case "prop-status": crm.propStatus = t.dataset.status; renderBody(); break;
        case "period": crm.period = t.dataset.period; renderBody(); break;
        case "toggle-goals": crm.editGoals = !crm.editGoals; renderBody(); break;
        case "save-goals": wrap(saveGoals()); break;
        case "fup-add": $("crm-d-fup").value = addDaysISO(todayIso(), Number(t.dataset.days)); break;
        case "fup-clear": $("crm-d-fup").value = ""; break;
        case "add-proposal": wrap(addProposal()); break;
        case "delete-proposal": wrap(deleteProposal(propId)); break;
        case "open-proposal-file": wrap(openProposalFile(propId)); break;
        case "apply-suggestion": wrap(applySuggestion()); break;
        case "dismiss-suggestion": captureDraft(); crm.drawer.suggestion = null; renderDrawer(); break;
        case "copy-script": wrap(copyScript(Number(t.dataset.script), t)); break;
        case "new-script": crm.scriptEditing = "new"; renderBody(); break;
        case "edit-script": crm.scriptEditing = Number(t.dataset.script); renderBody(); break;
        case "cancel-script": crm.scriptEditing = null; renderBody(); break;
        case "save-script": wrap(saveScript()); break;
        case "delete-script": wrap(deleteScript(Number(t.dataset.script), t)); break;
        default: break;
      }
    });

    root.addEventListener("change", (e) => {
      const el = e.target;
      if (el.id === "crm-f-owner") { crm.fOwner = el.value; renderBody(); }
      else if (el.id === "crm-f-source") { crm.fSource = el.value; renderBody(); }
      else if (el.id === "crm-f-product") { crm.fProduct = el.value; renderBody(); }
      else if (el.id === "crm-f-fup") { crm.fFup = el.checked; renderBody(); }
      else if (el.id === "crm-f-refused") { crm.showRefused = el.checked; renderBody(); }
      else if (el.id === "crm-d-stage") {
        $("crm-d-lost-wrap").classList.toggle("hidden", el.value !== ST_REFUSED);
        if (el.value === ST_CLOSED && !$("crm-d-closed").value) $("crm-d-closed").value = todayIso();
      } else if (el.dataset.crmChange === "prop-status") {
        changeProposalStatus(Number(el.dataset.prop), el.value).catch((err) => flash("Erro: " + (err.message || err), "error"));
      }
    });

    root.addEventListener("input", (e) => {
      const el = e.target;
      if (el.id === "crm-q") { crm.q = el.value; renderBody(); }
      else if (el.id === "crm-script-contact") crm.scriptContact = el.value;
      else if (el.id === "crm-script-me") crm.scriptMe = el.value;
      else if (el.id === "crm-d-company" && crm.drawer && crm.drawer.id == null) {
        const name = el.value.trim().toLowerCase();
        const dup = name && crm.leads.find((l) => l.company.trim().toLowerCase() === name);
        const warn = $("crm-d-dup");
        warn.textContent = dup ? `Já existe um lead com este nome (${dup.stage}).` : "";
        warn.classList.toggle("hidden", !dup);
      }
    });

    // Arrastar e soltar os cartões entre as colunas do quadro.
    root.addEventListener("dragstart", (e) => {
      const card = e.target.closest && e.target.closest(".crm-card");
      if (!card) return;
      e.dataTransfer.setData("text/plain", card.dataset.lead);
      e.dataTransfer.effectAllowed = "move";
      card.classList.add("opacity-50");
    });
    root.addEventListener("dragend", () => {
      root.querySelectorAll(".crm-card").forEach((c) => c.classList.remove("opacity-50"));
      root.querySelectorAll(".crm-col").forEach((c) => c.classList.remove("ring-2", "ring-sky-300"));
    });
    root.addEventListener("dragover", (e) => {
      const col = e.target.closest && e.target.closest(".crm-col");
      if (!col) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      root.querySelectorAll(".crm-col").forEach((c) => c.classList.toggle("ring-2", c === col));
      col.classList.add("ring-sky-300");
    });
    root.addEventListener("drop", (e) => {
      const col = e.target.closest && e.target.closest(".crm-col");
      if (!col) return;
      e.preventDefault();
      const id = Number(e.dataTransfer.getData("text/plain"));
      root.querySelectorAll(".crm-col").forEach((c) => c.classList.remove("ring-2", "ring-sky-300"));
      if (id) moveLead(id, col.dataset.stage);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && crm.drawer) closeDrawer();
    });
  }

  // --------------------------------------------------------------------------
  // Entrada
  // --------------------------------------------------------------------------

  async function renderCrm() {
    const root = $("crm-root");
    if (!root) return;
    if (!isAdmin()) {
      root.innerHTML = `<div class="card text-sm text-brand-slate">Esta área é restrita a administradores.</div>`;
      return;
    }
    if (!crm.wired) {
      root.innerHTML = shellHtml();
      wire(root);
      crm.wired = true;
    }
    const token = ++crm.token;
    renderTabs();
    if (!crm.ready) $("crm-body").innerHTML = `<p class="text-sm text-brand-slate">Carregando…</p>`;
    try {
      await loadData();
    } catch (e) {
      if (token === crm.token) {
        $("crm-body").innerHTML = "";
        flash("Não foi possível carregar o Comercial: " + (e.message || e), "error");
      }
      return;
    }
    if (token !== crm.token) return;
    crm.ready = true;
    renderFilterOptions();
    renderBody();
  }

  // O botão da home só é criado para administradores (para os demais ele nem existe na página).
  function setupCrmTile() {
    if (!isAdmin() || $("tile-comercial")) return;
    const ref = document.querySelector('.tile[data-goto="pedidos"]');
    if (!ref || !ref.parentNode) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = "tile-comercial";
    btn.className = "tile";
    // Sem data-goto de propósito: o botão pode ser criado depois de o app ligar os cliques da navegação.
    btn.addEventListener("click", () => goToPanel("comercial"));
    btn.innerHTML = `
      <span class="tile-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 20h18"/><rect x="5" y="11" width="3.5" height="7" rx="0.6"/><rect x="10.25" y="7" width="3.5" height="11" rx="0.6"/><rect x="15.5" y="4" width="3.5" height="14" rx="0.6"/></svg>
      </span>
      <span class="tile-title">Comercial</span>
      <span class="tile-desc">Leads, propostas e metas (administradores)</span>`;
    ref.after(btn);
  }

  window.setupCrmTile = setupCrmTile;
  window.renderCrm = renderCrm;
  // Se o app já carregou o perfil antes deste arquivo terminar de carregar, cria o botão agora;
  // no caso contrário, é o app.js que chama setupCrmTile() assim que o perfil chega.
  try {
    if (typeof currentProfile !== "undefined" && currentProfile) setupCrmTile();
  } catch (e) {}
})();
