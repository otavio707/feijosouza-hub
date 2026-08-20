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
  await Promise.all([
    loadDashboardSummary(),
    loadHomeOffice(),
    loadBirthdays(),
    loadAnnouncements(),
    loadVacations(),
    loadInternSchedule(),
    loadManuals(),
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

function getWeekDates() {
  const monday = getMondayOfWeek(new Date());
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

function mondayOfISOWeek(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return toISODate(getMondayOfWeek(new Date(y, m - 1, d)));
}

function formatWeekRange(weekStartIso) {
  if (!weekStartIso) return "Semana não informada";
  const endIso = addDaysISO(weekStartIso, 4);
  return `Semana de ${formatDateBR(weekStartIso)} a ${formatDateBR(endIso)}`;
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

function getBrazilHolidays(year) {
  const fixed = [
    [1, 1],   // Confraternização Universal
    [4, 21],  // Tiradentes
    [5, 1],   // Dia do Trabalho
    [9, 7],   // Independência do Brasil
    [10, 12], // Nossa Senhora Aparecida
    [11, 2],  // Finados
    [11, 15], // Proclamação da República
    [11, 20], // Consciência Negra
    [12, 25], // Natal
  ];
  const holidays = fixed.map(([m, d]) => toISODate(new Date(year, m - 1, d)));

  const easter = easterDateForYear(year);
  const offset = (days) => {
    const d = new Date(easter);
    d.setDate(d.getDate() + days);
    return toISODate(d);
  };
  holidays.push(offset(-48)); // Segunda de Carnaval
  holidays.push(offset(-47)); // Terça de Carnaval
  holidays.push(offset(-2)); // Sexta-feira Santa
  holidays.push(offset(60)); // Corpus Christi

  return new Set(holidays);
}

// Conta os dias úteis entre duas datas ISO (inclusive), excluindo fins de
// semana e feriados nacionais.
function countBusinessDays(startIso, endIso) {
  if (!startIso || !endIso || endIso < startIso) return 0;
  const [sy, sm, sd] = startIso.split("-").map(Number);
  const [ey, em, ed] = endIso.split("-").map(Number);
  const cur = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  const holidaysByYear = {};
  let count = 0;
  while (cur <= end) {
    const year = cur.getFullYear();
    if (!holidaysByYear[year]) holidaysByYear[year] = getBrazilHolidays(year);
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6 && !holidaysByYear[year].has(toISODate(cur))) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

function formatBusinessDays(days) {
  return days === 1 ? "1 dia útil" : `${days} dias úteis`;
}

// ----------------------------------------------------------------------------
// Página inicial (resumo do dia)
// ----------------------------------------------------------------------------

async function loadDashboardSummary() {
  const todayISO = toISODate(new Date());

  document.getElementById("summary-date-label").textContent =
    `Hoje, ${formatDateBR(todayISO).slice(0, 5)}`;

  const [{ data: profiles }, { data: entries }, { data: birthProfiles }, { data: announcements }] =
    await Promise.all([
      sb.from("profiles").select("id, full_name, email"),
      sb.from("homeoffice_entries").select("user_id, period").eq("entry_date", todayISO),
      sb.from("profiles").select("full_name, email, birth_date").not("birth_date", "is", null),
      sb.from("announcements").select("title, body, created_at").order("created_at", { ascending: false }).limit(1),
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
}

// ----------------------------------------------------------------------------
// Home office
// ----------------------------------------------------------------------------

async function loadHomeOffice() {
  const weekDates = getWeekDates();
  const isoDates = weekDates.map(toISODate);

  document.getElementById("week-range").textContent =
    `Semana de ${formatDateBR(isoDates[0])} a ${formatDateBR(isoDates[4])}`;

  const [{ data: profiles }, { data: entries }] = await Promise.all([
    sb.from("profiles").select("id, full_name, email").order("full_name"),
    sb.from("homeoffice_entries").select("user_id, entry_date, period").in("entry_date", isoDates),
  ]);

  renderMyWeekToggles(isoDates, entries || []);
  renderTeamWeekTable(weekDates, profiles || [], entries || []);
}

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
    searchInput.oninput = () => {
      announcementsSearch = searchInput.value;
      announcementsLimit = 10;
      renderAnnouncementsList();
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
    await renderVacationsList();
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
        await renderVacationsList();
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
          await renderVacationsList();
        });
      });
    }

    list.appendChild(row);
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
      weekInput.value = toISODate(getMondayOfWeek(new Date()));
    }

    document.getElementById("btn-add-intern").onclick = async () => {
      const name = document.getElementById("intern-name").value.trim();
      const project = document.getElementById("intern-project").value.trim();
      const notes = document.getElementById("intern-notes").value.trim();
      const weekValue = document.getElementById("intern-week").value;
      const errorEl = document.getElementById("intern-error");
      errorEl.classList.add("hidden");

      if (!name || !project || !weekValue) {
        errorEl.textContent = "Preencha nome, projeto/núcleo e a semana.";
        errorEl.classList.remove("hidden");
        return;
      }

      const { error } = await sb.from("intern_assignments").insert({
        intern_name: name,
        project,
        notes: notes || null,
        week_start: mondayOfISOWeek(weekValue),
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
      document.getElementById("intern-week").value = toISODate(getMondayOfWeek(new Date()));
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
      header.textContent = formatWeekRange(currentWeek);
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
              <label class="block text-xs text-brand-slate mb-1">Semana</label>
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
            errEl.textContent = "Preencha nome, projeto/núcleo e a semana.";
            errEl.classList.remove("hidden");
            return;
          }
          const { error } = await sb
            .from("intern_assignments")
            .update({
              intern_name: newName,
              project: newProject,
              notes: newNotes || null,
              week_start: mondayOfISOWeek(newWeek),
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
      const category = document.getElementById("manual-category").value.trim();
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
        category,
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
      document.getElementById("manual-category").value = "";
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
    searchInput.oninput = () => {
      manualsSearch = searchInput.value;
      manualsLimit = 20;
      renderManualsList();
    };
  }

  await renderManualsList();
}

async function renderManualsList() {
  const list = document.getElementById("manuals-list");

  let query = sb.from("manuals").select("*", { count: "exact" }).order("category").order("title");
  const term = manualsSearch.trim();
  if (term) {
    const safeTerm = term.replace(/[%,]/g, "");
    query = query.or(`title.ilike.%${safeTerm}%,category.ilike.%${safeTerm}%`);
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
          ${m.category ? `<p class="text-sm text-slate-500">${escapeHtml(m.category)}</p>` : ""}
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
              <input type="text" data-edit-category value="${escapeHtml(m.category || "")}" placeholder="Categoria" class="border border-slate-200 rounded-lg px-3 py-2 text-sm" />
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
          const newCategory = viewDiv.querySelector("[data-edit-category]").value.trim();
          const errEl = viewDiv.querySelector("[data-edit-error]");
          if (!newTitle) {
            errEl.textContent = "Preencha o título.";
            errEl.classList.remove("hidden");
            return;
          }
          const { error } = await sb
            .from("manuals")
            .update({ title: newTitle, category: newCategory || null })
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
// Início
// ----------------------------------------------------------------------------

sb.auth.onAuthStateChange((_event, session) => {
  cleanAuthHashFromUrl();
  if (session?.user && !currentUser) {
    enterApp(session.user);
  }
});

boot();
