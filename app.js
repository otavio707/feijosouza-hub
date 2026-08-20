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

async function boot() {
  const { data } = await sb.auth.getSession();
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
          await sb
            .from("homeoffice_entries")
            .delete()
            .eq("user_id", currentUser.id)
            .eq("entry_date", iso)
            .eq("period", "dia");
        } else {
          await sb.from("homeoffice_entries").insert({ user_id: currentUser.id, entry_date: iso, period: "dia" });
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
          await sb
            .from("homeoffice_entries")
            .delete()
            .eq("user_id", currentUser.id)
            .eq("entry_date", iso)
            .eq("period", period);
        } else {
          if (myEntrySet.size >= WEEKLY_PERIOD_QUOTA) {
            alert(
              `Você já atingiu o limite de ${WEEKLY_PERIOD_QUOTA} períodos (2 dias inteiros) de home office nesta semana.`
            );
            return;
          }
          await sb.from("homeoffice_entries").insert({ user_id: currentUser.id, entry_date: iso, period });
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
    await sb.from("profiles").update({ birth_date: value }).eq("id", currentUser.id);
    currentProfile.birth_date = value;
    const msg = document.getElementById("birth-date-saved-msg");
    msg.classList.remove("hidden");
    setTimeout(() => msg.classList.add("hidden"), 2000);
    await Promise.all([loadBirthdays(), loadDashboardSummary()]);
  };

  const { data: profiles } = await sb
    .from("profiles")
    .select("id, full_name, email, birth_date")
    .not("birth_date", "is", null);

  const withDays = (profiles || [])
    .map((p) => ({ ...p, daysUntil: daysUntilNextOccurrence(p.birth_date) }))
    .sort((a, b) => a.daysUntil - b.daysUntil);

  const list = document.getElementById("birthdays-list");
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

async function loadAnnouncements() {
  const addBox = document.getElementById("admin-add-announcement-box");
  if (currentProfile?.is_admin) {
    addBox.classList.remove("hidden");
    document.getElementById("btn-add-announcement").onclick = async () => {
      const title = document.getElementById("announcement-title").value.trim();
      const body = document.getElementById("announcement-body").value.trim();
      if (!title || !body) return;
      await sb.from("announcements").insert({ title, body, created_by: currentUser.id });
      document.getElementById("announcement-title").value = "";
      document.getElementById("announcement-body").value = "";
      await Promise.all([loadAnnouncements(), loadDashboardSummary()]);
    };
  } else {
    addBox.classList.add("hidden");
  }

  const { data: announcements } = await sb
    .from("announcements")
    .select("*")
    .order("created_at", { ascending: false });

  const list = document.getElementById("announcements-list");
  list.innerHTML = "";

  if (!announcements || announcements.length === 0) {
    list.innerHTML = `<p class="card text-sm text-slate-400">Nenhum aviso publicado ainda.</p>`;
    return;
  }

  announcements.forEach((a) => {
    const el = document.createElement("div");
    el.className = "card";
    el.innerHTML = `
      <div class="flex items-start justify-between gap-4">
        <div class="min-w-0">
          <p class="font-heading font-semibold text-brand-navy">${escapeHtml(a.title)}</p>
          <p class="text-sm text-brand-slate mt-1 whitespace-pre-line">${escapeHtml(a.body)}</p>
          <p class="text-xs text-brand-mist mt-2">${formatDateBR(a.created_at.slice(0, 10))}</p>
        </div>
        ${currentProfile?.is_admin ? `<button class="text-sm text-red-500 hover:underline shrink-0" data-remove>Remover</button>` : ""}
      </div>
    `;
    const removeBtn = el.querySelector("[data-remove]");
    if (removeBtn) {
      removeBtn.addEventListener("click", async () => {
        await sb.from("announcements").delete().eq("id", a.id);
        await Promise.all([loadAnnouncements(), loadDashboardSummary()]);
      });
    }
    list.appendChild(el);
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
    await loadVacations();
  };

  const { data: vacations } = await sb
    .from("vacations")
    .select("id, user_id, start_date, end_date, profiles(full_name, email)")
    .order("start_date");

  const list = document.getElementById("vacations-list");
  list.innerHTML = "";

  if (!vacations || vacations.length === 0) {
    list.innerHTML = `<p class="p-5 text-sm text-slate-400">Nenhuma férias cadastrada ainda.</p>`;
    return;
  }

  vacations.forEach((v) => {
    const name = v.profiles?.full_name || v.profiles?.email || "—";
    const days = countBusinessDays(v.start_date, v.end_date);
    const row = document.createElement("div");
    row.className = "flex items-center justify-between p-4 gap-4";
    row.innerHTML = `
      <div>
        <p class="font-medium">${escapeHtml(name)}</p>
        <p class="text-sm text-slate-500">${formatDateBR(v.start_date)} a ${formatDateBR(v.end_date)} · ${formatBusinessDays(days)}</p>
      </div>
      ${v.user_id === currentUser.id ? `<button class="text-sm text-red-500 hover:underline shrink-0" data-remove>Remover</button>` : ""}
    `;
    const removeBtn = row.querySelector("[data-remove]");
    if (removeBtn) {
      removeBtn.addEventListener("click", async () => {
        await sb.from("vacations").delete().eq("id", v.id);
        await loadVacations();
      });
    }
    list.appendChild(row);
  });
}

// ----------------------------------------------------------------------------
// Escala dos estagiários (por projeto/setor — somente administradores editam)
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
        errorEl.textContent = "Preencha nome, projeto/setor e a semana.";
        errorEl.classList.remove("hidden");
        return;
      }

      await sb.from("intern_assignments").insert({
        intern_name: name,
        project,
        notes: notes || null,
        week_start: mondayOfISOWeek(weekValue),
        created_by: currentUser.id,
      });

      document.getElementById("intern-name").value = "";
      document.getElementById("intern-project").value = "";
      document.getElementById("intern-notes").value = "";
      document.getElementById("intern-week").value = toISODate(getMondayOfWeek(new Date()));
      await loadInternSchedule();
    };
  } else {
    addBox.classList.add("hidden");
  }

  const { data: interns } = await sb
    .from("intern_assignments")
    .select("*")
    .order("week_start", { ascending: false })
    .order("project")
    .order("intern_name");

  const list = document.getElementById("interns-list");
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
    row.className = "flex items-center justify-between p-4 gap-4";
    row.innerHTML = `
      <div class="min-w-0">
        <p class="font-medium">${escapeHtml(i.intern_name)} <span class="text-brand-slate font-normal">— ${escapeHtml(i.project)}</span></p>
        ${i.notes ? `<p class="text-sm text-slate-500">${escapeHtml(i.notes)}</p>` : ""}
      </div>
      ${currentProfile?.is_admin ? `<button class="text-sm text-red-500 hover:underline shrink-0" data-remove>Remover</button>` : ""}
    `;
    const removeBtn = row.querySelector("[data-remove]");
    if (removeBtn) {
      removeBtn.addEventListener("click", async () => {
        await sb.from("intern_assignments").delete().eq("id", i.id);
        await loadInternSchedule();
      });
    }
    list.appendChild(row);
  });
}

