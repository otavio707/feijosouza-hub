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

  setupTabs();
  await Promise.all([
    loadHomeOffice(),
    loadBirthdays(),
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
// Tabs
// ----------------------------------------------------------------------------

function setupTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
      btn.classList.add("active");
      document.getElementById(`tab-${btn.dataset.tab}`).classList.remove("hidden");
    });
  });
  document.querySelector('.tab-btn[data-tab="homeoffice"]').classList.add("active");
}

// ----------------------------------------------------------------------------
// Utilidades de data
// ----------------------------------------------------------------------------

function toISODate(d) {
  return d.toISOString().slice(0, 10);
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
    sb.from("homeoffice_entries").select("user_id, entry_date").in("entry_date", isoDates),
  ]);

  renderMyWeekToggles(isoDates, entries || []);
  renderTeamWeekTable(weekDates, profiles || [], entries || []);
}

function renderMyWeekToggles(isoDates, entries) {
  const container = document.getElementById("my-week-days");
  container.innerHTML = "";
  const myEntrySet = new Set(
    entries.filter((e) => e.user_id === currentUser.id).map((e) => e.entry_date)
  );

  isoDates.forEach((iso, i) => {
    const btn = document.createElement("button");
    btn.className = "day-toggle" + (myEntrySet.has(iso) ? " active" : "");
    btn.textContent = `${WEEKDAY_LABELS[i]} ${formatDateBR(iso).slice(0, 5)}`;
    btn.addEventListener("click", async () => {
      if (myEntrySet.has(iso)) {
        await sb.from("homeoffice_entries").delete().eq("user_id", currentUser.id).eq("entry_date", iso);
      } else {
        await sb.from("homeoffice_entries").insert({ user_id: currentUser.id, entry_date: iso });
      }
      await loadHomeOffice();
    });
    container.appendChild(btn);
  });
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
    const nameCell = `<td class="py-2 pr-4 font-medium">${p.full_name || p.email}</td>`;
    const dayCells = isoDates
      .map((iso) => {
        const has = entries.some((e) => e.user_id === p.id && e.entry_date === iso);
        return `<td class="py-2 px-2 text-center">${has ? "🏠" : ""}</td>`;
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
    await loadBirthdays();
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
        <p class="font-medium">${p.full_name || p.email}</p>
        <p class="text-sm text-slate-500">${formatDateBR(p.birth_date).slice(0, 5)}</p>
      </div>
      ${badge}
    `;
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
      const url = document.getElementById("manual-url").value.trim();
      if (!title || !url) return;
      await sb.from("manuals").insert({ title, category, url, created_by: currentUser.id });
      document.getElementById("manual-title").value = "";
      document.getElementById("manual-category").value = "";
      document.getElementById("manual-url").value = "";
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
        <a href="${m.url}" target="_blank" rel="noopener" class="font-medium text-brand-navy hover:underline">${m.title}</a>
        ${m.category ? `<p class="text-sm text-slate-500">${m.category}</p>` : ""}
      </div>
      ${currentProfile?.is_admin ? `<button class="text-sm text-red-500 hover:underline shrink-0" data-id="${m.id}">Remover</button>` : ""}
    `;
    if (currentProfile?.is_admin) {
      row.querySelector("button").addEventListener("click", async () => {
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
