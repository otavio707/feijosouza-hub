// ============================================================================
// Hub Feijó Souza — aba Financeiro. Só administradores.
// ============================================================================
// Carregado depois do app.js. Usa as globais dele (sb, currentProfile,
// escapeHtml, toISODate) e expõe window.renderFinance e window.setupFinanceTile.
// A trava de verdade é a RLS do banco (seção 34 do _db/schema.sql): mesmo que
// alguém abra esta tela, quem não é administrador não recebe nenhum dado.
// Os valores financeiros ficam só no banco; nada financeiro é gravado neste arquivo.

(function () {
  "use strict";

  const MONTHS = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
  const MONTHS_SHORT = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
  const SCENARIOS = [
    ["estabilidade", "Estabilidade", "#64748b"],
    ["crescimento", "Crescimento", "#0ea5e9"],
    ["meta_bonus", "Meta de bônus", "#10b981"],
  ];
  const CLIENT_CLASSES = {
    recorrente_fixo: "Recorrente fixo",
    recorrente: "Recorrente",
    extraordinario: "Extraordinário",
    novo: "Novo",
  };
  // Política de Bônus (26/06/2025): a parte financeira vale 40% e depende da meta atingida no semestre.
  // Abaixo de 60% da meta é o gatilho: não há bônus. O valor guardado já é 0,4 × a faixa.
  const FIN_TIERS = [
    [0, "Abaixo de 60% da meta (gatilho não atingido: sem bônus)"],
    [0.24, "De 60% a 70% da meta (vale 60% dos 40%)"],
    [0.28, "De 70% a 80% da meta (vale 70% dos 40%)"],
    [0.32, "De 80% a 90% da meta (vale 80% dos 40%)"],
    [0.36, "De 90% a 100% da meta (vale 90% dos 40%)"],
    [0.4, "100% da meta (vale 100% dos 40%)"],
  ];
  const finTierOf = (v) => FIN_TIERS.find(([t]) => Math.abs(t - Number(v)) < 1e-9);
  const CRITERIA = [
    ["conduta_individual", "Conduta individual"],
    ["conduta_coletiva", "Conduta coletiva"],
    ["entregas", "Entregas"],
    ["prazos", "Prazos"],
    ["proatividade", "Proatividade"],
    ["produtividade", "Produtividade"],
  ];
  const TABS = [
    ["mes", "Mês"],
    ["tipo", "Despesas por tipo"],
    ["resultados", "Resultados do ano"],
    ["metas", "Planejamento e metas"],
    ["distrib", "Distribuições e reservas"],
    ["bonus", "Bônus da equipe"],
  ];
  const INPUT = "border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white";
  const COUNTED_NOTE = "Fora da soma da planilha original";

  // --------------------------------------------------------------------------
  // Estado
  // --------------------------------------------------------------------------

  const now = new Date();
  const fin = {
    wired: false,
    ready: false,
    token: 0,
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    tab: "mes",
    kind: "executed", // despesas por tipo: executed | planned
    bonusPeriod: null,
    cats: [],
    revenues: [],
    expenses: [],
    months: [],
    dists: [],
    reserves: [],
    yearGoal: null,
    proj: [],
    bonus: [],
    settings: { tax_rate: 0.12, partner_share: 0.5, partners: ["Otávio", "Feijó"] },
    modal: null, // { kind, id, error }
    flashTimer: null,
  };

  const $ = (id) => document.getElementById(id);
  const isAdmin = () => !!currentProfile?.is_admin;
  const esc = (v) => escapeHtml(v == null ? "" : String(v));

  // --------------------------------------------------------------------------
  // Utilidades (dinheiro aceita zero, negativos e valores grandes)
  // --------------------------------------------------------------------------

  const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const nf = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  const money = (v) => (v == null || Number.isNaN(Number(v)) ? "—" : nf.format(Number(v)));
  const moneyIn = (v) => (v == null ? "" : String(r2(v)).replace(".", ","));
  const pctFmt = (v) => (v == null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(1).replace(".", ",")}%`);

  // Converte "1.234,56", "1234,56", "1234.56", "-50", "" em número (ou null se vazio, NaN se inválido).
  function parseMoney(text) {
    let s = String(text == null ? "" : text).replace(/R\$|\s/g, "");
    if (s === "") return null;
    if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".");
    else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
    if (!/^-?\d+(\.\d+)?$/.test(s)) return NaN;
    const n = Number(s);
    return Number.isFinite(n) && Math.abs(n) < 1e9 ? r2(n) : NaN;
  }

  const monthIso = (year, m) => `${year}-${String(m).padStart(2, "0")}-01`;
  const monthOf = (iso) => Number(String(iso).slice(5, 7));
  const sum = (arr, f) => r2(arr.reduce((a, x) => a + (Number(f(x)) || 0), 0));
  const todayIso = () => toISODate(new Date());

  function flash(text, kind = "ok") {
    const el = $("fin-flash");
    if (!el) return;
    el.textContent = text;
    el.className =
      "mb-3 rounded-lg px-3 py-2 text-sm sticky top-2 z-40 shadow " +
      (kind === "error" ? "bg-rose-50 text-rose-700 border border-rose-200" : "bg-emerald-50 text-emerald-800 border border-emerald-200");
    clearTimeout(fin.flashTimer);
    fin.flashTimer = setTimeout(() => el.classList.add("hidden"), kind === "error" ? 8000 : 3500);
  }

  function flashUndo(text) {
    const el = $("fin-flash");
    if (!el) return;
    el.innerHTML = `${esc(text)} <button type="button" data-fin="undo" class="underline ml-2 font-medium">Desfazer</button>`;
    el.className = "mb-3 rounded-lg px-3 py-2 text-sm sticky top-2 z-40 shadow bg-emerald-50 text-emerald-800 border border-emerald-200";
    clearTimeout(fin.flashTimer);
    fin.flashTimer = setTimeout(() => { el.classList.add("hidden"); fin.undo = null; }, 10000);
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

  // --------------------------------------------------------------------------
  // Carga de dados (ano escolhido)
  // --------------------------------------------------------------------------

  async function loadData() {
    const y = fin.year;
    const from = monthIso(y, 1);
    const to = monthIso(y + 1, 1);
    const [cats, revenues, expenses, months, dists, reserves, goals, proj, bonus, settings] = await Promise.all([
      fetchAll(() => sb.from("fin_categories").select("*").order("sort_order").order("name")),
      fetchAll(() => sb.from("fin_revenues").select("*").gte("month", from).lt("month", to).order("month").order("id")),
      fetchAll(() => sb.from("fin_expenses").select("*").gte("month", from).lt("month", to).order("month").order("id")),
      fetchAll(() => sb.from("fin_months").select("*").gte("month", from).lt("month", to).order("month")),
      fetchAll(() => sb.from("fin_distributions").select("*").gte("month", from).lt("month", to).order("month").order("id")),
      fetchAll(() => sb.from("fin_reserves").select("*").gte("month", from).lt("month", to).order("month").order("id")),
      sb.from("fin_year_goals").select("*").eq("year", y).maybeSingle(),
      fetchAll(() => sb.from("fin_projections").select("*").eq("year", y).order("month_num")),
      fetchAll(() => sb.from("fin_bonus").select("*").order("id")),
      fetchAll(() => sb.from("fin_settings").select("*")),
    ]);
    if (goals.error) throw goals.error;
    fin.cats = cats;
    fin.revenues = revenues;
    fin.expenses = expenses;
    fin.months = months;
    fin.dists = dists;
    fin.reserves = reserves;
    fin.yearGoal = goals.data || null;
    fin.proj = proj;
    fin.bonus = bonus;
    for (const s of settings) {
      if (s.key in fin.settings) fin.settings[s.key] = s.value;
    }
    const periods = bonusPeriods();
    if (!fin.bonusPeriod || !periods.includes(fin.bonusPeriod)) fin.bonusPeriod = periods[periods.length - 1] || null;
  }

  // --------------------------------------------------------------------------
  // Cálculos
  // --------------------------------------------------------------------------

  const catById = (id) => fin.cats.find((c) => c.id === id);
  const monthRow = (m) => fin.months.find((r) => monthOf(r.month) === m) || null;

  // Números de um mês. Linhas com counted=false ficam fora dos totais (como na planilha original).
  function calcMonth(m) {
    const revs = fin.revenues.filter((r) => monthOf(r.month) === m);
    const exps = fin.expenses.filter((e) => monthOf(e.month) === m);
    const row = monthRow(m);
    const rate = Number(fin.settings.tax_rate) || 0;
    const billed = sum(revs.filter((r) => r.counted), (r) => r.billed);
    const received = sum(revs.filter((r) => r.counted), (r) => r.received);
    const planned = sum(exps.filter((e) => e.counted), (e) => e.planned);
    const executed = sum(exps.filter((e) => e.counted), (e) => e.executed);
    const taxPlanned = row?.tax_planned_override != null ? Number(row.tax_planned_override) : r2(billed * rate);
    const taxEst = row?.tax_received_override != null ? Number(row.tax_received_override) : r2(received * rate);
    const taxPaid = row?.tax_paid != null ? Number(row.tax_paid) : null;
    const taxUsed = taxPaid != null ? taxPaid : taxEst;
    const profitPlanned = r2(billed - taxPlanned - planned);
    const profit = r2(received - taxUsed - executed);
    const distributed = sum(fin.dists.filter((d) => monthOf(d.month) === m), (d) => d.amount);
    return {
      m, revs, exps, row, billed, received, planned, executed, taxPlanned, taxEst, taxPaid, taxUsed,
      taxIsEstimate: taxPaid == null, profitPlanned, profit, distributed,
      goal: row?.revenue_goal != null ? Number(row.revenue_goal) : null,
      hasData: revs.length > 0 || exps.length > 0 || row != null,
    };
  }

  const allMonths = () => Array.from({ length: 12 }, (_, i) => calcMonth(i + 1));

  function sumCalc(list) {
    const k = ["billed", "received", "planned", "executed", "taxPlanned", "taxUsed", "profitPlanned", "profit", "distributed"];
    const out = {};
    for (const key of k) out[key] = sum(list, (x) => x[key]);
    out.estimatedMonths = list.filter((x) => x.hasData && x.taxIsEstimate && x.received > 0).length;
    return out;
  }

  function expensesByCategory(kind) {
    // devolve [{cat, perMonth[12], total}]
    const rows = fin.cats.map((c) => ({ cat: c, perMonth: Array(12).fill(0), total: 0 }));
    const idx = new Map(rows.map((r) => [r.cat.id, r]));
    for (const e of fin.expenses) {
      if (!e.counted) continue;
      const r = idx.get(e.category_id);
      if (!r) continue;
      const v = Number(e[kind]) || 0;
      r.perMonth[monthOf(e.month) - 1] += v;
      r.total += v;
    }
    for (const r of rows) {
      r.perMonth = r.perMonth.map(r2);
      r.total = r2(r.total);
    }
    return rows;
  }

  // Bônus: individual = soma das 6 notas (0–10) / 60 × 0,6; multiplicador = individual + parte financeira.
  function calcBonus(b) {
    const scores = b.scores || {};
    const vals = CRITERIA.map(([k]) => scores[k]).filter((v) => v != null && v !== "");
    const complete = vals.length === CRITERIA.length;
    const finPart = Number(b.financial_part);
    const individual = complete ? (vals.reduce((a, v) => a + Number(v), 0) / 60) * 0.6 : null;
    const trigger = finPart > 0; // 0 = escritório abaixo de 60% da meta
    let mult = b.multiplier != null ? Number(b.multiplier) : null;
    if (individual != null) mult = individual + finPart;
    if (!trigger) mult = 0;
    const base = b.base != null ? Number(b.base) : null;
    let value = null;
    if (b.amount_override != null) value = Number(b.amount_override);
    else if (base != null && mult != null) value = r2(base * Number(b.max_multiple) * mult);
    return { complete, individual, mult, value, base, trigger, finPart, fromOverride: b.amount_override != null };
  }

  const bonusPeriods = () => [...new Set(fin.bonus.map((b) => b.period))];

  function distributionsByPartner() {
    const map = new Map();
    for (const d of fin.dists) map.set(d.partner, r2((map.get(d.partner) || 0) + Number(d.amount)));
    return map;
  }

  // --------------------------------------------------------------------------
  // Peças visuais
  // --------------------------------------------------------------------------

  const TH = "px-2 py-1.5 text-xs font-medium text-brand-slate text-left whitespace-nowrap";
  const THR = "px-2 py-1.5 text-xs font-medium text-brand-slate text-right whitespace-nowrap";
  const TD = "px-2 py-1.5 align-top";
  const TDR = "px-2 py-1.5 text-right tabular-nums whitespace-nowrap align-top";
  const BTN = "text-xs text-brand-slate underline hover:text-brand-navy";

  const signCls = (v) => (v == null ? "" : Number(v) < 0 ? "text-rose-600" : "");

  function card(label, value, sub = "", cls = "") {
    return `<div class="rounded-xl border border-slate-200 bg-white p-3">
      <p class="text-xs text-brand-slate">${label}</p>
      <p class="font-heading text-lg font-semibold text-brand-navy tabular-nums ${cls}">${value}</p>
      ${sub ? `<p class="text-xs text-brand-slate mt-0.5">${sub}</p>` : ""}
    </div>`;
  }

  function section(title, actionsHtml, inner) {
    return `<div class="card mb-4">
      <div class="flex flex-wrap items-center gap-2 mb-2">
        <h3 class="font-heading text-base font-semibold text-brand-navy mr-auto">${title}</h3>${actionsHtml || ""}
      </div>${inner}</div>`;
  }

  const tableWrap = (inner) => `<div class="overflow-x-auto"><table class="w-full text-sm">${inner}</table></div>`;
  const emptyMsg = (t) => `<p class="text-sm text-brand-slate">${t}</p>`;
  const notCountedBadge = `<span class="ml-1 rounded bg-amber-100 text-amber-800 text-[10px] px-1.5 py-0.5 whitespace-nowrap" title="Este valor aparece na lista, mas não está somado nos totais do mês (a planilha antiga também não somava). Clique em editar e marque “Somar nos totais do mês” para incluí-lo.">não entra na soma</span>`;

  // Estados das caixinhas: 0 = não, 1 = parcial, 2 = sim.
  const recvState = (r) => { const b = Number(r.billed) || 0, v = Number(r.received) || 0; return v <= 0 ? 0 : v >= b ? 2 : 1; };
  const paidState = (e) => { const p = Number(e.planned) || 0, x = Number(e.executed) || 0; return x === 0 ? 0 : Math.abs(x) >= Math.abs(p) ? 2 : 1; };
  const chk = (act, id, state, label, partialTitle) =>
    `<input type="checkbox" data-fin="${act}" data-id="${id}" ${state === 2 ? "checked" : ""} ${state === 1 ? 'data-indet="1"' : ""} aria-label="${esc(label)}" title="${esc(state === 1 ? partialTitle : label)}" class="w-4 h-4 cursor-pointer" />`;
  const TDC = "px-2 py-1.5 text-center align-top";
  const THC = "px-2 py-1.5 text-xs font-medium text-brand-slate text-center whitespace-nowrap";

  // --------------------------------------------------------------------------
  // Casca, abas e seletor de período
  // --------------------------------------------------------------------------

  function shellHtml() {
    return `
      <div class="flex flex-wrap items-center gap-2 mb-3">
        <h2 class="font-heading text-lg font-semibold text-brand-navy mr-auto">Financeiro</h2>
        <label class="text-sm text-brand-slate flex items-center gap-1.5">Ano
          <select id="fin-year" class="${INPUT}"></select></label>
        <button type="button" data-fin="refresh" class="text-sm text-brand-slate underline">Atualizar</button>
      </div>
      <p class="text-xs text-brand-slate mb-3">Visível e editável somente por administradores. Todas as alterações ficam registradas.</p>
      <div id="fin-flash" class="hidden"></div>
      <div id="fin-tabs" class="flex flex-wrap gap-1 border-b border-slate-200 mb-4"></div>
      <div id="fin-body"></div>
      <div id="fin-modal"></div>`;
  }

  function renderYearOptions() {
    const cy = new Date().getFullYear();
    const years = [...new Set([cy - 1, cy, cy + 1, fin.year])].sort();
    $("fin-year").innerHTML = years.map((y) => `<option value="${y}" ${y === fin.year ? "selected" : ""}>${y}</option>`).join("");
  }

  function renderTabs() {
    $("fin-tabs").innerHTML = TABS.map(
      ([key, label]) =>
        `<button type="button" data-fin="tab" data-tab="${key}" class="px-4 py-2 text-sm font-medium -mb-px border-b-2 ${
          fin.tab === key ? "border-brand-navy text-brand-navy" : "border-transparent text-brand-slate hover:text-brand-navy"
        }">${label}</button>`
    ).join("");
  }

  function renderBody() {
    const el = $("fin-body");
    if (!el) return;
    const views = { mes: viewMonth, tipo: viewByType, resultados: viewResults, metas: viewGoals, distrib: viewDistrib, bonus: viewBonus };
    el.innerHTML = (views[fin.tab] || viewMonth)();
    el.querySelectorAll("[data-indet]").forEach((i) => (i.indeterminate = true));
  }

  function renderModalHost() {
    const host = $("fin-modal");
    if (host) host.innerHTML = fin.modal ? modalHtml() : "";
  }

  // --------------------------------------------------------------------------
  // Aba Mês
  // --------------------------------------------------------------------------

  function viewMonth() {
    const c = calcMonth(fin.month);
    const share = Number(fin.settings.partner_share) || 0.5;
    const partners = fin.settings.partners || [];
    const picker = `<div class="flex flex-wrap items-center gap-2 mb-4">
      <button type="button" data-fin="month-prev" class="${INPUT}" aria-label="Mês anterior">‹</button>
      <select id="fin-month" class="${INPUT}">${MONTHS.map((n, i) => `<option value="${i + 1}" ${i + 1 === fin.month ? "selected" : ""}>${n} de ${fin.year}</option>`).join("")}</select>
      <button type="button" data-fin="month-next" class="${INPUT}" aria-label="Próximo mês">›</button>
      <span class="ml-auto flex flex-wrap items-center gap-4"><button type="button" data-fin="edit-taxrate" class="text-sm text-brand-slate underline">Percentual do imposto (${pctFmt(Number(fin.settings.tax_rate))})</button>
      <button type="button" data-fin="edit-month" class="text-sm text-brand-slate underline">Ajustar meta, imposto e observação do mês</button></span>
    </div>`;

    const missing = c.goal != null ? r2(c.goal - c.received) : null;
    const taxLabel = c.taxIsEstimate ? "Imposto (estimado)" : "Imposto (pago)";
    const cards = `<div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
      ${card("Faturado", money(c.billed), `Imposto previsto ${money(c.taxPlanned)}`)}
      ${card("Recebido", money(c.received), c.billed ? `${pctFmt(c.received / c.billed)} do faturado` : "")}
      ${card("Meta de receita do mês", c.goal != null ? money(c.goal) : "—", missing != null ? (missing > 0 ? `Faltam ${money(missing)}` : `Meta superada em ${money(-missing)}`) : "Defina em “Ajustar o mês”")}
      ${card(taxLabel, money(c.taxUsed), c.taxIsEstimate ? `${pctFmt(Number(fin.settings.tax_rate))} do recebido` : `Estimado: ${money(c.taxEst)}`)}
      ${card("Despesas planejadas", money(c.planned))}
      ${card("Despesas executadas", money(c.executed), c.planned ? `${money(r2(c.executed - c.planned))} vs planejado` : "")}
      ${card("Lucro projetado", money(c.profitPlanned), "faturado − imposto − planejado", signCls(c.profitPlanned))}
      ${card("Lucro realizado", money(c.profit), "recebido − imposto − executado", signCls(c.profit))}
    </div>
    <p class="text-sm text-brand-slate mb-4">Divisão do lucro realizado: ${partners.map((p) => `${esc(p)} <strong class="text-brand-navy tabular-nums ${signCls(c.profit)}">${money(r2(c.profit * share))}</strong>`).join(" · ")} · distribuído no mês: <strong class="text-brand-navy tabular-nums">${money(c.distributed)}</strong>${c.row?.note ? `<br><span class="text-xs">Observação do mês: ${esc(c.row.note)}</span>` : ""}</p>`;

    // Receitas
    const revRows = c.revs
      .map(
        (r) => `<tr class="border-t border-slate-100 ${r.counted ? "" : "text-brand-slate bg-slate-50"}">
        <td class="${TD}">${esc(r.client)}${r.counted ? "" : notCountedBadge}${r.note ? `<div class="text-xs text-brand-slate">${esc(r.note)}</div>` : ""}</td>
        <td class="${TDR}">${money(r.billed)}</td>
        <td class="${TDR}">${money(r.received)}</td>
        <td class="${TDC}">${chk("toggle-nf", r.id, r.invoice_ok ? 2 : 0, "NF enviada", "")}${r.invoice_day ? `<span class="text-xs text-brand-slate ml-1">dia ${r.invoice_day}</span>` : ""}</td>
        <td class="${TDC}">${chk("toggle-recv", r.id, recvState(r), "Recebido (marca o valor faturado como recebido)", "Recebimento parcial — clique para marcar como totalmente recebido")}</td>
        <td class="${TDR}"><button type="button" class="${BTN}" data-fin="edit-rev" data-id="${r.id}">editar</button></td></tr>`
      )
      .join("");
    const revTable = c.revs.length
      ? tableWrap(`<thead><tr><th class="${TH}">Cliente</th><th class="${THR}">Faturado</th><th class="${THR}">Recebido</th><th class="${THC}">NF enviada</th><th class="${THC}">Recebido</th><th></th></tr></thead>
        <tbody>${revRows}</tbody>
        <tfoot><tr class="border-t-2 border-slate-200 font-medium"><td class="${TD}">Total</td><td class="${TDR}">${money(c.billed)}</td><td class="${TDR}">${money(c.received)}</td><td colspan="3" class="${TDR} text-xs text-brand-slate font-normal">A receber: ${money(r2(c.billed - c.received))}</td></tr></tfoot>`)
      : emptyMsg("Nenhuma receita lançada neste mês.");
    const revSection = section("Receitas", `<button type="button" data-fin="new-rev" class="btn-primary">Nova receita</button>`, revTable);

    // Despesas agrupadas por tipo
    let expBody = "";
    for (const cat of fin.cats) {
      const list = c.exps.filter((e) => e.category_id === cat.id);
      if (!list.length) continue;
      const sp = sum(list.filter((e) => e.counted), (e) => e.planned);
      const se = sum(list.filter((e) => e.counted), (e) => e.executed);
      expBody += `<tr class="bg-slate-50"><td class="${TD} font-medium text-brand-navy">${esc(cat.name)}</td><td class="${TDR} font-medium">${money(sp)}</td><td class="${TDR} font-medium">${money(se)}</td><td></td><td></td></tr>`;
      expBody += list
        .map(
          (e) => `<tr class="border-t border-slate-100 ${e.counted ? "" : "text-brand-slate bg-slate-50"}">
          <td class="${TD} pl-5">${esc(e.description)}${e.counted ? "" : notCountedBadge}${e.paid_by ? `<div class="text-xs text-amber-800">Reembolsável · pago por ${esc(e.paid_by)}</div>` : ""}${e.note ? `<div class="text-xs text-brand-slate">${esc(e.note)}</div>` : ""}</td>
          <td class="${TDR}">${money(e.planned)}</td><td class="${TDR}">${money(e.executed)}</td>
          <td class="${TDC}">${chk("toggle-paid", e.id, paidState(e), "Pago (marca o valor planejado como executado)", "Pagamento parcial — clique para marcar como totalmente pago")}</td>
          <td class="${TDR}"><button type="button" class="${BTN}" data-fin="edit-exp" data-id="${e.id}">editar</button></td></tr>`
        )
        .join("");
    }
    const expTable = c.exps.length
      ? tableWrap(`<thead><tr><th class="${TH}">Despesa</th><th class="${THR}">Planejado</th><th class="${THR}">Executado</th><th class="${THC}">Pago</th><th></th></tr></thead>
        <tbody>${expBody}</tbody>
        <tfoot><tr class="border-t-2 border-slate-200 font-medium"><td class="${TD}">Total</td><td class="${TDR}">${money(c.planned)}</td><td class="${TDR}">${money(c.executed)}</td><td colspan="2" class="${TDR} text-xs text-brand-slate font-normal">A pagar: ${money(r2(c.planned - c.executed))}</td></tr></tfoot>`)
      : emptyMsg("Nenhuma despesa lançada neste mês.");
    const expSection = section("Despesas por tipo", `<button type="button" data-fin="new-exp" class="btn-primary">Nova despesa</button>`, expTable);

    const copyBtn = !c.exps.length && fin.month > 1 && calcMonth(fin.month - 1).exps.length
      ? `<p class="text-sm mb-3"><button type="button" data-fin="copy-exp" class="text-brand-navy underline">Copiar as despesas de ${MONTHS[fin.month - 2]} para ${MONTHS[fin.month - 1]}</button> <span class="text-xs text-brand-slate">(copia descrição, tipo e valor planejado; o executado fica zerado)</span></p>`
      : "";

    return picker + cards + revSection + copyBtn + expSection;
  }

  // --------------------------------------------------------------------------
  // Aba Despesas por tipo
  // --------------------------------------------------------------------------

  function viewByType() {
    const kind = fin.kind;
    const rows = expensesByCategory(kind);
    const totals = Array(12).fill(0);
    rows.forEach((r) => r.perMonth.forEach((v, i) => (totals[i] += v)));
    const grand = r2(rows.reduce((a, r) => a + r.total, 0));
    const toggle = `<div class="flex gap-1 text-sm">
      ${[["executed", "Executado"], ["planned", "Planejado"]].map(([k, l]) => `<button type="button" data-fin="kind" data-kind="${k}" class="px-3 py-1 rounded-lg border ${kind === k ? "bg-brand-navy text-white border-brand-navy" : "border-slate-200 text-brand-slate"}">${l}</button>`).join("")}
      <button type="button" data-fin="edit-cats" class="px-3 py-1 text-brand-slate underline">Gerenciar tipos</button></div>`;
    const body = rows
      .filter((r) => r.total !== 0 || r.cat.active)
      .map(
        (r) => `<tr class="border-t border-slate-100"><td class="${TD} whitespace-nowrap">${esc(r.cat.name)}${r.cat.active ? "" : ' <span class="text-xs text-brand-slate">(inativo)</span>'}</td>
        ${r.perMonth.map((v) => `<td class="${TDR} ${v ? "" : "text-slate-300"}">${v ? money(v) : "—"}</td>`).join("")}
        <td class="${TDR} font-medium">${money(r.total)}</td><td class="${TDR}">${grand ? pctFmt(r.total / grand) : "—"}</td></tr>`
      )
      .join("");
    const table = tableWrap(`<thead><tr><th class="${TH}">Tipo</th>${MONTHS_SHORT.map((m) => `<th class="${THR}">${m}</th>`).join("")}<th class="${THR}">Total</th><th class="${THR}">%</th></tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr class="border-t-2 border-slate-200 font-medium"><td class="${TD}">Total</td>${totals.map((v) => `<td class="${TDR}">${money(r2(v))}</td>`).join("")}<td class="${TDR}">${money(grand)}</td><td></td></tr></tfoot>`);

    const max = Math.max(1, ...rows.map((r) => Math.abs(r.total)));
    const bars = rows
      .filter((r) => r.total !== 0)
      .sort((a, b) => b.total - a.total)
      .map(
        (r) => `<div class="flex items-center gap-2 text-sm mb-1.5">
        <span class="w-44 shrink-0 truncate" title="${esc(r.cat.name)}">${esc(r.cat.name)}</span>
        <div class="flex-1 bg-slate-100 rounded h-3"><div class="h-3 rounded bg-brand-navy" style="width:${Math.max(1, (Math.abs(r.total) / max) * 100)}%"></div></div>
        <span class="w-28 text-right tabular-nums">${money(r.total)}</span><span class="w-12 text-right text-xs text-brand-slate">${grand ? pctFmt(r.total / grand) : ""}</span></div>`
      )
      .join("");
    return section(`Despesas por tipo em ${fin.year} (${kind === "executed" ? "executado" : "planejado"})`, toggle, table) +
      section("Quanto cada tipo pesa no ano", "", bars || emptyMsg("Sem despesas lançadas."));
  }

  // --------------------------------------------------------------------------
  // Aba Resultados do ano
  // --------------------------------------------------------------------------

  function resultRow(label, x, cls = "", estimate = false) {
    const share = Number(fin.settings.partner_share) || 0.5;
    return `<tr class="border-t border-slate-100 ${cls}">
      <td class="${TD} whitespace-nowrap">${label}</td>
      <td class="${TDR}">${money(x.billed)}</td><td class="${TDR}">${money(x.received)}</td>
      <td class="${TDR}">${money(x.taxUsed)}${estimate ? ' <span title="Imposto estimado: o valor realmente pago ainda não foi lançado" class="text-amber-600">*</span>' : ""}</td>
      <td class="${TDR}">${money(x.planned)}</td><td class="${TDR}">${money(x.executed)}</td>
      <td class="${TDR} font-medium ${signCls(x.profit)}">${money(x.profit)}</td>
      <td class="${TDR} ${signCls(x.profit)}">${money(r2(x.profit * share))}</td>
      <td class="${TDR}">${money(x.distributed)}</td>
      <td class="${TDR}">${x.received ? pctFmt(x.profit / x.received) : "—"}</td></tr>`;
  }

  function viewResults() {
    const list = allMonths();
    let rows = "";
    list.forEach((c, i) => {
      rows += resultRow(MONTHS[i], c, c.hasData ? "" : "text-slate-400", c.hasData && c.received > 0 && c.taxIsEstimate);
      if ((i + 1) % 3 === 0) rows += resultRow(`${(i + 1) / 3}º trimestre`, { ...sumCalc(list.slice(i - 2, i + 1)) }, "bg-slate-50 font-medium");
    });
    const total = sumCalc(list);
    const semesters = [sumCalc(list.slice(0, 6)), sumCalc(list.slice(6))];
    const head = `<thead><tr><th class="${TH}"></th><th class="${THR}">Faturado</th><th class="${THR}">Recebido</th><th class="${THR}">Imposto</th><th class="${THR}">Desp. planej.</th><th class="${THR}">Desp. exec.</th><th class="${THR}">Lucro</th><th class="${THR}">Por sócio</th><th class="${THR}">Distribuído</th><th class="${THR}">Margem</th></tr></thead>`;
    const table = tableWrap(`${head}<tbody>${rows}${resultRow("1º semestre", semesters[0], "bg-slate-100 font-medium")}${resultRow("2º semestre", semesters[1], "bg-slate-100 font-medium")}${resultRow(`Ano ${fin.year}`, total, "bg-slate-200 font-semibold")}</tbody>`);
    const note = `<p class="text-xs text-brand-slate mt-2">Lucro = recebido − imposto − despesas executadas. O imposto usa o valor realmente pago quando ele foi lançado; caso contrário usa a estimativa (${pctFmt(Number(fin.settings.tax_rate))} do recebido), marcada com <span class="text-amber-600">*</span>. Margem = lucro ÷ recebido. “Por sócio” divide o lucro pela participação de cada sócio.</p>`;
    return section(`Resultados de ${fin.year}`, `<button type="button" data-fin="edit-taxrate" class="text-sm text-brand-slate underline">Percentual do imposto (${pctFmt(Number(fin.settings.tax_rate))})</button>`, table + note) + section("Recebido, despesas e lucro por mês", "", resultsChart(list));
  }

  function resultsChart(list) {
    const W = 760, H = 220, padL = 8, padB = 22, padT = 8;
    const series = [["received", "Recebido", "#0ea5e9"], ["executed", "Despesas", "#f59e0b"], ["profit", "Lucro", "#10b981"]];
    const vals = list.flatMap((c) => series.map(([k]) => c[k]));
    const max = Math.max(1, ...vals), min = Math.min(0, ...vals);
    const span = max - min;
    const y = (v) => padT + (1 - (v - min) / span) * (H - padT - padB);
    const gw = (W - padL) / 12;
    const bw = (gw - 10) / 3;
    let g = "";
    list.forEach((c, i) => {
      series.forEach(([k, , col], j) => {
        const v = c[k];
        const y0 = y(0), y1 = y(v);
        g += `<rect x="${(padL + i * gw + 5 + j * bw).toFixed(1)}" y="${Math.min(y0, y1).toFixed(1)}" width="${(bw - 1).toFixed(1)}" height="${Math.max(0.5, Math.abs(y0 - y1)).toFixed(1)}" fill="${col}"><title>${MONTHS[i]} — ${series[j][1]}: ${money(v)}</title></rect>`;
      });
      g += `<text x="${(padL + i * gw + gw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="11" fill="#51606F">${MONTHS_SHORT[i]}</text>`;
    });
    const legend = series.map(([, l, col]) => `<span class="inline-flex items-center gap-1 mr-3"><span class="inline-block w-3 h-3 rounded-sm" style="background:${col}"></span>${l}</span>`).join("");
    return `<div class="text-xs text-brand-slate mb-1">${legend}</div>
      <svg viewBox="0 0 ${W} ${H}" class="w-full h-auto max-w-4xl" role="img" aria-label="Recebido, despesas e lucro por mês"><line x1="${padL}" x2="${W}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" stroke="#cbd5e1"/>${g}</svg>`;
  }

  // --------------------------------------------------------------------------
  // Aba Planejamento e metas
  // --------------------------------------------------------------------------

  const projOf = (m, sc) => fin.proj.find((p) => p.month_num === m && p.scenario === sc)?.amount;

  function goalsChart(list, goal) {
    const W = 760, H = 240, padL = 8, padB = 22, padT = 24;
    const cum = (arr) => {
      let acc = 0;
      return arr.map((v) => (acc = r2(acc + (Number(v) || 0))));
    };
    const realized = cum(list.map((c) => c.received));
    const lastData = list.reduce((a, c, i) => (c.hasData && c.received > 0 ? i : a), -1);
    const lines = [["Recebido (realizado)", "#0f172a", realized.slice(0, lastData + 1), false]];
    for (const [sc, label, col] of SCENARIOS) {
      if (fin.proj.some((p) => p.scenario === sc)) lines.push([label, col, cum(list.map((_, i) => projOf(i + 1, sc))), true]);
    }
    const all = lines.flatMap((l) => l[2]).concat(goal ? [goal] : []);
    const max = Math.max(1, ...all);
    const x = (i) => padL + (i / 11) * (W - padL - 12);
    const y = (v) => padT + (1 - v / max) * (H - padT - padB);
    let g = "";
    if (goal) g += `<line x1="${padL}" x2="${W - 12}" y1="${y(goal).toFixed(1)}" y2="${y(goal).toFixed(1)}" stroke="#ef4444" stroke-dasharray="5 4"/><text x="${W - 14}" y="${(y(goal) - 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#ef4444">Meta do ano ${esc(money(goal))}</text>`;
    for (const [label, col, pts, dashed] of lines) {
      if (!pts.length) continue;
      g += `<polyline fill="none" stroke="${col}" stroke-width="${dashed ? 2 : 3}" ${dashed ? 'stroke-dasharray="6 3"' : ""} points="${pts.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}"><title>${esc(label)}</title></polyline>`;
      const i = pts.length - 1;
      g += `<circle cx="${x(i).toFixed(1)}" cy="${y(pts[i]).toFixed(1)}" r="3" fill="${col}"><title>${esc(label)} até ${MONTHS[i]}: ${esc(money(pts[i]))}</title></circle>`;
    }
    MONTHS_SHORT.forEach((m, i) => (g += `<text x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="11" fill="#51606F">${m}</text>`));
    const legend = lines.map(([l, col]) => `<span class="inline-flex items-center gap-1 mr-3"><span class="inline-block w-3 h-1 rounded-sm" style="background:${col}"></span>${esc(l)}</span>`).join("");
    return `<div class="text-xs text-brand-slate mb-1">${legend}</div>
      <svg viewBox="0 0 ${W} ${H}" class="w-full h-auto max-w-4xl" role="img" aria-label="Receita acumulada no ano contra metas e cenários">${g}</svg>`;
  }

  function viewGoals() {
    const list = allMonths();
    const t = sumCalc(list);
    const yg = fin.yearGoal;
    const goal = yg?.revenue_goal != null ? Number(yg.revenue_goal) : null;
    const marginGoal = yg?.margin_goal != null ? Number(yg.margin_goal) : null;
    const margin = t.received ? t.profit / t.received : null;
    const cards = `<div class="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
      ${card("Meta de receita do ano", goal != null ? money(goal) : "—", "")}
      ${card("Recebido no ano", money(t.received), goal ? `${pctFmt(t.received / goal)} da meta` : "")}
      ${card("Falta para a meta", goal != null ? money(Math.max(0, r2(goal - t.received))) : "—", goal != null && t.received >= goal ? "Meta atingida" : "")}
      ${card("Margem de lucro", pctFmt(margin), marginGoal != null ? `Meta: ${pctFmt(marginGoal)}` : "")}
    </div>`;
    const totalsProj = SCENARIOS.map(([sc]) => sum(fin.proj.filter((p) => p.scenario === sc), (p) => p.amount));
    const body = list
      .map((c, i) => {
        const m = i + 1;
        const diff = c.goal != null && c.hasData ? r2(c.received - c.goal) : null;
        return `<tr class="border-t border-slate-100">
          <td class="${TD} whitespace-nowrap">${MONTHS[i]}</td>
          <td class="${TDR}">${c.goal != null ? money(c.goal) : "—"} <button type="button" class="${BTN}" data-fin="edit-month" data-month="${m}">editar</button></td>
          <td class="${TDR}">${c.hasData ? money(c.received) : "—"}</td>
          <td class="${TDR} ${signCls(diff)}">${diff != null ? money(diff) : "—"}</td>
          ${SCENARIOS.map(([sc]) => `<td class="px-1 py-1"><input id="fin-proj-${sc}-${m}" type="text" inputmode="decimal" value="${esc(moneyIn(projOf(m, sc)))}" class="${INPUT} w-28 text-right !py-1" /></td>`).join("")}
        </tr>`;
      })
      .join("");
    const table = tableWrap(`<thead><tr><th class="${TH}">Mês</th><th class="${THR}">Meta do mês</th><th class="${THR}">Recebido</th><th class="${THR}">Diferença</th>${SCENARIOS.map(([, l]) => `<th class="${THR}">${l}</th>`).join("")}</tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr class="border-t-2 border-slate-200 font-medium"><td class="${TD}">Total</td><td class="${TDR}">${money(sum(list, (c) => c.goal))}</td><td class="${TDR}">${money(t.received)}</td><td></td>${totalsProj.map((v) => `<td class="${TDR}">${money(v)}</td>`).join("")}</tr>
      ${goal ? `<tr class="text-xs text-brand-slate"><td class="${TD}" colspan="4">Diferença para a meta do ano</td>${totalsProj.map((v) => `<td class="${TDR} ${signCls(r2(v - goal))}">${money(r2(v - goal))}</td>`).join("")}</tr>` : ""}</tfoot>`);
    const actions = `<button type="button" data-fin="edit-yeargoal" class="text-sm text-brand-slate underline">Editar metas do ano</button>
      <button type="button" data-fin="save-proj" class="btn-primary">Salvar cenários</button>`;
    return cards +
      section("Metas por mês e cenários de projeção", actions, table + `<p class="text-xs text-brand-slate mt-2">Os cenários são projeções de receita mensal que você digita (deixe em branco o que não quiser projetar). A meta de cada mês é editada pelo botão “editar” da linha.</p>`) +
      section("Receita acumulada no ano", "", goalsChart(list, goal));
  }

  // --------------------------------------------------------------------------
  // Aba Distribuições e reservas
  // --------------------------------------------------------------------------

  function viewDistrib() {
    const partners = fin.settings.partners || [];
    const share = Number(fin.settings.partner_share) || 0.5;
    const list = allMonths();
    const byPartner = distributionsByPartner();
    const known = new Set(partners);
    const extra = [...byPartner.keys()].filter((p) => !known.has(p));
    const cols = [...partners, ...extra];
    const monthlyRows = list
      .map((c, i) => {
        const per = cols.map((p) => sum(fin.dists.filter((d) => monthOf(d.month) === i + 1 && d.partner === p), (d) => d.amount));
        const left = r2(c.profit * 1 - c.distributed);
        return `<tr class="border-t border-slate-100 ${c.hasData ? "" : "text-slate-400"}"><td class="${TD}">${MONTHS[i]}</td>
          <td class="${TDR} ${signCls(c.profit)}">${money(c.profit)}</td>
          <td class="${TDR}">${money(r2(c.profit * share))}</td>
          ${per.map((v) => `<td class="${TDR}">${v ? money(v) : "—"}</td>`).join("")}
          <td class="${TDR} ${signCls(left)}">${c.hasData ? money(left) : "—"}</td></tr>`;
      })
      .join("");
    const tot = sumCalc(list);
    const summary = tableWrap(`<thead><tr><th class="${TH}">Mês</th><th class="${THR}">Lucro</th><th class="${THR}">Parte de cada sócio</th>${cols.map((p) => `<th class="${THR}">Distribuído: ${esc(p)}</th>`).join("")}<th class="${THR}">Lucro − distribuído</th></tr></thead>
      <tbody>${monthlyRows}</tbody>
      <tfoot><tr class="border-t-2 border-slate-200 font-medium"><td class="${TD}">Ano</td><td class="${TDR}">${money(tot.profit)}</td><td class="${TDR}">${money(r2(tot.profit * share))}</td>${cols.map((p) => `<td class="${TDR}">${money(byPartner.get(p) || 0)}</td>`).join("")}<td class="${TDR}">${money(r2(tot.profit - tot.distributed))}</td></tr></tfoot>`);

    const dRows = fin.dists
      .map(
        (d) => `<tr class="border-t border-slate-100"><td class="${TD}">${MONTHS[monthOf(d.month) - 1]}</td><td class="${TD}">${esc(d.partner)}</td><td class="${TDR}">${money(d.amount)}</td>
        <td class="${TD} text-xs">${d.paid_on ? esc(String(d.paid_on).split("-").reverse().join("/")) : ""}</td>
        <td class="${TDR}"><button type="button" class="${BTN}" data-fin="edit-dist" data-id="${d.id}">editar</button></td></tr>`
      )
      .join("");
    const dTable = fin.dists.length
      ? tableWrap(`<thead><tr><th class="${TH}">Mês</th><th class="${TH}">Sócio</th><th class="${THR}">Valor</th><th class="${TH}">Pago em</th><th></th></tr></thead><tbody>${dRows}</tbody>`)
      : emptyMsg("Nenhuma distribuição lançada neste ano.");

    const names = [...new Set(fin.reserves.map((r) => r.name))];
    const rRows = fin.reserves
      .map(
        (r) => `<tr class="border-t border-slate-100"><td class="${TD}">${MONTHS[monthOf(r.month) - 1]}</td><td class="${TD}">${esc(r.name)}${r.note ? `<div class="text-xs text-brand-slate">${esc(r.note)}</div>` : ""}</td>
        <td class="${TDR} ${signCls(r.amount)}">${money(r.amount)}</td><td class="${TDR}"><button type="button" class="${BTN}" data-fin="edit-res" data-id="${r.id}">editar</button></td></tr>`
      )
      .join("");
    const rTotals = names
      .map((n) => `<tr class="border-t border-slate-100"><td class="${TD}">${esc(n)}</td><td class="${TDR} font-medium">${money(sum(fin.reserves.filter((r) => r.name === n), (r) => r.amount))}</td></tr>`)
      .join("");
    const rTable = fin.reserves.length
      ? `<div class="grid lg:grid-cols-2 gap-6">
          <div>${tableWrap(`<thead><tr><th class="${TH}">Mês</th><th class="${TH}">Reserva</th><th class="${THR}">Valor</th><th></th></tr></thead><tbody>${rRows}</tbody>`)}</div>
          <div><p class="text-xs font-medium text-brand-slate mb-1">Total no ano por reserva</p>${tableWrap(`<tbody>${rTotals}</tbody>`)}</div></div>`
      : emptyMsg("Nenhuma reserva lançada neste ano.");

    return section(`Lucro e distribuições em ${fin.year}`, "", summary + `<p class="text-xs text-brand-slate mt-2">Lucro = recebido − imposto − despesas executadas (veja “Resultados do ano”).</p>`) +
      section("Distribuições lançadas", `<button type="button" data-fin="new-dist" class="btn-primary">Nova distribuição</button>`, dTable) +
      section("Reservas e provisionamentos", `<button type="button" data-fin="new-res" class="btn-primary">Nova reserva</button>`, rTable);
  }

  // --------------------------------------------------------------------------
  // Aba Bônus da equipe
  // --------------------------------------------------------------------------

  function viewBonus() {
    const periods = bonusPeriods();
    const sel = `<label class="text-sm text-brand-slate flex items-center gap-1.5">Período
      <select id="fin-bonus-period" class="${INPUT}">${periods.map((p) => `<option value="${esc(p)}" ${p === fin.bonusPeriod ? "selected" : ""}>${esc(p)}</option>`).join("")}</select></label>`;
    const actions = `${periods.length ? sel : ""}<button type="button" data-fin="new-bonus" class="btn-primary">Novo lançamento de bônus</button>`;
    if (!periods.length) return section("Bônus da equipe", actions, emptyMsg("Nenhum bônus lançado."));
    const list = fin.bonus.filter((b) => b.period === fin.bonusPeriod);
    let total = 0;
    const pts = (v) => (Math.round(v * 1000) / 10).toString().replace(".", ",");
    const rows = list
      .map((b) => {
        const c = calcBonus(b);
        const mx = Number(b.max_multiple) || 3;
        if (c.value != null) total += c.value;
        const notes = CRITERIA.map(([k, l]) => `${l}: ${b.scores?.[k] ?? "—"}`).join(" · ");
        const sal = c.mult != null ? (Math.round(c.mult * mx * 100) / 100).toString().replace(".", ",") : "—";
        return `<tr class="border-t border-slate-100"><td class="${TD}">${esc(b.person)}${b.note ? `<div class="text-xs text-amber-700">${esc(b.note)}</div>` : ""}</td>
          <td class="${TDR}">${money(b.base)}</td>
          <td class="${TDR}" title="${esc(notes)}">${c.individual != null ? pts(c.individual) : "—"}</td>
          <td class="${TDR}">${c.trigger ? (c.individual != null ? pts(c.finPart) : "—") : '<span class="text-xs text-amber-800">gatilho não atingido</span>'}</td>
          <td class="${TDR} font-medium">${c.trigger && c.mult != null ? sal : c.trigger ? "—" : "0"} <span class="text-xs text-brand-slate font-normal">de ${String(mx).replace(".", ",")}</span></td>
          <td class="${TDR} font-medium">${c.value != null ? money(c.value) : "—"}${c.fromOverride ? ' <span class="text-xs text-brand-slate" title="Valor informado manualmente">(manual)</span>' : ""}</td>
          <td class="${TDR}"><button type="button" class="${BTN}" data-fin="edit-bonus" data-id="${b.id}">editar</button></td></tr>`;
      })
      .join("");
    const table = tableWrap(`<thead><tr><th class="${TH}">Pessoa</th><th class="${THR}">Base (salário médio)</th><th class="${THR}">Individual (até 60)</th><th class="${THR}">Meta financeira (até 40)</th><th class="${THR}">Bônus em salários (máx. 3)</th><th class="${THR}">Valor do bônus</th><th></th></tr></thead>
      <tbody>${rows}</tbody><tfoot><tr class="border-t-2 border-slate-200 font-medium"><td class="${TD}" colspan="5">Total do período</td><td class="${TDR}">${money(r2(total))}</td><td></td></tr></tfoot>`);
    return section("Bônus da equipe", actions, table +
      `<p class="text-xs text-brand-slate mt-2">O bônus vai de 0 a 3 salários (a base é a remuneração fixa média dos últimos 6 meses). Quanto chega perto de 3 depende de 100 pontos: até 60 da avaliação individual (média das 6 notas × 6) e até 40 da meta financeira do semestre (60–70% da meta vale 60% dos 40 pontos, 70–80% vale 70%, 80–90% vale 80%, 90–100% vale 90%, 100% vale tudo; abaixo de 60% não há bônus). Bônus em salários = 3 × pontos ÷ 100. Passe o mouse sobre a nota individual para ver as 6 notas.</p>`);
  }

  // --------------------------------------------------------------------------
  // Janelas de lançamento
  // --------------------------------------------------------------------------

  const fld = (label, inner, cls = "") => `<label class="block text-xs text-brand-slate ${cls}">${label}${inner}</label>`;
  const text = (id, val, max = 200, ph = "") => `<input id="${id}" type="text" maxlength="${max}" value="${esc(val ?? "")}" placeholder="${esc(ph)}" class="${INPUT} w-full mt-1" />`;
  const moneyInput = (id, val, ph = "Ex.: 4.500,00") => `<input id="${id}" type="text" inputmode="decimal" maxlength="16" value="${esc(moneyIn(val))}" placeholder="${esc(ph)}" class="${INPUT} w-full mt-1" />`;
  const dateInput = (id, val) => `<input id="${id}" type="date" value="${esc(val || "")}" class="${INPUT} w-full mt-1" />`;
  const selectInput = (id, options, cur) => `<select id="${id}" class="${INPUT} w-full mt-1">${options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(cur) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  const checkInput = (id, checked, label) => `<label class="flex items-center gap-2 text-sm text-brand-navy mt-5"><input id="${id}" type="checkbox" ${checked ? "checked" : ""} /> ${label}</label>`;
  const textArea = (id, val, max = 1000) => `<textarea id="${id}" rows="2" maxlength="${max}" class="${INPUT} w-full mt-1">${esc(val ?? "")}</textarea>`;
  const monthOptions = () => MONTHS.map((n, i) => [monthIso(fin.year, i + 1), `${n} de ${fin.year}`]);

  function modalHtml() {
    const md = fin.modal;
    const id = md.id;
    const isNew = id == null;
    let title = "";
    let inner = "";
    let canDelete = false;
    let saveLabel = "Salvar";

    switch (md.kind) {
      case "rev": {
        const r = isNew ? { month: monthIso(fin.year, fin.month), counted: true, invoice_ok: false } : fin.revenues.find((x) => x.id === id) || {};
        title = isNew ? "Nova receita" : "Editar receita";
        canDelete = !isNew;
        inner = `<div class="grid sm:grid-cols-2 gap-3">
          ${fld("Mês", selectInput("f-month", monthOptions(), r.month))}
          ${fld("Cliente", text("f-client", r.client, 200))}
          ${fld("Faturado (R$)", moneyInput("f-billed", r.billed ?? 0))}
          ${fld("Recebido (R$)", moneyInput("f-received", r.received ?? 0))}
          ${fld("Dia da nota fiscal (opcional)", `<input id="f-invday" type="number" min="1" max="31" value="${esc(r.invoice_day ?? "")}" class="${INPUT} w-full mt-1" />`)}
          ${checkInput("f-invok", r.invoice_ok, "NF enviada")}
          ${checkInput("f-recvall", false, "Recebido integralmente (usa o valor faturado)")}
          ${checkInput("f-counted", r.counted !== false, "Somar nos totais do mês")}
        </div>${fld("Observação (opcional)", textArea("f-note", r.note), "mt-3")}`;
        break;
      }
      case "exp": {
        const e = isNew ? { month: monthIso(fin.year, fin.month), counted: true } : fin.expenses.find((x) => x.id === id) || {};
        title = isNew ? "Nova despesa" : "Editar despesa";
        canDelete = !isNew;
        const cats = fin.cats.filter((c) => c.active || c.id === e.category_id);
        inner = `<div class="grid sm:grid-cols-2 gap-3">
          ${fld("Mês", selectInput("f-month", monthOptions(), e.month))}
          ${fld("Tipo de despesa", selectInput("f-cat", cats.map((c) => [c.id, c.name]), e.category_id ?? cats[0]?.id))}
          ${fld("Descrição", text("f-desc", e.description, 200), "sm:col-span-2")}
          ${fld("Planejado (R$)", moneyInput("f-planned", e.planned ?? 0))}
          ${fld("Executado (R$)", moneyInput("f-executed", e.executed ?? 0))}
          ${checkInput("f-paidall", false, "Pago integralmente (executado = planejado)")}
          ${checkInput("f-counted", e.counted !== false, "Somar nos totais do mês")}
          ${checkInput("f-reimbursable", !!e.paid_by, "Reembolsável (alguém pagou do próprio bolso)")}
          <div id="f-paidby-wrap" class="${e.paid_by ? "" : "hidden"}">${fld("Quem pagou", `<input id="f-paidby" type="text" maxlength="80" list="f-paidby-list" value="${esc(e.paid_by ?? "")}" placeholder="Ex.: Otávio" class="${INPUT} w-full mt-1" /><datalist id="f-paidby-list">${[...new Set(["Otávio", "Ricardo", "Feijó", "Lian", ...fin.expenses.map((x) => x.paid_by).filter(Boolean)])].map((n) => `<option value="${esc(n)}"></option>`).join("")}</datalist>`)}</div>
        </div>${fld("Observação (opcional)", textArea("f-note", e.note), "mt-3")}`;
        break;
      }
      case "month": {
        const m = md.month;
        const r = monthRow(m) || {};
        title = `Ajustar ${MONTHS[m - 1]} de ${fin.year}`;
        inner = `<p class="text-xs text-brand-slate mb-3">Deixe em branco para o Hub calcular sozinho (imposto estimado = ${pctFmt(Number(fin.settings.tax_rate))} do valor).</p>
          <div class="grid sm:grid-cols-2 gap-3">
          ${fld("Meta de receita do mês (R$)", moneyInput("f-goal", r.revenue_goal))}
          ${fld("Imposto previsto (sobre o faturado), se for diferente do cálculo (R$)", moneyInput("f-taxplan", r.tax_planned_override))}
          ${fld("Imposto estimado (sobre o recebido), se for diferente do cálculo (R$)", moneyInput("f-taxrec", r.tax_received_override))}
          ${fld("Imposto realmente pago (R$)", moneyInput("f-taxpaid", r.tax_paid))}
          ${fld("Imposto pago em (opcional)", dateInput("f-taxpaidon", r.tax_paid_on))}
          </div>${fld("Observação do mês (opcional)", textArea("f-note", r.note), "mt-3")}`;
        break;
      }
      case "dist": {
        const d = isNew ? { month: monthIso(fin.year, fin.month), partner: (fin.settings.partners || [])[0] } : fin.dists.find((x) => x.id === id) || {};
        title = isNew ? "Nova distribuição" : "Editar distribuição";
        canDelete = !isNew;
        const ps = [...new Set([...(fin.settings.partners || []), d.partner].filter(Boolean))];
        inner = `<div class="grid sm:grid-cols-2 gap-3">
          ${fld("Mês", selectInput("f-month", monthOptions(), d.month))}
          ${fld("Sócio", selectInput("f-partner", ps.map((p) => [p, p]), d.partner))}
          ${fld("Valor (R$)", moneyInput("f-amount", d.amount))}
          ${fld("Pago em (opcional)", dateInput("f-paidon", d.paid_on))}
          </div>${fld("Observação (opcional)", textArea("f-note", d.note), "mt-3")}`;
        break;
      }
      case "res": {
        const r = isNew ? { month: monthIso(fin.year, fin.month) } : fin.reserves.find((x) => x.id === id) || {};
        title = isNew ? "Nova reserva" : "Editar reserva";
        canDelete = !isNew;
        inner = `<div class="grid sm:grid-cols-2 gap-3">
          ${fld("Mês", selectInput("f-month", monthOptions(), r.month))}
          ${fld("Nome da reserva", text("f-name", r.name, 120, "Ex.: Fundo de reserva escritório"))}
          ${fld("Valor (R$, pode ser negativo para retirada)", moneyInput("f-amount", r.amount))}
          </div>${fld("Observação (opcional)", textArea("f-note", r.note), "mt-3")}`;
        break;
      }
      case "yeargoal": {
        const g = fin.yearGoal || {};
        title = `Metas de ${fin.year}`;
        inner = `<div class="grid sm:grid-cols-2 gap-3">
          ${fld("Meta de receita do ano (R$)", moneyInput("f-goal", g.revenue_goal))}
          ${fld("Meta de margem de lucro (%)", `<input id="f-margin" type="text" inputmode="decimal" maxlength="6" value="${esc(g.margin_goal != null ? String(r2(g.margin_goal * 100)).replace(".", ",") : "")}" placeholder="Ex.: 55" class="${INPUT} w-full mt-1" />`)}
          </div>`;
        break;
      }
      case "bonus": {
        const b = isNew ? { period: fin.bonusPeriod || "", max_multiple: 3, financial_part: 0.4, scores: {}, score_notes: {} } : fin.bonus.find((x) => x.id === id) || {};
        title = isNew ? "Novo lançamento de bônus" : `Bônus — ${b.person}`;
        canDelete = !isNew;
        const sc = b.scores || {}, sn = b.score_notes || {};
        inner = `<div class="grid sm:grid-cols-2 gap-3">
          ${fld("Período", text("f-period", b.period, 60, "Ex.: 1º semestre 2027"))}
          ${fld("Pessoa", text("f-person", b.person, 120))}
          ${fld("Base do bônus (R$)", moneyInput("f-base", b.base))}
          ${fld("Meta financeira do escritório no semestre (parte financeira)", selectInput("f-finpart", finTierOf(b.financial_part ?? 0.4) ? FIN_TIERS : [...FIN_TIERS, [b.financial_part, `Valor antigo: ${String(b.financial_part).replace(".", ",")} (escolha uma faixa para padronizar)`]], finTierOf(b.financial_part ?? 0.4)?.[0] ?? b.financial_part), "sm:col-span-2")}
          </div>
          <p class="text-sm font-medium text-brand-navy mt-4 mb-1">Notas (0 a 10) e observações</p>
          <div class="grid sm:grid-cols-2 gap-3">
          ${CRITERIA.map(([k, l]) => fld(l, `<div class="flex gap-2 mt-1"><input id="f-sc-${k}" type="number" min="0" max="10" value="${esc(sc[k] ?? "")}" class="${INPUT} w-20" /><input id="f-sn-${k}" type="text" maxlength="300" value="${esc(sn[k] || "")}" placeholder="Observação" class="${INPUT} flex-1 min-w-0" /></div>`)).join("")}
          </div>
          <div class="grid sm:grid-cols-2 gap-3 mt-4">
          ${fld("Total de pontos de 0 a 100 (use só se faltar alguma das 6 notas)", `<input id="f-mult" type="text" inputmode="decimal" value="${esc(b.multiplier != null ? String(Math.round(b.multiplier * 10000) / 100).replace(".", ",") : "")}" class="${INPUT} w-full mt-1" />`)}
          ${fld("Valor informado manualmente (R$, substitui o cálculo)", moneyInput("f-override", b.amount_override))}
          </div>${fld("Observação (opcional)", textArea("f-note", b.note), "mt-3")}`;
        break;
      }
      case "taxrate": {
        title = "Percentual do imposto";
        const cur = Number(fin.settings.tax_rate) || 0;
        inner = `<p class="text-sm text-brand-slate mb-3">O imposto estimado de cada mês é este percentual aplicado sobre o recebido (e o “imposto previsto” é aplicado sobre o faturado). A mudança vale para todos os meses do Hub que não têm imposto informado à mão.</p>
          <div class="grid sm:grid-cols-2 gap-3">${fld("Percentual do imposto (%)", `<input id="f-rate" type="text" inputmode="decimal" maxlength="6" value="${esc(String(r2(cur * 100)).replace(".", ","))}" placeholder="Ex.: 12" class="${INPUT} w-full mt-1" />`)}</div>
          <p class="text-xs text-brand-slate mt-3">Não mudam: meses com “Imposto realmente pago” lançado e meses em que você digitou o imposto estimado ou previsto manualmente (em “Ajustar o mês”).</p>`;
        break;
      }
      case "cats": {
        title = "Tipos de despesa";
        saveLabel = null;
        inner = `<div class="space-y-2">${fin.cats
          .map(
            (c) => `<div class="flex flex-wrap items-center gap-2" data-catrow="${c.id}">
            <input type="text" maxlength="80" value="${esc(c.name)}" data-cat-name class="${INPUT} flex-1 min-w-[10rem]" />
            <input type="number" value="${c.sort_order}" data-cat-order class="${INPUT} w-20" title="Ordem" />
            <label class="text-xs text-brand-slate flex items-center gap-1"><input type="checkbox" data-cat-active ${c.active ? "checked" : ""} /> ativo</label>
            <button type="button" data-fin="save-cat" data-id="${c.id}" class="text-sm text-brand-navy underline">Salvar</button>
            <button type="button" data-fin="delete-cat" data-id="${c.id}" class="text-xs text-rose-600 underline">Excluir</button></div>`
          )
          .join("")}
          <div class="flex flex-wrap items-center gap-2 pt-3 border-t border-slate-200">
            <input id="f-newcat" type="text" maxlength="80" placeholder="Novo tipo de despesa" class="${INPUT} flex-1 min-w-[10rem]" />
            <button type="button" data-fin="add-cat" class="btn-primary">Adicionar</button></div></div>
          <p class="text-xs text-brand-slate mt-3">Um tipo que já tem despesas não pode ser excluído; desmarque “ativo” para escondê-lo da lista de novos lançamentos.</p>`;
        break;
      }
      default:
        return "";
    }

    const delArea = canDelete
      ? md.confirmDelete
        ? `<button type="button" data-fin="modal-delete" class="rounded-lg bg-rose-600 text-white px-3 py-2 text-sm">Confirmar exclusão</button><button type="button" data-fin="modal-cancel-delete" class="text-sm text-brand-slate underline">Não excluir</button>`
        : `<button type="button" data-fin="modal-ask-delete" class="text-sm text-rose-600 underline">Excluir</button>`
      : "";
    return `
    <div class="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      <div class="absolute inset-0 bg-black/40" data-fin="modal-close"></div>
      <div class="relative w-full sm:w-[640px] bg-white h-full overflow-y-auto shadow-xl">
        <div class="sticky top-0 z-10 bg-white border-b border-slate-200 px-5 py-3 flex items-center gap-3">
          <h3 class="font-heading text-base font-semibold text-brand-navy mr-auto truncate">${esc(title)}</h3>
          <button type="button" data-fin="modal-close" class="text-sm text-brand-slate underline">Fechar</button>
        </div>
        <div class="p-5">
          ${inner}
          <p id="fin-modal-error" class="text-sm text-red-500 mt-3 ${md.error ? "" : "hidden"}">${esc(md.error || "")}</p>
          <div class="flex flex-wrap items-center gap-3 mt-5">
            ${saveLabel ? `<button type="button" data-fin="modal-save" class="btn-primary">${saveLabel}</button>` : ""}
            <button type="button" data-fin="modal-close" class="text-sm text-brand-slate underline">${saveLabel ? "Cancelar" : "Concluir"}</button>
            <span class="ml-auto flex items-center gap-3">${delArea}</span>
          </div>
        </div>
      </div>
    </div>`;
  }

  // --------------------------------------------------------------------------
  // Ações
  // --------------------------------------------------------------------------

  const F = (id) => $("fin-modal")?.querySelector("#" + id);
  const fval = (id) => (F(id)?.value ?? "").trim();
  const fchk = (id) => !!F(id)?.checked;

  function friendlyError(err) {
    const code = err?.code;
    const msg = err?.message || String(err);
    if (code === "23505") return "Já existe um lançamento igual (mesmo nome no mesmo mês, período ou tipo).";
    if (code === "23503") return "Este item está em uso por outros lançamentos e não pode ser excluído.";
    if (code === "42501") return "Sem permissão para esta ação (somente administradores).";
    if (code === "23514") return "Algum valor está fora do permitido (confira números e tamanhos dos textos).";
    return msg;
  }

  function openModal(kind, id = null, extra = {}) {
    fin.modal = { kind, id, error: null, confirmDelete: false, ...extra };
    renderModalHost();
    const first = $("fin-modal")?.querySelector("input[type=text],select");
    if (first) first.focus();
  }

  function closeModal() {
    fin.modal = null;
    renderModalHost();
  }

  function setModalError(text) {
    if (fin.modal) fin.modal.error = text;
    const el = $("fin-modal-error");
    if (el) {
      el.textContent = text || "";
      el.classList.toggle("hidden", !text);
    }
  }

  const cleanNote = (note, counted) => {
    let n = (note || "").trim();
    if (counted) n = n.replace(new RegExp(`\\s*\\|?\\s*${COUNTED_NOTE}\\s*`), "").replace(/^\s*\|\s*/, "").trim();
    return n || null;
  };

  // Leitura de dinheiro de um campo: devolve { v } ou { err }.
  function readMoney(id, label, { required = false, min = null, positive = false } = {}) {
    const raw = fval(id);
    const v = parseMoney(raw);
    if (raw === "" || v === null) return required ? { err: `Informe ${label}.` } : { v: null };
    if (Number.isNaN(v)) return { err: `${label}: valor inválido. Use o formato 1.234,56.` };
    if (positive && v <= 0) return { err: `${label} deve ser maior que zero.` };
    if (min != null && v < min) return { err: `${label} não pode ser negativo.` };
    return { v };
  }

  function readDec(id, label, lo, hi) {
    const raw = fval(id).replace(",", ".");
    if (raw === "") return { v: null };
    const n = Number(raw);
    if (!Number.isFinite(n) || n < lo || n > hi) return { err: `${label}: informe um número entre ${String(lo).replace(".", ",")} e ${String(hi).replace(".", ",")}.` };
    return { v: n };
  }

  // Monta { table, row, conflict? } ou { error } para o formulário aberto.
  function buildSave() {
    const md = fin.modal;
    const fail = (e) => ({ error: e });
    const need = (...rs) => rs.find((r) => r.err);
    switch (md.kind) {
      case "rev": {
        const client = fval("f-client");
        if (!client) return fail("Informe o cliente.");
        const b = readMoney("f-billed", "O faturado", { min: 0 });
        const r = readMoney("f-received", "O recebido", { min: 0 });
        const bad = need(b, r);
        if (bad) return fail(bad.err);
        const dayRaw = fval("f-invday");
        let day = null;
        if (dayRaw !== "") {
          day = Number(dayRaw);
          if (!Number.isInteger(day) || day < 1 || day > 31) return fail("O dia da nota fiscal deve ficar entre 1 e 31.");
        }
        const counted = fchk("f-counted");
        return { table: "fin_revenues", row: { month: fval("f-month"), client, billed: b.v ?? 0, received: fchk("f-recvall") ? b.v ?? 0 : r.v ?? 0, invoice_day: day, invoice_ok: fchk("f-invok"), counted, note: cleanNote(fval("f-note"), counted) } };
      }
      case "exp": {
        const description = fval("f-desc");
        if (!description) return fail("Informe a descrição da despesa.");
        const catId = Number(fval("f-cat"));
        if (!catId) return fail("Escolha o tipo de despesa.");
        const p = readMoney("f-planned", "O planejado");
        const e = readMoney("f-executed", "O executado");
        const bad = need(p, e);
        if (bad) return fail(bad.err);
        const counted = fchk("f-counted");
        const paidBy = fchk("f-reimbursable") ? fval("f-paidby") : "";
        if (fchk("f-reimbursable") && !paidBy) return fail("Informe quem pagou a despesa reembolsável.");
        return { table: "fin_expenses", row: { month: fval("f-month"), description, category_id: catId, planned: p.v ?? 0, executed: fchk("f-paidall") ? p.v ?? 0 : e.v ?? 0, counted, paid_by: paidBy || null, note: cleanNote(fval("f-note"), counted) } };
      }
      case "month": {
        const g = readMoney("f-goal", "A meta", { min: 0 });
        const tp = readMoney("f-taxplan", "O imposto previsto", { min: 0 });
        const tr = readMoney("f-taxrec", "O imposto estimado", { min: 0 });
        const tpaid = readMoney("f-taxpaid", "O imposto pago", { min: 0 });
        const bad = need(g, tp, tr, tpaid);
        if (bad) return fail(bad.err);
        return { table: "fin_months", conflict: "month", row: { month: monthIso(fin.year, md.month), revenue_goal: g.v, tax_planned_override: tp.v, tax_received_override: tr.v, tax_paid: tpaid.v, tax_paid_on: fval("f-taxpaidon") || null, note: fval("f-note") || null } };
      }
      case "dist": {
        const a = readMoney("f-amount", "O valor", { required: true, positive: true });
        if (a.err) return fail(a.err);
        return { table: "fin_distributions", row: { month: fval("f-month"), partner: fval("f-partner"), amount: a.v, paid_on: fval("f-paidon") || null, note: fval("f-note") || null } };
      }
      case "res": {
        const name = fval("f-name");
        if (!name) return fail("Informe o nome da reserva.");
        const a = readMoney("f-amount", "O valor", { required: true });
        if (a.err) return fail(a.err);
        return { table: "fin_reserves", row: { month: fval("f-month"), name, amount: a.v, note: fval("f-note") || null } };
      }
      case "taxrate": {
        const raw = fval("f-rate");
        if (raw === "") return fail("Informe o percentual do imposto.");
        const rt = readDec("f-rate", "O percentual", 0, 100);
        if (rt.err) return fail(rt.err);
        return { table: "fin_settings", conflict: "key", row: { key: "tax_rate", value: Math.round(rt.v * 100) / 10000 } };
      }
      case "yeargoal": {
        const g = readMoney("f-goal", "A meta de receita", { min: 0 });
        if (g.err) return fail(g.err);
        const mg = readDec("f-margin", "A meta de margem", 0, 100);
        if (mg.err) return fail(mg.err);
        return { table: "fin_year_goals", conflict: "year", row: { year: fin.year, revenue_goal: g.v, margin_goal: mg.v == null ? null : r2(mg.v) / 100 } };
      }
      case "bonus": {
        const period = fval("f-period"), person = fval("f-person");
        if (!period || !person) return fail("Informe o período e a pessoa.");
        const base = readMoney("f-base", "A base", { min: 0 });
                const fpRaw = Number(fval("f-finpart"));
        const fp = Number.isFinite(fpRaw) && fpRaw >= 0 && fpRaw <= 1 ? { v: fpRaw } : { err: "Escolha a faixa da meta financeira." };
        const mu0 = readDec("f-mult", "O total de pontos", 0, 100);
        const mu = mu0.err ? mu0 : { v: mu0.v == null ? null : mu0.v / 100 };
        const ov = readMoney("f-override", "O valor manual", { min: 0 });
        const bad = need(base, fp, mu, ov);
        if (bad) return fail(bad.err);
        const scores = {}, notes = {};
        for (const [k, l] of CRITERIA) {
          const raw = fval("f-sc-" + k);
          if (raw !== "") {
            const n = Number(raw);
            if (!Number.isInteger(n) || n < 0 || n > 10) return fail(`${l}: a nota deve ser um número inteiro de 0 a 10.`);
            scores[k] = n;
          }
          const nt = fval("f-sn-" + k);
          if (nt) notes[k] = nt;
        }
        return { table: "fin_bonus", row: { period, person, base: base.v, max_multiple: 3, financial_part: fp.v ?? 0.4, scores: Object.keys(scores).length ? scores : null, score_notes: Object.keys(notes).length ? notes : null, multiplier: mu.v, amount_override: ov.v, note: fval("f-note") || null } };
      }
      default:
        return fail("Formulário desconhecido.");
    }
  }

  async function reloadAndRender() {
    await loadData();
    renderYearOptions();
    renderBody();
    if (fin.modal) renderModalHost();
  }

  async function saveModal() {
    const md = fin.modal;
    if (!md || fin.saving) return;
    const built = buildSave();
    if (built.error) return setModalError(built.error);
    setModalError(null);
    fin.saving = true;
    const btn = document.querySelector('[data-fin="modal-save"]');
    if (btn) btn.disabled = true;
    try {
      let q;
      if (built.conflict) q = sb.from(built.table).upsert(built.row, { onConflict: built.conflict });
      else if (md.id != null) q = sb.from(built.table).update(built.row).eq("id", md.id);
      else q = sb.from(built.table).insert(built.row);
      const { error } = await q;
      if (error) throw error;
      if (md.kind === "bonus") fin.bonusPeriod = built.row.period;
      fin.modal = null;
      await reloadAndRender();
      renderModalHost();
      flash("Salvo.");
    } catch (e) {
      setModalError("Não foi possível salvar: " + friendlyError(e));
    } finally {
      fin.saving = false;
      const b2 = document.querySelector('[data-fin="modal-save"]');
      if (b2) b2.disabled = false;
    }
  }

  const TABLE_OF = { rev: "fin_revenues", exp: "fin_expenses", dist: "fin_distributions", res: "fin_reserves", bonus: "fin_bonus" };

  async function deleteModal() {
    const md = fin.modal;
    if (!md || md.id == null || !TABLE_OF[md.kind] || fin.saving) return;
    fin.saving = true;
    try {
      const { error } = await sb.from(TABLE_OF[md.kind]).delete().eq("id", md.id);
      if (error) throw error;
      fin.modal = null;
      await reloadAndRender();
      renderModalHost();
      flash("Lançamento excluído.");
    } catch (e) {
      setModalError("Não foi possível excluir: " + friendlyError(e));
    } finally {
      fin.saving = false;
    }
  }

  async function quickToggle(kind, id, box) {
    if (fin.saving) { renderBody(); return; }
    const want = box.checked;
    let table, before, patch, msg;
    if (kind === "nf") {
      const r = fin.revenues.find((x) => x.id === id);
      if (!r) return;
      table = "fin_revenues"; before = { invoice_ok: r.invoice_ok }; patch = { invoice_ok: want };
      msg = want ? `NF de “${r.client}” marcada como enviada.` : `NF de “${r.client}” desmarcada.`;
    } else if (kind === "recv") {
      const r = fin.revenues.find((x) => x.id === id);
      if (!r) return;
      table = "fin_revenues"; before = { received: r.received }; patch = { received: want ? r.billed : 0 };
      msg = want ? `“${r.client}” marcado como recebido (${money(r.billed)}).` : `Recebimento de “${r.client}” zerado.`;
    } else {
      const e = fin.expenses.find((x) => x.id === id);
      if (!e) return;
      table = "fin_expenses"; before = { executed: e.executed }; patch = { executed: want ? e.planned : 0 };
      msg = want ? `“${e.description}” marcada como paga (${money(e.planned)}).` : `Pagamento de “${e.description}” zerado.`;
    }
    fin.saving = true;
    try {
      const { error } = await sb.from(table).update(patch).eq("id", id);
      if (error) throw error;
      fin.undo = { table, id, before };
      await reloadAndRender();
      flashUndo(msg);
    } catch (err) {
      await reloadAndRender().catch(() => {});
      flash("Não foi possível salvar: " + friendlyError(err), "error");
    } finally {
      fin.saving = false;
    }
  }

  async function undoToggle() {
    const u = fin.undo;
    if (!u || fin.saving) return;
    fin.saving = true;
    try {
      const { error } = await sb.from(u.table).update(u.before).eq("id", u.id);
      if (error) throw error;
      fin.undo = null;
      await reloadAndRender();
      flash("Desfeito.");
    } finally {
      fin.saving = false;
    }
  }

  async function saveProjections() {
    const upserts = [], removals = [];
    for (let m = 1; m <= 12; m++) {
      for (const [sc] of SCENARIOS) {
        const el = $(`fin-proj-${sc}-${m}`);
        if (!el) continue;
        const v = parseMoney(el.value);
        if (Number.isNaN(v) || (v != null && v < 0)) {
          flash(`Valor inválido em ${MONTHS[m - 1]} (${sc}). Use números positivos no formato 1.234,56.`, "error");
          return;
        }
        if (v == null) {
          if (projOf(m, sc) != null) removals.push([m, sc]);
        } else upserts.push({ year: fin.year, month_num: m, scenario: sc, amount: v });
      }
    }
    if (upserts.length) {
      const { error } = await sb.from("fin_projections").upsert(upserts, { onConflict: "year,month_num,scenario" });
      if (error) throw error;
    }
    for (const [m, sc] of removals) {
      const { error } = await sb.from("fin_projections").delete().eq("year", fin.year).eq("month_num", m).eq("scenario", sc);
      if (error) throw error;
    }
    await reloadAndRender();
    flash("Cenários salvos.");
  }

  async function copyExpenses() {
    const prev = fin.month - 1;
    const src = fin.expenses.filter((e) => monthOf(e.month) === prev && e.counted);
    if (!src.length || fin.expenses.some((e) => monthOf(e.month) === fin.month)) return;
    const rows = src.map((e) => ({ month: monthIso(fin.year, fin.month), description: e.description, category_id: e.category_id, planned: e.planned, executed: 0, counted: true, note: null }));
    const { error } = await sb.from("fin_expenses").insert(rows);
    if (error) throw error;
    await reloadAndRender();
    flash(`${rows.length} despesas copiadas de ${MONTHS[prev - 1]}.`);
  }

  async function catAction(act, id, btn) {
    try {
      if (act === "add-cat") {
        const name = fval("f-newcat");
        if (!name) return setModalError("Informe o nome do novo tipo.");
        const order = Math.max(0, ...fin.cats.map((c) => c.sort_order)) + 10;
        const { error } = await sb.from("fin_categories").insert({ name, sort_order: order });
        if (error) throw error;
      } else if (act === "save-cat") {
        const row = btn.closest("[data-catrow]");
        const name = row.querySelector("[data-cat-name]").value.trim();
        if (!name) return setModalError("O nome do tipo não pode ficar vazio.");
        const order = Number(row.querySelector("[data-cat-order]").value) || 0;
        const { error } = await sb.from("fin_categories").update({ name, sort_order: order, active: row.querySelector("[data-cat-active]").checked }).eq("id", id);
        if (error) throw error;
      } else if (act === "delete-cat") {
        const { error } = await sb.from("fin_categories").delete().eq("id", id);
        if (error) throw error;
      }
      setModalError(null);
      await reloadAndRender();
      flash("Tipos de despesa atualizados.");
    } catch (e) {
      setModalError("Não foi possível concluir: " + friendlyError(e));
    }
  }

  // --------------------------------------------------------------------------
  // Eventos
  // --------------------------------------------------------------------------

  function setMonth(m) {
    fin.month = Math.min(12, Math.max(1, m));
    renderBody();
  }

  async function changeYear(y) {
    fin.year = y;
    fin.ready = false;
    $("fin-body").innerHTML = `<p class="text-sm text-brand-slate">Carregando…</p>`;
    await loadData();
    fin.ready = true;
    renderYearOptions();
    renderBody();
  }

  function wire(root) {
    const wrap = (p) => Promise.resolve(p).catch((err) => flash("Erro: " + friendlyError(err), "error"));
    root.addEventListener("click", (e) => {
      const t = e.target.closest("[data-fin]");
      if (!t || !root.contains(t)) return;
      const act = t.dataset.fin;
      const id = t.dataset.id ? Number(t.dataset.id) : null;
      switch (act) {
        case "tab": fin.tab = t.dataset.tab; renderTabs(); renderBody(); break;
        case "refresh": wrap(reloadAndRender().then(() => flash("Dados atualizados."))); break;
        case "month-prev": setMonth(fin.month - 1); break;
        case "month-next": setMonth(fin.month + 1); break;
        case "kind": fin.kind = t.dataset.kind; renderBody(); break;
        case "new-rev": openModal("rev"); break;
        case "edit-rev": openModal("rev", id); break;
        case "new-exp": openModal("exp"); break;
        case "edit-exp": openModal("exp", id); break;
        case "edit-month": openModal("month", null, { month: t.dataset.month ? Number(t.dataset.month) : fin.month }); break;
        case "edit-yeargoal": openModal("yeargoal"); break;
        case "edit-taxrate": openModal("taxrate"); break;
        case "new-dist": openModal("dist"); break;
        case "edit-dist": openModal("dist", id); break;
        case "new-res": openModal("res"); break;
        case "edit-res": openModal("res", id); break;
        case "new-bonus": openModal("bonus"); break;
        case "edit-bonus": openModal("bonus", id); break;
        case "edit-cats": openModal("cats"); break;
        case "modal-close": closeModal(); break;
        case "modal-save": wrap(saveModal()); break;
        case "modal-ask-delete": fin.modal.confirmDelete = true; renderModalHost(); break;
        case "modal-cancel-delete": fin.modal.confirmDelete = false; renderModalHost(); break;
        case "modal-delete": wrap(deleteModal()); break;
        case "save-proj": wrap(saveProjections()); break;
        case "toggle-nf": wrap(quickToggle("nf", id, t)); break;
        case "toggle-recv": wrap(quickToggle("recv", id, t)); break;
        case "toggle-paid": wrap(quickToggle("paid", id, t)); break;
        case "undo": wrap(undoToggle()); break;
        case "copy-exp": wrap(copyExpenses()); break;
        case "add-cat": case "save-cat": case "delete-cat": catAction(act, id, t); break;
        default: break;
      }
    });
    root.addEventListener("change", (e) => {
      const t = e.target;
      if (t.id === "fin-year") wrap(changeYear(Number(t.value)));
      else if (t.id === "fin-month") setMonth(Number(t.value));
      else if (t.id === "f-reimbursable") { $("f-paidby-wrap")?.classList.toggle("hidden", !t.checked); if (t.checked) $("f-paidby")?.focus(); }
      else if (t.id === "fin-bonus-period") { fin.bonusPeriod = t.value; renderBody(); }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && fin.modal && !$("fin-root")?.closest(".hidden")) closeModal();
    });
  }

  // --------------------------------------------------------------------------
  // Entrada
  // --------------------------------------------------------------------------

  async function renderFinance() {
    const root = $("fin-root");
    if (!root) return;
    if (!isAdmin()) {
      root.innerHTML = `<div class="card text-sm text-brand-slate">Esta área é restrita a administradores.</div>`;
      return;
    }
    if (!fin.wired) {
      root.innerHTML = shellHtml();
      wire(root);
      fin.wired = true;
    }
    const token = ++fin.token;
    renderYearOptions();
    renderTabs();
    if (!fin.ready) $("fin-body").innerHTML = `<p class="text-sm text-brand-slate">Carregando…</p>`;
    try {
      await loadData();
    } catch (e) {
      if (token === fin.token) {
        $("fin-body").innerHTML = "";
        flash("Não foi possível carregar o Financeiro: " + friendlyError(e), "error");
      }
      return;
    }
    if (token !== fin.token) return;
    fin.ready = true;
    renderYearOptions();
    renderBody();
  }

  // O botão da home só é criado para administradores (para os demais ele nem existe na página).
  function setupFinanceTile() {
    if (!isAdmin() || $("tile-financeiro")) return;
    const ref = $("tile-comercial") || document.querySelector('.tile[data-goto="pedidos"]');
    if (!ref || !ref.parentNode) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = "tile-financeiro";
    btn.className = "tile";
    // Sem data-goto de propósito: o botão pode ser criado depois de o app ligar os cliques da navegação.
    btn.addEventListener("click", () => {
      // Ao abrir pelo botão, sempre começa no mês atual (aba Mês).
      const d = new Date();
      fin.year = d.getFullYear();
      fin.month = d.getMonth() + 1;
      fin.tab = "mes";
      goToPanel("financeiro");
    });
    btn.innerHTML = `
      <span class="tile-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M14.8 9.2c-.5-.8-1.5-1.2-2.8-1.2-1.6 0-2.7.8-2.7 2 0 2.8 5.6 1.4 5.6 4.2 0 1.2-1.2 2-2.9 2-1.3 0-2.4-.5-3-1.4M12 6.5V8m0 8v1.5"/></svg>
      </span>
      <span class="tile-title">Financeiro</span>
      <span class="tile-desc">Receitas, despesas, metas e bônus</span>`;
    ref.after(btn);
  }

  window.setupFinanceTile = setupFinanceTile;
  window.renderFinance = renderFinance;
  try {
    if (typeof currentProfile !== "undefined" && currentProfile) setupFinanceTile();
  } catch (e) {}
})();