// ----------------------------------------------------------------------------
// Manuais
// ----------------------------------------------------------------------------

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

      await sb.from("manuals").insert({
        title,
        category,
        storage_path: storagePath,
        file_name: file.name,
        created_by: currentUser.id,
      });

      document.getElementById("manual-title").value = "";
      document.getElementById("manual-category").value = "";
      fileInput.value = "";
      btn.disabled = false;
      btn.textContent = "Adicionar";
      await loadManuals();
    };
  } else {
    addBox.classList.add("hidden");
  }

  const { data: manuals } = await sb
    .from("manuals")
    .select("*")
    .order("category")
    .order("title");

  const list = document.getElementById("manuals-list");
  list.innerHTML = "";

  if (!manuals || manuals.length === 0) {
    list.innerHTML = `<p class="p-5 text-sm text-slate-400">Nenhum manual cadastrado ainda.</p>`;
    return;
  }

  manuals.forEach((m) => {
    const row = document.createElement("div");
    row.className = "flex items-center justify-between p-4 gap-4";
    row.innerHTML = `
      <div class="min-w-0">
        <button type="button" data-open class="font-medium text-brand-navy hover:underline text-left">${escapeHtml(m.title)}</button>
        ${m.category ? `<p class="text-sm text-slate-500">${escapeHtml(m.category)}</p>` : ""}
      </div>
      ${currentProfile?.is_admin ? `<button class="text-sm text-red-500 hover:underline shrink-0" data-remove>Remover</button>` : ""}
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
          await sb.storage.from("manuals").remove([m.storage_path]);
        }
        await sb.from("manuals").delete().eq("id", m.id);
        await loadManuals();
      });
    }

    list.appendChild(row);
  });
}

// ----------------------------------------------------------------------------
// Início
// ----------------------------------------------------------------------------

sb.auth.onAuthStateChange((_event, session) => {
  if (session?.user && !currentUser) {
    enterApp(session.user);
  }
});

boot();
