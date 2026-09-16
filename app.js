// ============================================================================
// Hub Feijó Souza — lógica principal (vanilla JS + Supabase)
// ============================================================================

const cfg = window.HUB_CONFIG;
const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

document.getElementById("login-office-name").textContent = `Hub ${cfg.OFFICE_NAME}`;
document.getElementById("app-office-name").textContent = `Hub ${cfg.OFFICE_NAME}`;

let currentUser = null;
let currentProfile = null;

const WEEKDAY_LABELS = ["Seg", "Ter", "Qua", "Qui", "Sex"];
const PERIOD_LABELS = { manha: "Manhã", tarde: "Tarde", dia: "Dia" };
const WEEKLY_PERIOD_QUOTA = 4; // 4 períodos = 2 dias inteiros por semana (advogados)

// Um dia conta como "inteiro" se tiver manhã + tarde (advogados) ou o
// período único "dia" (estagiárias, que só trabalham meio período mesmo).
function isFullDayPeriods(periods) {
  return periods.includes("dia") || (periods.includes("manha") && periods.includes("tarde"));
}

// ----------------------------------------------------------------------------
// Auth
// ----------------------------------------------------------------------------

document.getElementById("btn-login").addEventListener("click", async () => {
  const { error } = await sb.auth.signInWithOAuth({
    provider: "azure",
    options: {
      redirectTo: window.location.origin + window.location.pathname,
      scopes: "openid profile email",
    },
  });
  if (error) showLoginError(error.message);
});

document.getElementById("btn-logout").addEventListener("click", async () => {
  await sb.auth.signOut();
  window.location.reload();
});

function showLoginError(msg) {
  const el = document.getElementById("login-error");
  el.textContent = msg;
  el.classList.remove("hidden");
}

// Depois do login via Microsoft, o Supabase processa o token de acesso que
// vem no fragmento da URL (#access_token=...&...). Esse token não deveria
// ficar visível na barra de endereço depois de processado — limpamos o hash
// manualmente por segurança, já que em alguns fluxos de reload/redirect ele
// não é removido sozinho.
function cleanAuthHashFromUrl() {
  if (window.location.hash && /access_token|refresh_token|provider_token/.test(window.location.hash)) {
    window.history.replaceState(null, document.title, window.location.pathname + window.location.search);
  }
}

async function boot() {
  const { data } = await sb.auth.getSession();
  cleanAuthHashFromUrl();
  if (data.session) {
    await enterApp(data.session.user);
  } else {
    document.getElementById("login-screen").classList.remove("hidden");
    document.getElementById("app-screen").classList.add("hidden");
  }
}

async function enterApp(user) {
  currentUser = user;
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("app-screen").classList.remove("hidden");

  currentProfile = await ensureProfileLoaded(user);

  document.getElementById("welcome-msg").textContent =
    `Olá, ${currentProfile?.full_name || user.email}`;

  setupNav();
  // Carrega os feriados extras (recesso, municipais) ANTES de tudo o que
  // depende de contar dias úteis (dashboard, férias, saldo do perfil).
  await loadHolidays();
  await Promise.all([
    loadDashboardSummary(),
    loadHomeOffice(),
    loadBirthdays(),
    loadAnnouncements(),
    loadVacations(),
    loadInternSchedule(),
    loadManuals(),
    loadProfileTab(),
  ]);
}

