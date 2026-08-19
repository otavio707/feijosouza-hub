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
        <button type="button" data-open class="font-medium text-brand-navy hover:underline text-left">${m.title}</button>
        ${m.category ? `<p class="text-sm text-slate-500">${m.category}</p>` : ""}
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