async function ensureProfileLoaded(user) {
  // O gatilho do banco cria o perfil no primeiro login; pode haver uma
  // pequena corrida — tentamos algumas vezes antes de desistir.
  for (let i = 0; i < 5; i++) {
    const { data } = await sb.from("profiles").select("*").eq("id", user.id).maybeSingle();
    if (data) return data;
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

// ----------------------------------------------------------------------------
// Navegação (landing page + telas em "quadrados")
// ----------------------------------------------------------------------------

function setupNav() {
  document.querySelectorAll("[data-goto]").forEach((el) => {
    el.addEventListener("click", () => goToPanel(el.dataset.goto));
  });
}

function goToPanel(key) {
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
  const panel = document.getElementById(`panel-${key}`);
  if (panel) panel.classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ----------------------------------------------------------------------------
// Utilidades
// ----------------------------------------------------------------------------

function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function getMondayOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0=domingo, 1=segunda...
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function getWeekDates(weekOffset = 0) {
  const monday = getMondayOfWeek(new Date());
  monday.setDate(monday.getDate() + weekOffset * 7);
  const dates = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    dates.push(d);
  }
  return dates;
}

function formatDateBR(iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

// dias restantes até a próxima ocorrência do mês/dia de `iso`, ignorando o ano
function daysUntilNextOccurrence(iso) {
  if (!iso) return null;
  const [, m, d] = iso.split("-").map(Number);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let next = new Date(today.getFullYear(), m - 1, d);
  if (next < today) next = new Date(today.getFullYear() + 1, m - 1, d);
  const diffDays = Math.round((next - today) / (1000 * 60 * 60 * 24));
  return diffDays;
}

function addDaysISO(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  return toISODate(date);
}

// Soma meses a uma data ISO (usado no cálculo do período aquisitivo de
// férias: vesting = admissão + 6 meses; 1 ano de casa = admissão + 12 meses).
function addMonthsISO(iso, months) {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  date.setMonth(date.getMonth() + months);
  return toISODate(date);
}

// Número de meses de calendário inteiros entre duas datas ISO (a >= b),
// contando só ano/mês (ignora o dia). Usado para saber quantos meses
// "cheios" faltam de um mês até dezembro do mesmo ano, por exemplo.
function monthDiffISO(fromIso, toIso) {
  const [fy, fm] = fromIso.split("-").map(Number);
  const [ty, tm] = toIso.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

function mondayOfISOWeek(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return toISODate(getMondayOfWeek(new Date(y, m - 1, d)));
}

function formatWeekRange(weekStartIso) {
  if (!weekStartIso) return "Semana não informada";
  const endIso = addDaysISO(weekStartIso, 4);
  return `Semana de ${formatDateBR(weekStartIso)} a ${formatDateBR(endIso)}`;
}

// A escala dos estagiários passou a ser quinzenal a partir do rodízio de
// 14/09/2026 (antes disso era semanal). Os rodízios seguintes caem a cada 14
// dias a partir desse marco: 28/09, 12/10, 26/10, etc.
const INTERN_ROTATION_ANCHOR_ISO = "2026-09-14";

// Dado um ISO qualquer, encontra a segunda-feira de início da quinzena de
// rodízio que o contém, alinhada ao marco acima (funciona também para datas
// anteriores ao marco, projetando o ciclo de 14 em 14 dias para trás).
function internRotationStartForDate(iso) {
  const anchor = new Date(INTERN_ROTATION_ANCHOR_ISO + "T00:00:00");
  const target = new Date(iso + "T00:00:00");
  const diffDays = Math.round((target - anchor) / 86400000);
  const periodIndex = Math.floor(diffDays / 14);
  const start = new Date(anchor);
  start.setDate(start.getDate() + periodIndex * 14);
  return toISODate(start);
}

// Data padrão a sugerir no formulário de nova alocação: a quinzena de
// rodízio corrente (ou, antes de 14/09/2026, já o primeiro rodízio quinzenal).
function defaultInternRotationStartIso() {
  const todayIso = toISODate(new Date());
  return todayIso < INTERN_ROTATION_ANCHOR_ISO
    ? INTERN_ROTATION_ANCHOR_ISO
    : internRotationStartForDate(todayIso);
}

// Mostra o período de uma alocação de estagiário(a): quinzena (Segunda a
// Sexta da 2ª semana) para rodízios a partir de 14/09/2026, ou semana (como
// era antes) para alocações mais antigas — para não rotular errado o
// histórico anterior à mudança para o rodízio quinzenal.
function formatInternPeriodRange(startIso) {
  if (!startIso) return "Período não informado";
  if (startIso >= INTERN_ROTATION_ANCHOR_ISO) {
    const endIso = addDaysISO(startIso, 11);
    return `Quinzena de ${formatDateBR(startIso)} a ${formatDateBR(endIso)}`;
  }
  return formatWeekRange(startIso);
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Botão "Carregar mais" compartilhado pelas listas com paginação.
function updateLoadMoreButton(id, show, onClick) {
  const btn = document.getElementById(id);
  if (!btn) return;
  if (show) {
    btn.classList.remove("hidden");
    btn.onclick = onClick;
  } else {
    btn.classList.add("hidden");
  }
}

// Atrasa a execução de `fn` até `delay`ms depois da última chamada — usado
// nos campos de busca para não disparar uma consulta ao banco a cada tecla
// digitada, só depois que a pessoa parar de digitar por um instante.
function debounce(fn, delay = 300) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function formatDateTimeBR(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const date = d.toLocaleDateString("pt-BR");
  const time = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return `${date} às ${time}`;
}

// ----------------------------------------------------------------------------
// Dias úteis / feriados nacionais (para o cálculo de férias)
// ----------------------------------------------------------------------------

// Data da Páscoa (algoritmo de Meeus/Jones/Butcher)
function easterDateForYear(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

// Feriados nacionais com nome (usado no calendário exibido na aba Férias —
// nomes de verdade em vez de um rótulo genérico deixam a lista muito mais
// fácil de ler). getBrazilHolidays() abaixo usa isto por baixo dos panos
// para o Set de datas usado nos cálculos de dias úteis.
function getBrazilHolidayEntries(year) {
  const fixed = [
    [1, 1, "Confraternização Universal"],
    [4, 21, "Tiradentes"],
    [5, 1, "Dia do Trabalho"],
    [9, 7, "Independência do Brasil"],
    [10, 12, "Nossa Senhora Aparecida"],
    [11, 2, "Finados"],
    [11, 15, "Proclamação da República"],
    [11, 20, "Consciência Negra"],
    [12, 25, "Natal"],
  ];
  const entries = fixed.map(([m, d, name]) => ({ date: toISODate(new Date(year, m - 1, d)), name }));

  const easter = easterDateForYear(year);
  const offset = (days) => {
    const d = new Date(easter);
    d.setDate(d.getDate() + days);
    return toISODate(d);
  };
  entries.push({ date: offset(-48), name: "Segunda de Carnaval" });
  entries.push({ date: offset(-47), name: "Terça de Carnaval" });
  entries.push({ date: offset(-2), name: "Sexta-feira Santa" });
  entries.push({ date: offset(60), name: "Corpus Christi" });

  return entries;
}

function getBrazilHolidays(year) {
  return new Set(getBrazilHolidayEntries(year).map((e) => e.date));
}

// Feriados/recessos ADICIONAIS ao calendário nacional (tabela public.holidays
// — recesso de fim de ano, feriados municipais etc.), carregados do banco no
// boot por loadHolidays(). countBusinessDays() e isHoliday() já consideram
// este conjunto automaticamente assim que ele é preenchido.
let extraHolidays = new Set();

function isHoliday(iso, year) {
  return getBrazilHolidays(year).has(iso) || extraHolidays.has(iso);
}

// Conta os dias úteis entre duas datas ISO (inclusive), excluindo fins de
// semana, feriados nacionais e feriados/recessos extras cadastrados no hub.
function countBusinessDays(startIso, endIso) {
  if (!startIso || !endIso || endIso < startIso) return 0;
  const [sy, sm, sd] = startIso.split("-").map(Number);
  const [ey, em, ed] = endIso.split("-").map(Number);
  const cur = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  let count = 0;
  while (cur <= end) {
    const year = cur.getFullYear();
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6 && !isHoliday(toISODate(cur), year)) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

function formatBusinessDays(days) {
  return days === 1 ? "1 dia útil" : `${days} dias úteis`;
}

// Carrega os feriados/recessos extras cadastrados no hub (tabela
// public.holidays) e preenche o conjunto `extraHolidays` usado por
// isHoliday()/countBusinessDays(). Chamado uma vez no boot (enterApp),
// antes de qualquer cálculo de dias úteis ou saldo de férias.
let holidaysCache = [];

async function loadHolidays() {
  const { data, error } = await sb.from("holidays").select("*").order("date", { ascending: true });
  if (error) {
    console.error("Erro ao carregar feriados extras:", error);
    return;
  }
  holidaysCache = data || [];
  extraHolidays = new Set(holidaysCache.map((h) => h.date));
  renderHolidaysCalendar();
}

// ----------------------------------------------------------------------------
// Cálculo automático do saldo de férias
// ----------------------------------------------------------------------------
//
// Regras confirmadas com o escritório:
// - 22 dias úteis de férias por ano (proporcional a 22/12 dias úteis por mês
//   completo, durante o período de transição do primeiro ano).
// - Período aquisitivo de 6 meses: antes disso, saldo é 0.
// - Ao completar 6 meses (data de vesting), a pessoa passa a ter direito aos
//   dias proporcionais remanescentes daquele ano civil (meses restantes até
//   dezembro, incluindo o mês do vesting, × 22/12).
// - Enquanto a pessoa ainda não completou 1 ano de casa em 1º de janeiro de
//   um ano seguinte, o saldo NÃO reseta: os 22 dias daquele ano se somam ao
//   saldo remanescente (acúmulo/carry-over).
// - A partir do 1º de janeiro em que a pessoa já tem mais de 1 ano de casa,
//   o saldo é zerado e resetado para 22 dias úteis todo santo 1º de janeiro
//   (independentemente do saldo anterior).
// - Dias de férias já tirados (registrados em public.vacations) são
//   descontados do saldo a partir do ponto de início da contagem corrente.
const VACATION_ANNUAL_DAYS = 22;
const VACATION_MONTHLY_RATE = VACATION_ANNUAL_DAYS / 12;
const VACATION_VESTING_MONTHS = 6;
const VACATION_FULL_YEAR_MONTHS = 12;

// hireDateIso: data de admissão (ISO). vacations: array de { start_date, end_date }
// (já tiradas/registradas). todayIso: data de referência (ISO), normalmente hoje.
// Retorna o saldo em dias úteis (número, arredondado a 1 casa decimal), ou
// null se não for possível calcular (sem data de admissão).
function calcVacationBalance(hireDateIso, vacations, todayIso) {
  if (!hireDateIso) return null;
  const today = todayIso || toISODate(new Date());

  const vestingDateIso = addMonthsISO(hireDateIso, VACATION_VESTING_MONTHS);
  if (today < vestingDateIso) return 0; // ainda no período aquisitivo

  const oneYearDateIso = addMonthsISO(hireDateIso, VACATION_FULL_YEAR_MONTHS);
  const vestingYear = Number(vestingDateIso.split("-")[0]);

  // Primeiro trecho (parcial): meses restantes do ano do vesting (incluindo
  // o próprio mês do vesting) × 22/12, arredondado para cima — não faz
  // sentido fração de dia de férias.
  const endOfVestingYear = `${vestingYear}-12-31`;
  let balance = Math.ceil((monthDiffISO(vestingDateIso, endOfVestingYear) + 1) * VACATION_MONTHLY_RATE);
  let startPointIso = vestingDateIso;

  const todayYear = Number(today.split("-")[0]);
  for (let y = vestingYear + 1; y <= todayYear; y++) {
    const jan1 = `${y}-01-01`;
    const hasFullYearByJan1 = jan1 >= oneYearDateIso;
    if (hasFullYearByJan1) {
      balance = VACATION_ANNUAL_DAYS; // zera tudo em 31/12, reseta 22 em 01/01
      startPointIso = jan1;
    } else {
      balance += VACATION_ANNUAL_DAYS; // ainda no 1º ano: acumula/carrega
    }
  }

  const usedDays = (vacations || [])
    .filter((v) => v.end_date >= startPointIso)
    .reduce((sum, v) => {
      const start = v.start_date > startPointIso ? v.start_date : startPointIso;
      return sum + countBusinessDays(start, v.end_date);
    }, 0);

  return balance - usedDays;
}

// ----------------------------------------------------------------------------
// Página inicial (resumo do dia)
// ----------------------------------------------------------------------------

async function loadDashboardSummary() {
  const todayISO = toISODate(new Date());

  document.getElementById("summary-date-label").textContent =
    `Hoje, ${formatDateBR(todayISO).slice(0, 5)}`;

  const [{ data: profiles }, { data: entries }, { data: birthProfiles }, { data: announcements }, { data: vacations }] =
    await Promise.all([
      sb.from("profiles").select("id, full_name, email"),
      sb.from("homeoffice_entries").select("user_id, period").eq("entry_date", todayISO),
      sb.from("profiles").select("full_name, email, birth_date").not("birth_date", "is", null),
      sb.from("announcements").select("title, body, created_at").order("created_at", { ascending: false }).limit(1),
      // Próxima (ou atual) férias de qualquer pessoa da equipe: qualquer período
      // que ainda não tenha terminado, o mais próximo de começar primeiro.
      sb
        .from("vacations")
        .select("user_id, start_date, end_date, profiles(full_name, email)")
        .gte("end_date", todayISO)
        .order("start_date", { ascending: true })
        .limit(1),
    ]);

  const periodsByUser = {};
  (entries || []).forEach((e) => {
    if (!periodsByUser[e.user_id]) periodsByUser[e.user_id] = [];
    periodsByUser[e.user_id].push(e.period);
  });

  const names = Object.keys(periodsByUser)
    .map((uid) => {
      const p = (profiles || []).find((pp) => pp.id === uid);
      if (!p) return null;
      const periods = periodsByUser[uid];
      const suffix = isFullDayPeriods(periods) ? "" : ` (${PERIOD_LABELS[periods[0]]})`;
      return `${p.full_name || p.email}${suffix}`;
    })
    .filter(Boolean);

  document.getElementById("summary-homeoffice-count").textContent =
    names.length === 0 ? "Ninguém hoje" : `${names.length} em home office`;
  document.getElementById("summary-homeoffice-names").textContent = names.join(", ");

  const withDays = (birthProfiles || [])
    .map((p) => ({ ...p, daysUntil: daysUntilNextOccurrence(p.birth_date) }))
    .sort((a, b) => a.daysUntil - b.daysUntil);

  if (withDays.length > 0) {
    const next = withDays[0];
    document.getElementById("summary-birthday-name").textContent = next.full_name || next.email;
    document.getElementById("summary-birthday-sub").textContent =
      next.daysUntil === 0
        ? "🎉 É hoje!"
        : `em ${next.daysUntil} dia${next.daysUntil === 1 ? "" : "s"} (${formatDateBR(next.birth_date).slice(0, 5)})`;
  } else {
    document.getElementById("summary-birthday-name").textContent = "—";
    document.getElementById("summary-birthday-sub").textContent = "Ninguém cadastrou ainda";
  }

  const latest = (announcements || [])[0];
  if (latest) {
    document.getElementById("summary-announcement-title").textContent = latest.title;
    document.getElementById("summary-announcement-sub").textContent =
      latest.body.length > 60 ? latest.body.slice(0, 60) + "…" : latest.body;
  } else {
    document.getElementById("summary-announcement-title").textContent = "—";
    document.getElementById("summary-announcement-sub").textContent = "Nenhum aviso publicado ainda";
  }

  const nextVacation = (vacations || [])[0];
  if (nextVacation) {
    const name = nextVacation.profiles?.full_name || nextVacation.profiles?.email || "—";
    const period = `De ${formatDateBR(nextVacation.start_date)} a ${formatDateBR(nextVacation.end_date)}`;
    document.getElementById("summary-vacation-name").textContent = name;
    document.getElementById("summary-vacation-sub").textContent =
      nextVacation.start_date <= todayISO ? `${period} (em curso)` : period;
  } else {
    document.getElementById("summary-vacation-name").textContent = "—";
    document.getElementById("summary-vacation-sub").textContent = "Nenhuma férias agendada";
  }
}

// ----------------------------------------------------------------------------
// Home office
// ----------------------------------------------------------------------------

// 0 = semana atual, 1 = semana seguinte. Por enquanto só permitimos
// navegar até a semana seguinte (não há necessidade de ir mais além nem
// de voltar a semanas passadas nesta tela).
let homeOfficeWeekOffset = 0;
const HOME_OFFICE_MAX_WEEK_OFFSET = 1;

async function loadHomeOffice() {
  const weekDates = getWeekDates(homeOfficeWeekOffset);
  const isoDates = weekDates.map(toISODate);

  document.getElementById("week-range").textContent =
    `Semana de ${formatDateBR(isoDates[0])} a ${formatDateBR(isoDates[4])}` +
    (homeOfficeWeekOffset === 0 ? " (semana atual)" : " (semana seguinte)");

  updateHomeOfficeWeekNav();

  const [{ data: profiles }, { data: entries }] = await Promise.all([
    sb.from("profiles").select("id, full_name, email").order("full_name"),
    sb.from("homeoffice_entries").select("user_id, entry_date, period, created_at").in("entry_date", isoDates),
  ]);

  renderMyWeekToggles(isoDates, entries || []);
  renderTeamWeekTable(weekDates, profiles || [], entries || []);
  renderHomeOfficeAdminLog(weekDates, profiles || [], entries || []);
}

function updateHomeOfficeWeekNav() {
  const prevBtn = document.getElementById("btn-week-prev");
  const nextBtn = document.getElementById("btn-week-next");
  if (prevBtn) prevBtn.classList.toggle("hidden", homeOfficeWeekOffset <= 0);
  if (nextBtn) nextBtn.classList.toggle("hidden", homeOfficeWeekOffset >= HOME_OFFICE_MAX_WEEK_OFFSET);
}

document.getElementById("btn-week-prev")?.addEventListener("click", () => {
  if (homeOfficeWeekOffset > 0) {
    homeOfficeWeekOffset -= 1;
    loadHomeOffice();
  }
});

document.getElementById("btn-week-next")?.addEventListener("click", () => {
  if (homeOfficeWeekOffset < HOME_OFFICE_MAX_WEEK_OFFSET) {
    homeOfficeWeekOffset += 1;
    loadHomeOffice();
  }
});

function renderMyWeekToggles(isoDates, entries) {
  const container = document.getElementById("my-week-days");
  container.innerHTML = "";

  const isIntern = !!currentProfile?.is_intern;
  const instructionsEl = document.getElementById("homeoffice-instructions");
  const subInstructionsEl = document.getElementById("homeoffice-subinstructions");
  const quotaLabel = document.getElementById("week-quota-label");

  const myEntries = entries.filter((e) => e.user_id === currentUser.id);
  const myEntrySet = new Set(myEntries.map((e) => `${e.entry_date}|${e.period}`));

  if (isIntern) {
    // Estagiárias trabalham só meio período por dia: um toggle único por
    // dia (período "dia"), sem distinção manhã/tarde e sem limite semanal.
    if (instructionsEl) instructionsEl.textContent = "Marque os dias em que você fará home office esta semana:";
    if (subInstructionsEl) subInstructionsEl.textContent = "";

    isoDates.forEach((iso, i) => {
      const key = `${iso}|dia`;
      const active = myEntrySet.has(key);
      const btn = document.createElement("button");
      btn.className = "day-toggle" + (active ? " active" : "");
      btn.textContent = `${WEEKDAY_LABELS[i]} ${formatDateBR(iso).slice(0, 5)}`;
      btn.addEventListener("click", async () => {
        if (active) {
          const { error } = await sb
            .from("homeoffice_entries")
            .delete()
            .eq("user_id", currentUser.id)
            .eq("entry_date", iso)
            .eq("period", "dia");
          if (error) {
            alert("Erro ao desmarcar o dia: " + error.message);
            return;
          }
        } else {
          const { error } = await sb.from("homeoffice_entries").insert({ user_id: currentUser.id, entry_date: iso, period: "dia" });
          if (error) {
            alert("Erro ao marcar o dia: " + error.message);
            return;
          }
        }
        await Promise.all([loadHomeOffice(), loadDashboardSummary()]);
      });
      container.appendChild(btn);
    });

    if (quotaLabel) quotaLabel.textContent = "";
    return;
  }

  if (instructionsEl) {
    instructionsEl.textContent = "Marque os períodos (manhã/tarde) em que você fará home office esta semana:";
  }
  if (subInstructionsEl) {
    subInstructionsEl.textContent = "Máximo de 4 períodos por semana (equivalente a 2 dias inteiros).";
  }

  isoDates.forEach((iso, i) => {
    const dayWrap = document.createElement("div");
    dayWrap.className = "flex flex-col items-center gap-1.5";

    const label = document.createElement("p");
    label.className = "text-xs text-brand-slate";
    label.textContent = `${WEEKDAY_LABELS[i]} ${formatDateBR(iso).slice(0, 5)}`;
    dayWrap.appendChild(label);

    const periodRow = document.createElement("div");
    periodRow.className = "flex flex-col gap-1";

    ["manha", "tarde"].forEach((period) => {
      const key = `${iso}|${period}`;
      const active = myEntrySet.has(key);
      const btn = document.createElement("button");
      btn.className = "day-toggle" + (active ? " active" : "");
      btn.textContent = PERIOD_LABELS[period];
      btn.addEventListener("click", async () => {
        if (active) {
          const { error } = await sb
            .from("homeoffice_entries")
            .delete()
            .eq("user_id", currentUser.id)
            .eq("entry_date", iso)
            .eq("period", period);
          if (error) {
            alert("Erro ao desmarcar o período: " + error.message);
            return;
          }
        } else {
          if (myEntrySet.size >= WEEKLY_PERIOD_QUOTA) {
            alert(
              `Você já atingiu o limite de ${WEEKLY_PERIOD_QUOTA} períodos (2 dias inteiros) de home office nesta semana.`
            );
            return;
          }
          const { error } = await sb.from("homeoffice_entries").insert({ user_id: currentUser.id, entry_date: iso, period });
          if (error) {
            alert("Erro ao marcar o período: " + error.message);
            return;
          }
        }
        await Promise.all([loadHomeOffice(), loadDashboardSummary()]);
      });
      periodRow.appendChild(btn);
    });

    dayWrap.appendChild(periodRow);
    container.appendChild(dayWrap);
  });

  if (quotaLabel) {
    quotaLabel.textContent = `${myEntrySet.size} de ${WEEKLY_PERIOD_QUOTA} períodos usados nesta semana (equivalente a até 2 dias inteiros).`;
  }
}

function renderTeamWeekTable(weekDates, profiles, entries) {
  const header = document.getElementById("team-week-header");
  header.innerHTML =
    "<th class='py-2 pr-4'>Pessoa</th>" +
    weekDates.map((d, i) => `<th class='py-2 px-2 text-center'>${WEEKDAY_LABELS[i]}<br/><span class="text-xs">${formatDateBR(toISODate(d)).slice(0, 5)}</span></th>`).join("");

  const isoDates = weekDates.map(toISODate);
  const body = document.getElementById("team-week-body");
  body.innerHTML = "";

  profiles.forEach((p) => {
    const row = document.createElement("tr");
    row.className = "border-b border-slate-50";
    const nameCell = `<td class="py-2 pr-4 font-medium">${escapeHtml(p.full_name || p.email)}</td>`;
    const dayCells = isoDates
      .map((iso) => {
        const periods = entries.filter((e) => e.user_id === p.id && e.entry_date === iso).map((e) => e.period);
        let text = "";
        if (isFullDayPeriods(periods)) text = "🏠";
        else if (periods.includes("manha")) text = "Manhã";
        else if (periods.includes("tarde")) text = "Tarde";
        return `<td class="py-2 px-2 text-center text-xs">${text}</td>`;
      })
      .join("");
    row.innerHTML = nameCell + dayCells;
    body.appendChild(row);
  });
}

// Somente administradores: mostra QUANDO cada pessoa marcou cada dia/período
// de home office (data/hora do clique), para a semana atualmente exibida —
// não é visível para quem não é admin, embora a RLS já permita a qualquer
// pessoa autenticada ler a escala (assim como as outras seções admin do hub).
function renderHomeOfficeAdminLog(weekDates, profiles, entries) {
  const container = document.getElementById("homeoffice-admin-log");
  if (!container) return;

  if (!currentProfile?.is_admin) {
    container.classList.add("hidden");
    container.innerHTML = "";
    return;
  }
  container.classList.remove("hidden");

  const isoDates = weekDates.map(toISODate);
  const dayIndexByIso = Object.fromEntries(isoDates.map((iso, i) => [iso, i]));

  const rows = entries
    .slice()
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .map((e) => {
      const p = profiles.find((pp) => pp.id === e.user_id);
      const name = p ? p.full_name || p.email : "—";
      const dayIdx = dayIndexByIso[e.entry_date];
      const dayLabel =
        dayIdx !== undefined
          ? `${WEEKDAY_LABELS[dayIdx]} ${formatDateBR(e.entry_date).slice(0, 5)}`
          : formatDateBR(e.entry_date);
      const periodLabel = e.period === "dia" ? "" : ` (${PERIOD_LABELS[e.period]})`;
      return `
        <div class="flex items-center justify-between gap-4 py-2 border-b border-slate-50 last:border-0">
          <p class="text-sm min-w-0"><span class="font-medium">${escapeHtml(name)}</span> marcou ${dayLabel}${periodLabel}</p>
          <p class="text-xs text-brand-mist shrink-0">${formatDateTimeBR(e.created_at)}</p>
        </div>
      `;
    });

  container.innerHTML = `
    <p class="text-sm font-medium mb-1">Quando cada pessoa marcou (somente administradores)</p>
    <p class="text-xs text-brand-mist mb-3">Data e hora em que cada marcação foi feita, para a semana exibida acima.</p>
    ${rows.length ? rows.join("") : `<p class="text-sm text-slate-400">Ninguém marcou home office nesta semana ainda.</p>`}
  `;
}

// ----------------------------------------------------------------------------
// Aniversários da equipe
// ----------------------------------------------------------------------------

async function loadBirthdays() {
  document.getElementById("my-birth-date").value = currentProfile?.birth_date || "";

  document.getElementById("btn-save-birth-date").onclick = async () => {
    const value = document.getElementById("my-birth-date").value;
    if (!value) return;
    const { error } = await sb.from("profiles").update({ birth_date: value }).eq("id", currentUser.id);
    if (error) {
      alert("Erro ao salvar sua data de nascimento: " + error.message);
      return;
    }
    currentProfile.birth_date = value;
    const msg = document.getElementById("birth-date-saved-msg");
    msg.classList.remove("hidden");
    setTimeout(() => msg.classList.add("hidden"), 2000);
    await Promise.all([loadBirthdays(), loadDashboardSummary()]);
  };

  const { data: profiles, error } = await sb
    .from("profiles")
    .select("id, full_name, email, birth_date")
    .not("birth_date", "is", null);

  const list = document.getElementById("birthdays-list");

  if (error) {
    list.innerHTML = `<p class="p-5 text-sm text-red-500">Erro ao carregar aniversários: ${escapeHtml(error.message)}</p>`;
    return;
  }

  const withDays = (profiles || [])
    .map((p) => ({ ...p, daysUntil: daysUntilNextOccurrence(p.birth_date) }))
    .sort((a, b) => a.daysUntil - b.daysUntil);

  list.innerHTML = "";

  if (withDays.length === 0) {
    list.innerHTML = `<p class="p-5 text-sm text-slate-400">Ninguém cadastrou a data de nascimento ainda.</p>`;
    return;
  }

  withDays.forEach((p) => {
    const badge =
      p.daysUntil === 0
        ? `<span class="text-sm bg-amber-100 text-amber-700 rounded-full px-3 py-1">🎉 Hoje!</span>`
        : `<span class="text-sm text-slate-400">em ${p.daysUntil} dia${p.daysUntil === 1 ? "" : "s"}</span>`;
    const row = document.createElement("div");
    row.className = "flex items-center justify-between p-4";
    row.innerHTML = `
      <div>
        <p class="font-medium">${escapeHtml(p.full_name || p.email)}</p>
        <p class="text-sm text-slate-500">${formatDateBR(p.birth_date).slice(0, 5)}</p>
      </div>
      ${badge}
    `;
    list.appendChild(row);
  });
}

// ----------------------------------------------------------------------------
// Avisos
// ----------------------------------------------------------------------------

let announcementsSearch = "";
let announcementsLimit = 10;

async function loadAnnouncements() {
  const addBox = document.getElementById("admin-add-announcement-box");
  if (currentProfile?.is_admin) {
    addBox.classList.remove("hidden");
    document.getElementById("btn-add-announcement").onclick = async () => {
      const title = document.getElementById("announcement-title").value.trim();
      const body = document.getElementById("announcement-body").value.trim();
      const errorEl = document.getElementById("announcement-error");
      if (errorEl) errorEl.classList.add("hidden");
      if (!title || !body) return;

      const { error } = await sb.from("announcements").insert({ title, body, created_by: currentUser.id });
      if (error) {
        if (errorEl) {
          errorEl.textContent = "Erro ao publicar: " + error.message;
          errorEl.classList.remove("hidden");
        } else {
          alert("Erro ao publicar: " + error.message);
        }
        return;
      }

      document.getElementById("announcement-title").value = "";
      document.getElementById("announcement-body").value = "";
      announcementsLimit = 10;
      await Promise.all([renderAnnouncementsList(), loadDashboardSummary()]);
    };
  } else {
    addBox.classList.add("hidden");
  }

  const searchInput = document.getElementById("announcements-search");
  if (searchInput) {
    searchInput.value = announcementsSearch;
    const debouncedSearch = debounce(() => renderAnnouncementsList(), 300);
    searchInput.oninput = () => {
      announcementsSearch = searchInput.value;
      announcementsLimit = 10;
      debouncedSearch();
    };
  }

  await renderAnnouncementsList();
}

async function renderAnnouncementsList() {
  const list = document.getElementById("announcements-list");

  let query = sb.from("announcements").select("*", { count: "exact" }).order("created_at", { ascending: false });
  const term = announcementsSearch.trim();
  if (term) {
    const safeTerm = term.replace(/[%,]/g, "");
    query = query.or(`title.ilike.%${safeTerm}%,body.ilike.%${safeTerm}%`);
  }

  const { data: announcements, count, error } = await query.range(0, announcementsLimit - 1);

  if (error) {
    list.innerHTML = `<p class="card text-sm text-red-500">Erro ao carregar avisos: ${escapeHtml(error.message)}</p>`;
    updateLoadMoreButton("announcements-load-more", false);
    return;
  }

  list.innerHTML = "";

  if (!announcements || announcements.length === 0) {
    list.innerHTML = `<p class="card text-sm text-slate-400">${term ? "Nenhum aviso encontrado para essa busca." : "Nenhum aviso publicado ainda."}</p>`;
    updateLoadMoreButton("announcements-load-more", false);
    return;
  }

  announcements.forEach((a) => {
    const el = document.createElement("div");
    el.className = "card";
    el.innerHTML = `
      <div class="flex items-start justify-between gap-4" data-view>
        <div class="min-w-0">
          <p class="font-heading font-semibold text-brand-navy">${escapeHtml(a.title)}</p>
          <p class="text-sm text-brand-slate mt-1 whitespace-pre-line">${escapeHtml(a.body)}</p>
          <p class="text-xs text-brand-mist mt-2">${formatDateBR(a.created_at.slice(0, 10))}</p>
        </div>
        ${currentProfile?.is_admin ? `
          <div class="flex gap-3 shrink-0">
            <button type="button" class="text-sm text-brand-slate hover:underline" data-edit>Editar</button>
            <button type="button" class="text-sm text-red-500 hover:underline" data-remove>Remover</button>
          </div>` : ""}
      </div>
    `;

    const removeBtn = el.querySelector("[data-remove]");
    if (removeBtn) {
      removeBtn.addEventListener("click", async () => {
        const { error } = await sb.from("announcements").delete().eq("id", a.id);
        if (error) {
          alert("Erro ao remover aviso: " + error.message);
          return;
        }
        await Promise.all([renderAnnouncementsList(), loadDashboardSummary()]);
      });
    }

    const editBtn = el.querySelector("[data-edit]");
    if (editBtn) {
      editBtn.addEventListener("click", () => {
        const viewDiv = el.querySelector("[data-view]");
        viewDiv.innerHTML = `
          <div class="w-full">
            <input type="text" data-edit-title class="border border-slate-200 rounded-lg px-3 py-2 text-sm w-full mb-2" value="${escapeHtml(a.title)}" />
            <textarea data-edit-body rows="3" class="border border-slate-200 rounded-lg px-3 py-2 text-sm w-full">${escapeHtml(a.body)}</textarea>
            <p data-edit-error class="text-sm text-red-500 mt-2 hidden"></p>
            <div class="flex gap-3 mt-2">
              <button type="button" data-save class="btn-primary">Salvar</button>
              <button type="button" data-cancel class="text-sm text-brand-slate hover:underline">Cancelar</button>
            </div>
          </div>
        `;
        viewDiv.querySelector("[data-cancel]").addEventListener("click", () => renderAnnouncementsList());
        viewDiv.querySelector("[data-save]").addEventListener("click", async () => {
          const newTitle = viewDiv.querySelector("[data-edit-title]").value.trim();
          const newBody = viewDiv.querySelector("[data-edit-body]").value.trim();
          const errEl = viewDiv.querySelector("[data-edit-error]");
          if (!newTitle || !newBody) {
            errEl.textContent = "Preencha título e mensagem.";
            errEl.classList.remove("hidden");
            return;
          }
          const { error } = await sb.from("announcements").update({ title: newTitle, body: newBody }).eq("id", a.id);
          if (error) {
            errEl.textContent = "Erro ao salvar: " + error.message;
            errEl.classList.remove("hidden");
            return;
          }
          await Promise.all([renderAnnouncementsList(), loadDashboardSummary()]);
        });
      });
    }

    list.appendChild(el);
  });

  updateLoadMoreButton("announcements-load-more", (count || 0) > announcements.length, () => {
    announcementsLimit += 10;
    renderAnnouncementsList();
  });
}

// ----------------------------------------------------------------------------
// Férias
// ----------------------------------------------------------------------------

async function loadVacations() {
  const toggleBtn = document.getElementById("btn-toggle-vacation-rules");
  if (toggleBtn) {
    toggleBtn.onclick = () => {
      const body = document.getElementById("vacation-rules-body");
      const icon = document.getElementById("vacation-rules-toggle-icon");
      const isHidden = body.classList.contains("hidden");
      body.classList.toggle("hidden", !isHidden);
      icon.textContent = isHidden ? "Ocultar regras ▴" : "Ver regras ▾";
    };
  }

  const toggleCalendarBtn = document.getElementById("btn-toggle-holidays-calendar");
  if (toggleCalendarBtn) {
    toggleCalendarBtn.onclick = () => {
      const body = document.getElementById("holidays-calendar-body");
      const icon = document.getElementById("holidays-calendar-toggle-icon");
      const isHidden = body.classList.contains("hidden");
      body.classList.toggle("hidden", !isHidden);
      icon.textContent = isHidden ? "Ocultar calendário ▴" : "Ver calendário ▾";
    };
  }

  const holidayAddBox = document.getElementById("admin-add-holiday-box");
  if (holidayAddBox) {
    holidayAddBox.classList.toggle("hidden", !currentProfile?.is_admin);
    if (currentProfile?.is_admin) {
      document.getElementById("btn-add-holiday").onclick = async () => {
        const dateEl = document.getElementById("holiday-date");
        const nameEl = document.getElementById("holiday-name");
        const errEl = document.getElementById("holiday-error");
        errEl.classList.add("hidden");
        const date = dateEl.value;
        const name = nameEl.value.trim();
        if (!date || !name) {
          errEl.textContent = "Preencha a data e a descrição.";
          errEl.classList.remove("hidden");
          return;
        }
        const { error } = await sb.from("holidays").insert({ date, name, created_by: currentUser.id });
        if (error) {
          errEl.textContent = "Erro ao adicionar: " + error.message;
          errEl.classList.remove("hidden");
          return;
        }
        dateEl.value = "";
        nameEl.value = "";
        await loadHolidays();
      };
    }
  }

  const startInput = document.getElementById("vacation-start");
  const endInput = document.getElementById("vacation-end");
  const previewEl = document.getElementById("vacation-days-preview");

  const updatePreview = () => {
    if (!previewEl) return;
    const start = startInput.value;
    const end = endInput.value;
    if (!start || !end || end < start) {
      previewEl.textContent = "";
      return;
    }
    previewEl.textContent = `${formatBusinessDays(countBusinessDays(start, end))} nesse período.`;
  };
  startInput.oninput = updatePreview;
  endInput.oninput = updatePreview;
  updatePreview();

  document.getElementById("btn-add-vacation").onclick = async () => {
    const start = startInput.value;
    const end = endInput.value;
    const errorEl = document.getElementById("vacation-error");
    errorEl.classList.add("hidden");

    if (!start || !end) {
      errorEl.textContent = "Preencha as duas datas.";
      errorEl.classList.remove("hidden");
      return;
    }
    if (end < start) {
      errorEl.textContent = "A data de fim não pode ser antes da data de início.";
      errorEl.classList.remove("hidden");
      return;
    }

    const { error } = await sb
      .from("vacations")
      .insert({ user_id: currentUser.id, start_date: start, end_date: end });

    if (error) {
      errorEl.textContent = "Erro ao salvar: " + error.message;
      errorEl.classList.remove("hidden");
      return;
    }

    startInput.value = "";
    endInput.value = "";
    if (previewEl) previewEl.textContent = "";
    await Promise.all([renderVacationsList(), loadDashboardSummary()]);
  };

  await renderVacationsList();
}

async function renderVacationsList() {
  const list = document.getElementById("vacations-list");

  const { data: vacations, error } = await sb
    .from("vacations")
    .select("id, user_id, start_date, end_date, profiles(full_name, email)")
    .order("start_date");

  if (error) {
    list.innerHTML = `<p class="p-5 text-sm text-red-500">Erro ao carregar férias: ${escapeHtml(error.message)}</p>`;
    return;
  }

  list.innerHTML = "";

  if (!vacations || vacations.length === 0) {
    list.innerHTML = `<p class="p-5 text-sm text-slate-400">Nenhuma férias cadastrada ainda.</p>`;
    return;
  }

  vacations.forEach((v) => {
    const name = v.profiles?.full_name || v.profiles?.email || "—";
    const days = countBusinessDays(v.start_date, v.end_date);
    const row = document.createElement("div");
    row.className = "p-4";
    row.innerHTML = `
      <div class="flex items-center justify-between gap-4" data-view>
        <div>
          <p class="font-medium">${escapeHtml(name)}</p>
          <p class="text-sm text-slate-500">${formatDateBR(v.start_date)} a ${formatDateBR(v.end_date)} · ${formatBusinessDays(days)}</p>
        </div>
        ${v.user_id === currentUser.id ? `
          <div class="flex gap-3 shrink-0">
            <button type="button" class="text-sm text-brand-slate hover:underline" data-edit>Editar</button>
            <button type="button" class="text-sm text-red-500 hover:underline" data-remove>Remover</button>
          </div>` : ""}
      </div>
    `;

    const removeBtn = row.querySelector("[data-remove]");
    if (removeBtn) {
      removeBtn.addEventListener("click", async () => {
        const { error } = await sb.from("vacations").delete().eq("id", v.id);
        if (error) {
          alert("Erro ao remover férias: " + error.message);
          return;
        }
        await Promise.all([renderVacationsList(), loadDashboardSummary()]);
      });
    }

    const editBtn = row.querySelector("[data-edit]");
    if (editBtn) {
      editBtn.addEventListener("click", () => {
        const viewDiv = row.querySelector("[data-view]");
        viewDiv.innerHTML = `
          <div class="w-full">
            <div class="flex flex-wrap gap-3 items-end">
              <div>
                <label class="block text-xs text-brand-slate mb-1">Início</label>
                <input type="date" data-edit-start value="${v.start_date}" class="border border-slate-200 rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label class="block text-xs text-brand-slate mb-1">Fim</label>
                <input type="date" data-edit-end value="${v.end_date}" class="border border-slate-200 rounded-lg px-3 py-2 text-sm" />
              </div>
              <button type="button" data-save class="btn-primary">Salvar</button>
              <button type="button" data-cancel class="text-sm text-brand-slate hover:underline">Cancelar</button>
            </div>
            <p data-edit-preview class="text-sm text-brand-slate mt-2"></p>
            <p data-edit-error class="text-sm text-red-500 mt-1 hidden"></p>
          </div>
        `;
        const startEl = viewDiv.querySelector("[data-edit-start]");
        const endEl = viewDiv.querySelector("[data-edit-end]");
        const previewEl = viewDiv.querySelector("[data-edit-preview]");
        const updateEditPreview = () => {
          if (startEl.value && endEl.value && endEl.value >= startEl.value) {
            previewEl.textContent = `${formatBusinessDays(countBusinessDays(startEl.value, endEl.value))} nesse período.`;
          } else {
            previewEl.textContent = "";
          }
        };
        startEl.oninput = updateEditPreview;
        endEl.oninput = updateEditPreview;
        updateEditPreview();

        viewDiv.querySelector("[data-cancel]").addEventListener("click", () => renderVacationsList());
        viewDiv.querySelector("[data-save]").addEventListener("click", async () => {
          const errEl = viewDiv.querySelector("[data-edit-error]");
          const newStart = startEl.value;
          const newEnd = endEl.value;
          if (!newStart || !newEnd) {
            errEl.textContent = "Preencha as duas datas.";
            errEl.classList.remove("hidden");
            return;
          }
          if (newEnd < newStart) {
            errEl.textContent = "A data de fim não pode ser antes da data de início.";
            errEl.classList.remove("hidden");
            return;
          }
          const { error } = await sb
            .from("vacations")
            .update({ start_date: newStart, end_date: newEnd })
            .eq("id", v.id);
          if (error) {
            errEl.textContent = "Erro ao salvar: " + error.message;
            errEl.classList.remove("hidden");
            return;
          }
          await Promise.all([renderVacationsList(), loadDashboardSummary()]);
        });
      });
    }

    list.appendChild(row);
  });
}

// Quantas linhas mostrar de cada vez no calendário — mantém a lista enxuta;
// "Carregar mais" revela o restante sob demanda.
let holidaysCalendarLimit = 6;

// Mostra o calendário de feriados (nacionais, calculados automaticamente, com
// nome de verdade, + extras cadastrados em public.holidays) a partir de hoje.
// Lista compacta (uma linha por feriado) e paginada, para não poluir a tela.
// Chamado por loadHolidays() sempre que os feriados extras são (re)carregados.
function renderHolidaysCalendar() {
  const container = document.getElementById("holidays-calendar-list");
  if (!container) return;

  const today = toISODate(new Date());
  const thisYear = new Date().getFullYear();
  const years = [thisYear, thisYear + 1];

  const entries = [];
  years.forEach((year) => {
    getBrazilHolidayEntries(year).forEach((e) => entries.push({ date: e.date, name: e.name, extra: false }));
  });
  holidaysCache
    .filter((h) => years.includes(Number(h.date.split("-")[0])))
    .forEach((h) => entries.push({ date: h.date, name: h.name, extra: true, id: h.id }));

  // Mostra só os feriados de hoje em diante — os que já passaram não são mais
  // relevantes para quem está planejando férias.
  const upcoming = entries.filter((h) => h.date >= today);
  upcoming.sort((a, b) => a.date.localeCompare(b.date));

  if (upcoming.length === 0) {
    container.innerHTML = `<p class="p-3 text-sm text-slate-400">Nenhum feriado futuro cadastrado.</p>`;
    updateLoadMoreButton("holidays-calendar-load-more", false);
    return;
  }

  const visible = upcoming.slice(0, holidaysCalendarLimit);

  container.innerHTML = "";
  visible.forEach((h) => {
    const row = document.createElement("div");
    row.className = "flex items-center gap-3 py-1.5 text-sm";
    row.innerHTML = `
      <span class="text-brand-slate w-24 shrink-0">${formatDateBR(h.date)}</span>
      <span class="flex-1 min-w-0 truncate">${escapeHtml(h.name)}</span>
      ${h.extra && currentProfile?.is_admin ? `<button type="button" class="text-xs text-red-500 hover:underline shrink-0" data-remove-holiday>Remover</button>` : ""}
    `;
    const removeBtn = row.querySelector("[data-remove-holiday]");
    if (removeBtn) {
      removeBtn.addEventListener("click", async () => {
        const { error } = await sb.from("holidays").delete().eq("id", h.id);
        if (error) {
          alert("Erro ao remover feriado: " + error.message);
          return;
        }
        await loadHolidays();
      });
    }
    container.appendChild(row);
  });

  updateLoadMoreButton("holidays-calendar-load-more", upcoming.length > visible.length, () => {
    holidaysCalendarLimit += 6;
    renderHolidaysCalendar();
  });
}

// ----------------------------------------------------------------------------
// Escala dos estagiários (por projeto/núcleo — somente administradores editam)
// ----------------------------------------------------------------------------

async function loadInternSchedule() {
  const addBox = document.getElementById("admin-add-intern-box");
  if (currentProfile?.is_admin) {
    addBox.classList.remove("hidden");

    const weekInput = document.getElementById("intern-week");
    if (!weekInput.value) {
      weekInput.value = defaultInternRotationStartIso();
    }

    document.getElementById("btn-add-intern").onclick = async () => {
      const name = document.getElementById("intern-name").value.trim();
      const project = document.getElementById("intern-project").value.trim();
      const notes = document.getElementById("intern-notes").value.trim();
      const weekValue = document.getElementById("intern-week").value;
      const errorEl = document.getElementById("intern-error");
      errorEl.classList.add("hidden");

      if (!name || !project || !weekValue) {
        errorEl.textContent = "Preencha nome, projeto/núcleo e a quinzena.";
        errorEl.classList.remove("hidden");
        return;
      }

      const { error } = await sb.from("intern_assignments").insert({
        intern_name: name,
        project,
        notes: notes || null,
        week_start: internRotationStartForDate(weekValue),
        created_by: currentUser.id,
      });

      if (error) {
        errorEl.textContent = "Erro ao adicionar: " + error.message;
        errorEl.classList.remove("hidden");
        return;
      }

      document.getElementById("intern-name").value = "";
      document.getElementById("intern-project").value = "";
      document.getElementById("intern-notes").value = "";
      document.getElementById("intern-week").value = defaultInternRotationStartIso();
      await renderInternsList();
    };
  } else {
    addBox.classList.add("hidden");
  }

  await renderInternsList();
}

async function renderInternsList() {
  const list = document.getElementById("interns-list");

  const { data: interns, error } = await sb
    .from("intern_assignments")
    .select("*")
    .order("week_start", { ascending: false })
    .order("project")
    .order("intern_name");

  if (error) {
    list.innerHTML = `<p class="p-5 text-sm text-red-500">Erro ao carregar a escala: ${escapeHtml(error.message)}</p>`;
    return;
  }

  list.innerHTML = "";

  if (!interns || interns.length === 0) {
    list.innerHTML = `<p class="p-5 text-sm text-slate-400">Nenhuma alocação cadastrada ainda.</p>`;
    return;
  }

  let currentWeek;
  let firstGroup = true;
  interns.forEach((i) => {
    if (i.week_start !== currentWeek) {
      currentWeek = i.week_start;
      const header = document.createElement("p");
      header.className = `px-4 pb-1 text-xs font-semibold uppercase tracking-wide text-brand-mist ${firstGroup ? "pt-4" : "pt-5"}`;
      header.textContent = formatInternPeriodRange(currentWeek);
      list.appendChild(header);
      firstGroup = false;
    }

    const row = document.createElement("div");
    row.className = "p-4";
    row.innerHTML = `
      <div class="flex items-center justify-between gap-4" data-view>
        <div class="min-w-0">
          <p class="font-medium">${escapeHtml(i.intern_name)} <span class="text-brand-slate font-normal">— ${escapeHtml(i.project)}</span></p>
          ${i.notes ? `<p class="text-sm text-slate-500">${escapeHtml(i.notes)}</p>` : ""}
        </div>
        ${currentProfile?.is_admin ? `
          <div class="flex gap-3 shrink-0">
            <button type="button" class="text-sm text-brand-slate hover:underline" data-edit>Editar</button>
            <button type="button" class="text-sm text-red-500 hover:underline" data-remove>Remover</button>
          </div>` : ""}
      </div>
    `;

    const removeBtn = row.querySelector("[data-remove]");
    if (removeBtn) {
      removeBtn.addEventListener("click", async () => {
        const { error } = await sb.from("intern_assignments").delete().eq("id", i.id);
        if (error) {
          alert("Erro ao remover alocação: " + error.message);
          return;
        }
        await renderInternsList();
      });
    }

    const editBtn = row.querySelector("[data-edit]");
    if (editBtn) {
      editBtn.addEventListener("click", () => {
        const viewDiv = row.querySelector("[data-view]");
        viewDiv.innerHTML = `
          <div class="w-full">
            <div class="grid sm:grid-cols-3 gap-3">
              <input type="text" data-edit-name value="${escapeHtml(i.intern_name)}" placeholder="Nome do estagiário" class="border border-slate-200 rounded-lg px-3 py-2 text-sm" />
              <input type="text" data-edit-project value="${escapeHtml(i.project)}" placeholder="Projeto/Núcleo" class="border border-slate-200 rounded-lg px-3 py-2 text-sm" />
              <input type="text" data-edit-notes value="${escapeHtml(i.notes || "")}" placeholder="Observações (opcional)" class="border border-slate-200 rounded-lg px-3 py-2 text-sm" />
            </div>
            <div class="mt-3">
              <label class="block text-xs text-brand-slate mb-1">Início da quinzena</label>
              <input type="date" data-edit-week value="${i.week_start}" class="border border-slate-200 rounded-lg px-3 py-2 text-sm" />
            </div>
            <p data-edit-error class="text-sm text-red-500 mt-2 hidden"></p>
            <div class="flex gap-3 mt-3">
              <button type="button" data-save class="btn-primary">Salvar</button>
              <button type="button" data-cancel class="text-sm text-brand-slate hover:underline">Cancelar</button>
            </div>
          </div>
        `;
        viewDiv.querySelector("[data-cancel]").addEventListener("click", () => renderInternsList());
        viewDiv.querySelector("[data-save]").addEventListener("click", async () => {
          const newName = viewDiv.querySelector("[data-edit-name]").value.trim();
          const newProject = viewDiv.querySelector("[data-edit-project]").value.trim();
          const newNotes = viewDiv.querySelector("[data-edit-notes]").value.trim();
          const newWeek = viewDiv.querySelector("[data-edit-week]").value;
          const errEl = viewDiv.querySelector("[data-edit-error]");
          if (!newName || !newProject || !newWeek) {
            errEl.textContent = "Preencha nome, projeto/núcleo e a quinzena.";
            errEl.classList.remove("hidden");
            return;
          }
          const { error } = await sb
            .from("intern_assignments")
            .update({
              intern_name: newName,
              project: newProject,
              notes: newNotes || null,
              week_start: internRotationStartForDate(newWeek),
            })
            .eq("id", i.id);
          if (error) {
            errEl.textContent = "Erro ao salvar: " + error.message;
            errEl.classList.remove("hidden");
            return;
          }
          await renderInternsList();
        });
      });
    }

    list.appendChild(row);
  });
}

// ----------------------------------------------------------------------------
// Manuais
// ----------------------------------------------------------------------------

let manualsSearch = "";
let manualsLimit = 20;

async function loadManuals() {
  const addBox = document.getElementById("admin-add-manual-box");
  if (currentProfile?.is_admin) {
    addBox.classList.remove("hidden");
    document.getElementById("btn-add-manual").onclick = async () => {
      const title = document.getElementById("manual-title").value.trim();
     
      const fileInput = document.getElementById("manual-file");
      const file = fileInput.files[0];
      const errorEl = document.getElementById("manual-upload-error");
      errorEl.classList.add("hidden");

      if (!title || !file) {
        errorEl.textContent = "Preencha o título e escolha um arquivo.";
        errorEl.classList.remove("hidden");
        return;
      }
      if (file.size > 50 * 1024 * 1024) {
        errorEl.textContent = "Arquivo maior que 50 MB. Envie um arquivo menor.";
        errorEl.classList.remove("hidden");
        return;
      }

      const btn = document.getElementById("btn-add-manual");
      btn.disabled = true;
      btn.textContent = "Enviando...";

      const safeName = file.name
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-zA-Z0-9.\-_]/g, "_");
      const storagePath = `${crypto.randomUUID()}-${safeName}`;

      const { error: uploadError } = await sb.storage.from("manuals").upload(storagePath, file);
      if (uploadError) {
        errorEl.textContent = "Erro ao enviar o arquivo: " + uploadError.message;
        errorEl.classList.remove("hidden");
        btn.disabled = false;
        btn.textContent = "Adicionar";
        return;
      }

      const { error: insertError } = await sb.from("manuals").insert({
        title,
        storage_path: storagePath,
        file_name: file.name,
        created_by: currentUser.id,
      });

      if (insertError) {
        errorEl.textContent = "Arquivo enviado, mas houve erro ao salvar o registro: " + insertError.message;
        errorEl.classList.remove("hidden");
        btn.disabled = false;
        btn.textContent = "Adicionar";
        return;
      }

      document.getElementById("manual-title").value = "";
     
      fileInput.value = "";
      btn.disabled = false;
      btn.textContent = "Adicionar";
      manualsLimit = 20;
      await renderManualsList();
    };
  } else {
    addBox.classList.add("hidden");
  }

  const searchInput = document.getElementById("manuals-search");
  if (searchInput) {
    searchInput.value = manualsSearch;
    const debouncedSearch = debounce(() => renderManualsList(), 300);
    searchInput.oninput = () => {
      manualsSearch = searchInput.value;
      manualsLimit = 20;
      debouncedSearch();
    };
  }

  await renderManualsList();
}

async function renderManualsList() {
  const list = document.getElementById("manuals-list");

  let query = sb.from("manuals").select("*", { count: "exact" }).order("title");
  const term = manualsSearch.trim();
  if (term) {
    const safeTerm = term.replace(/[%,]/g, "");
    query = query.ilike("title", `%${safeTerm}%`);
  }

  const { data: manuals, count, error } = await query.range(0, manualsLimit - 1);

  if (error) {
    list.innerHTML = `<p class="p-5 text-sm text-red-500">Erro ao carregar manuais: ${escapeHtml(error.message)}</p>`;
    updateLoadMoreButton("manuals-load-more", false);
    return;
  }

  list.innerHTML = "";

  if (!manuals || manuals.length === 0) {
    list.innerHTML = `<p class="p-5 text-sm text-slate-400">${term ? "Nenhum manual encontrado para essa busca." : "Nenhum manual cadastrado ainda."}</p>`;
    updateLoadMoreButton("manuals-load-more", false);
    return;
  }

  manuals.forEach((m) => {
    const row = document.createElement("div");
    row.className = "p-4";
    row.innerHTML = `
      <div class="flex items-center justify-between gap-4" data-view>
        <div class="min-w-0">
          <button type="button" data-open class="font-medium text-brand-navy hover:underline text-left">${escapeHtml(m.title)}</button>
         
        </div>
        ${currentProfile?.is_admin ? `
          <div class="flex gap-3 shrink-0">
            <button type="button" class="text-sm text-brand-slate hover:underline" data-edit>Editar</button>
            <button type="button" class="text-sm text-red-500 hover:underline" data-remove>Remover</button>
          </div>` : ""}
      </div>
    `;

    row.querySelector("[data-open]").addEventListener("click", async () => {
      if (!m.storage_path) {
        if (m.url) window.open(m.url, "_blank", "noopener");
        return;
      }
      // Abre a aba antes do await, para o navegador não bloquear o pop-up.
      const newTab = window.open("", "_blank");
        if (newTab) {
          try {
            newTab.opener = null;
          } catch (e) {}
        }
        const { data, error } = await sb.storage.from("manuals").createSignedUrl(m.storage_path, 300);
        if (error || !data?.signedUrl) {
          if (newTab) newTab.close();
          alert("Não foi possível abrir o arquivo agora. Tente novamente.");
          return;
        }
        if (newTab) newTab.location.href = data.signedUrl;

    });

    const removeBtn = row.querySelector("[data-remove]");
    if (removeBtn) {
      removeBtn.addEventListener("click", async () => {
        if (m.storage_path) {
          const { error: storageError } = await sb.storage.from("manuals").remove([m.storage_path]);
          if (storageError) {
            alert("Erro ao remover o arquivo: " + storageError.message);
            return;
          }
        }
        const { error } = await sb.from("manuals").delete().eq("id", m.id);
        if (error) {
          alert("Erro ao remover o manual: " + error.message);
          return;
        }
        await renderManualsList();
      });
    }

    const editBtn = row.querySelector("[data-edit]");
    if (editBtn) {
      editBtn.addEventListener("click", () => {
        const viewDiv = row.querySelector("[data-view]");
        viewDiv.innerHTML = `
          <div class="w-full">
            <div class="grid sm:grid-cols-2 gap-3">
              <input type="text" data-edit-title value="${escapeHtml(m.title)}" placeholder="Título" class="border border-slate-200 rounded-lg px-3 py-2 text-sm" />
             
            </div>
            <p class="text-xs text-brand-mist mt-2">Para trocar o arquivo, remova este manual e cadastre de novo.</p>
            <p data-edit-error class="text-sm text-red-500 mt-2 hidden"></p>
            <div class="flex gap-3 mt-3">
              <button type="button" data-save class="btn-primary">Salvar</button>
              <button type="button" data-cancel class="text-sm text-brand-slate hover:underline">Cancelar</button>
            </div>
          </div>
        `;
        viewDiv.querySelector("[data-cancel]").addEventListener("click", () => renderManualsList());
        viewDiv.querySelector("[data-save]").addEventListener("click", async () => {
          const newTitle = viewDiv.querySelector("[data-edit-title]").value.trim();
         
          const errEl = viewDiv.querySelector("[data-edit-error]");
          if (!newTitle) {
            errEl.textContent = "Preencha o título.";
            errEl.classList.remove("hidden");
            return;
          }
          const { error } = await sb
            .from("manuals")
            .update({ title: newTitle })
            .eq("id", m.id);
          if (error) {
            errEl.textContent = "Erro ao salvar: " + error.message;
            errEl.classList.remove("hidden");
            return;
          }
          await renderManualsList();
        });
      });
    }

    list.appendChild(row);
  });

  updateLoadMoreButton("manuals-load-more", (count || 0) > manuals.length, () => {
    manualsLimit += 20;
    renderManualsList();
  });
}

// ----------------------------------------------------------------------------
// Meu perfil — dados visíveis somente para a própria pessoa (e para
// administradores, que também podem editar os de qualquer colaborador(a)):
// data de admissão, saldo de férias remanescentes e histórico de feedbacks.
// A RLS já restringe a leitura a "a própria linha ou um admin"; aqui só
// cuidamos de exibir/editar o que a consulta efetivamente retornar.
// ----------------------------------------------------------------------------

function formatVacationBalance(days) {
  if (days === null || days === undefined) return "—";
  const n = Number(days);
  if (Number.isNaN(n)) return "—";
  const rounded = Math.round(n * 10) / 10;
  return `${rounded} dia${rounded === 1 ? "" : "s"}`;
}

// Nota opcional de feedback, sugestão do sócio: de -3 (bem negativo) a +3
// (bem positivo), 0 = neutro. Negativos em vermelho, positivos em verde,
// neutro em cinza, para dar um sinal visual rápido do tom do feedback.
const FEEDBACK_SCORES = [-3, -2, -1, 0, 1, 2, 3];

function feedbackScoreColorClasses(score) {
  if (score < 0) return { text: "text-red-600", border: "border-red-300", bg: "bg-red-50", ring: "ring-red-400" };
  if (score > 0) return { text: "text-green-600", border: "border-green-300", bg: "bg-green-50", ring: "ring-green-400" };
  return { text: "text-slate-500", border: "border-slate-300", bg: "bg-slate-100", ring: "ring-slate-400" };
}

function formatFeedbackScore(score) {
  return score > 0 ? `+${score}` : `${score}`;
}

function feedbackScoreBadgeHtml(score) {
  if (score === null || score === undefined) return "";
  const c = feedbackScoreColorClasses(score);
  return `<span class="inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-semibold border shrink-0 ${c.text} ${c.bg} ${c.border}">${formatFeedbackScore(score)}</span>`;
}

// Nota selecionada no formulário "Adicionar feedback" (somente administradores).
// Reseta para 0 (neutro) a cada colaborador(a) carregado(a) e após cada envio.
let selectedFeedbackScore = 0;

function renderScorePicker() {
  const container = document.getElementById("feedback-score-picker");
  if (!container) return;
  container.innerHTML = "";
  FEEDBACK_SCORES.forEach((score) => {
    const c = feedbackScoreColorClasses(score);
    const isActive = score === selectedFeedbackScore;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `w-9 h-9 rounded-full border text-sm font-medium ${c.text} ${c.border} ${isActive ? `${c.bg} ring-2 ring-offset-1 ${c.ring}` : "bg-white"}`;
    btn.textContent = formatFeedbackScore(score);
    btn.addEventListener("click", () => {
      selectedFeedbackScore = score;
      renderScorePicker();
    });
    container.appendChild(btn);
  });
}

// Busca, numa única consulta, o nome de quem deu cada feedback (coluna
// created_by) e devolve as mesmas entradas com um campo extra `authorName`.
// A tabela profiles é de leitura aberta para todo autenticado, então isso
// funciona tanto na visão da própria pessoa quanto na do admin.
async function attachFeedbackAuthors(entries) {
  const ids = [...new Set((entries || []).map((f) => f.created_by).filter(Boolean))];
  if (ids.length === 0) return entries || [];

  const { data: authors } = await sb.from("profiles").select("id, full_name, email").in("id", ids);
  const nameById = new Map((authors || []).map((a) => [a.id, a.full_name || a.email]));
  return entries.map((f) => ({ ...f, authorName: f.created_by ? nameById.get(f.created_by) || null : null }));
}

function renderFeedbackList(container, entries, { withRemove = false } = {}) {
  if (!entries || entries.length === 0) {
    container.innerHTML = `<p class="p-4 text-sm text-slate-400">Nenhum feedback registrado ainda.</p>`;
    return;
  }
  container.innerHTML = "";
  entries.forEach((f) => {
    const row = document.createElement("div");
    row.className = "p-4";
    row.innerHTML = `
      <div class="flex items-start gap-3">
        ${feedbackScoreBadgeHtml(f.score)}
        <div class="min-w-0 flex-1">
          <p class="text-sm whitespace-pre-line">${escapeHtml(f.body)}</p>
          <p class="text-xs text-brand-mist mt-1">${formatDateTimeBR(f.created_at)}${f.authorName ? ` · por ${escapeHtml(f.authorName)}` : ""}</p>
        </div>
        ${withRemove ? `<button type="button" class="text-sm text-red-500 hover:underline shrink-0" data-remove-feedback>Remover</button>` : ""}
      </div>
    `;
    if (withRemove) {
      row.querySelector("[data-remove-feedback]").addEventListener("click", async () => {
        const { error } = await sb.from("feedback_entries").delete().eq("id", f.id);
        if (error) {
          alert("Erro ao remover feedback: " + error.message);
          return;
        }
        await loadProfileEditorFor(currentEditorUserId);
        if (f.user_id === currentUser.id) await loadProfileTab();
      });
    }
    container.appendChild(row);
  });
}

// Decide o saldo de férias a exibir: se houver um valor manual cadastrado em
// employee_profile_details.vacation_balance_days, ele tem prioridade (não
// sobrescrevemos o que os admins digitaram manualmente); senão, calculamos
// automaticamente a partir da data de admissão e das férias já registradas.
// Retorna { value, isManual }.
function resolveVacationBalance(details, vacations) {
  if (details?.vacation_balance_days !== null && details?.vacation_balance_days !== undefined) {
    return { value: details.vacation_balance_days, isManual: true };
  }
  const calc = calcVacationBalance(details?.hire_date, vacations, toISODate(new Date()));
  return { value: calc, isManual: false };
}

async function loadProfileTab() {
  // --- "Meus dados" (somente leitura, sempre a própria pessoa) ---
  const [{ data: myDetails }, { data: myFeedback }, { data: myVacations }] = await Promise.all([
    sb.from("employee_profile_details").select("*").eq("user_id", currentUser.id).maybeSingle(),
    sb.from("feedback_entries").select("*").eq("user_id", currentUser.id).order("created_at", { ascending: false }),
    sb.from("vacations").select("start_date, end_date").eq("user_id", currentUser.id),
  ]);

  document.getElementById("profile-hire-date").textContent = myDetails?.hire_date
    ? formatDateBR(myDetails.hire_date)
    : "—";

  const resolvedBalance = resolveVacationBalance(myDetails, myVacations || []);
  document.getElementById("profile-vacation-balance").textContent = formatVacationBalance(resolvedBalance.value);
  const subEl = document.getElementById("profile-vacation-balance-sub");
  if (subEl) {
    subEl.textContent = !myDetails?.hire_date
      ? ""
      : resolvedBalance.isManual
      ? "Valor definido manualmente pela administração"
      : "Calculado automaticamente a partir da data de admissão";
  }

  renderFeedbackList(document.getElementById("profile-feedback-list"), await attachFeedbackAuthors(myFeedback || []));

  // --- edição por administradores, para qualquer colaborador(a) ---
  const adminBox = document.getElementById("admin-profile-editor-box");
  if (!currentProfile?.is_admin) {
    adminBox.classList.add("hidden");
    return;
  }
  adminBox.classList.remove("hidden");

  const { data: allProfiles } = await sb.from("profiles").select("id, full_name, email").order("full_name");
  const select = document.getElementById("profile-editor-select");
  const previousSelection = select.value;
  select.innerHTML =
    `<option value="">Selecione...</option>` +
    (allProfiles || [])
      .map((p) => `<option value="${p.id}">${escapeHtml(p.full_name || p.email)}</option>`)
      .join("");
  select.value = previousSelection;
  select.onchange = () => loadProfileEditorFor(select.value || null);

  if (!select.value) {
    document.getElementById("profile-editor-fields").classList.add("hidden");
  }
}

let currentEditorUserId = null;

async function loadProfileEditorFor(userId) {
  currentEditorUserId = userId;
  const fieldsBox = document.getElementById("profile-editor-fields");
  if (!userId) {
    fieldsBox.classList.add("hidden");
    return;
  }
  fieldsBox.classList.remove("hidden");

  const savedMsg = document.getElementById("profile-editor-saved-msg");
  savedMsg.classList.add("hidden");
  const errEl = document.getElementById("profile-editor-error");
  errEl.classList.add("hidden");
  const fErrEl = document.getElementById("profile-editor-feedback-error");
  fErrEl.classList.add("hidden");

  const [{ data: details }, { data: feedback }, { data: vacations }] = await Promise.all([
    sb.from("employee_profile_details").select("*").eq("user_id", userId).maybeSingle(),
    sb.from("feedback_entries").select("*").eq("user_id", userId).order("created_at", { ascending: false }),
    sb.from("vacations").select("start_date, end_date").eq("user_id", userId),
  ]);

  document.getElementById("profile-editor-hire-date").value = details?.hire_date || "";
  document.getElementById("profile-editor-vacation-balance").value =
    details?.vacation_balance_days ?? "";

  selectedFeedbackScore = 0;
  renderScorePicker();

  const editorBalanceHint = document.getElementById("profile-editor-vacation-balance-hint");
  if (editorBalanceHint) {
    const autoCalc = calcVacationBalance(details?.hire_date, vacations || [], toISODate(new Date()));
    editorBalanceHint.textContent =
      autoCalc === null
        ? "Sem data de admissão cadastrada, não é possível calcular automaticamente."
        : `Cálculo automático (sem override manual): ${formatVacationBalance(autoCalc)}.`;
  }

  renderFeedbackList(document.getElementById("profile-editor-feedback-list"), await attachFeedbackAuthors(feedback || []), {
    withRemove: true,
  });

  document.getElementById("btn-save-profile-details").onclick = async () => {
    errEl.classList.add("hidden");
    savedMsg.classList.add("hidden");
    const hireDate = document.getElementById("profile-editor-hire-date").value || null;
    const balanceRaw = document.getElementById("profile-editor-vacation-balance").value;
    const balance = balanceRaw === "" ? null : Number(balanceRaw);

    const { error } = await sb.from("employee_profile_details").upsert({
      user_id: userId,
      hire_date: hireDate,
      vacation_balance_days: balance,
      updated_at: new Date().toISOString(),
      updated_by: currentUser.id,
    });

    if (error) {
      errEl.textContent = "Erro ao salvar: " + error.message;
      errEl.classList.remove("hidden");
      return;
    }
    savedMsg.classList.remove("hidden");
    setTimeout(() => savedMsg.classList.add("hidden"), 2000);

    // Se o admin editou o PRÓPRIO perfil, atualiza o card "Meus dados" também.
    if (userId === currentUser.id) await loadProfileTab();
  };

  document.getElementById("btn-add-feedback").onclick = async () => {
    fErrEl.classList.add("hidden");
    const bodyEl = document.getElementById("profile-editor-feedback-body");
    const body = bodyEl.value.trim();
    if (!body) return;

    const { error } = await sb.from("feedback_entries").insert({
      user_id: userId,
      body,
      score: selectedFeedbackScore,
      created_by: currentUser.id,
    });

    if (error) {
      fErrEl.textContent = "Erro ao adicionar feedback: " + error.message;
      fErrEl.classList.remove("hidden");
      return;
    }
    bodyEl.value = "";
    selectedFeedbackScore = 0;
    await loadProfileEditorFor(userId);
    if (userId === currentUser.id) await loadProfileTab();
  };
}

// ----------------------------------------------------------------------------
// Início
// ----------------------------------------------------------------------------

sb.auth.onAuthStateChange((_event, session) => {
  cleanAuthHashFromUrl();
  if (session?.user && !currentUser) {
    enterApp(session.user);
  }
});

boot();
