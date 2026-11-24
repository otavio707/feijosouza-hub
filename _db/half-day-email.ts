// =============================================================================
// half-day-email
// Avisa por e-mail as marcações das estagiárias ainda não avisadas, de DUAS tabelas:
//   - intern_half_days   (meio período em dia de prova)
//   - intern_shift_swaps (troca de turno: trabalhar de manhã em vez de à tarde)
// É chamada na hora pelo gatilho do banco e de hora em hora no horário comercial
// (pg_cron, seg-sex 8h-18h de Brasília). Para cada tabela com pendências envia UM
// e-mail a todas as pessoas ativas que não são estagiárias (admins e advogados)
// pelo Microsoft Graph (mesmas credenciais do Azure das outras funções).
//
// Segurança: "Verify JWT" fica DESLIGADO (o projeto usa chaves publishable) e a função exige o
// cabeçalho x-hub-secret (senha interna, ver abaixo). A reserva por notified_at/log é
// atômica e a resposta traz apenas contagens.
// =============================================================================

const TENANT_ID = Deno.env.get("AZURE_TENANT_ID")!;
const CLIENT_ID = Deno.env.get("AZURE_CLIENT_ID")!;
const CLIENT_SECRET = Deno.env.get("AZURE_CLIENT_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const SENDER = "otavio@feijosouza.com.br";

// Senha interna: o banco e o agendador enviam este cabeçalho em toda chamada. A senha
// fica só no painel de segredos do Supabase (HUB_FN_SECRET) e dentro do banco; nunca no
// repositório. Sem ela, a função responde 401 e não faz nada.
const HUB_FN_SECRET = Deno.env.get("HUB_FN_SECRET") || "";
function authorized(req: Request): boolean {
  const got = req.headers.get("x-hub-secret") || "";
  if (!HUB_FN_SECRET || got.length !== HUB_FN_SECRET.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ HUB_FN_SECRET.charCodeAt(i);
  return diff === 0;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function rest(path: string, init: RequestInit & { prefer?: string } = {}) {
  const headers: Record<string, string> = {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
  if (init.prefer) headers["Prefer"] = init.prefer;
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method: init.method, body: init.body, headers });
  if (!resp.ok) throw new Error(`Supabase ${path.split("?")[0]}: ${resp.status} ${await resp.text()}`);
  const text = await resp.text();
  return text ? JSON.parse(text) : null;
}

async function getGraphToken(): Promise<string> {
  const resp = await fetch(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: "https://graph.microsoft.com/.default",
    }),
  });
  if (!resp.ok) throw new Error(`Falha ao obter token do Microsoft Graph: ${resp.status}`);
  const data = await resp.json();
  return data.access_token as string;
}

async function sendGraphMail(token: string, toEmails: string[], subject: string, content: string) {
  const resp = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(SENDER)}/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: "Text", content },
        toRecipients: toEmails.map((email) => ({ emailAddress: { address: email } })),
      },
      saveToSentItems: "true",
    }),
  });
  if (!resp.ok) throw new Error(`Falha ao enviar e-mail via Microsoft Graph: ${resp.status}`);
}

// Data de hoje no fuso de Brasília (YYYY-MM-DD).
function todayBR(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(new Date());
}

function formatBR(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

const WEEKDAYS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
function weekday(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

type Row = { id: string; user_id: string; day: string };

type Kind = {
  table: string;
  // filtro extra de dias pendentes (ex.: meio período só de hoje em diante)
  pendingFilter: (today: string) => string;
  subject: (rows: Row[], nameOf: Map<string, string>) => string;
  line: (name: string, row: Row) => string;
  intro: string;
  outro: string;
};

const KINDS: Kind[] = [
  {
    table: "intern_half_days",
    pendingFilter: (today) => `&day=gte.${today}`,
    subject: (rows, nameOf) =>
      rows.length === 1
        ? `Meio período (prova): ${nameOf.get(rows[0].user_id) || "Estagiária"} em ${formatBR(rows[0].day)}`
        : `Meio período (prova): ${rows.length} marcações de estagiárias`,
    line: (name, r) => `• ${name} — ${formatBR(r.day)} (${weekday(r.day)}): meia tarde por causa de prova`,
    intro:
      "As seguintes estagiárias marcaram meio período no Hub por causa de prova na faculdade (Lei do Estágio, art. 10, §2º):",
    outro: "As marcações também aparecem no Calendário da equipe.",
  },
  {
    table: "intern_shift_swaps",
    pendingFilter: () => "",
    subject: (rows, nameOf) =>
      rows.length === 1
        ? `Troca de turno: ${nameOf.get(rows[0].user_id) || "Estagiária"} trabalha de manhã em ${formatBR(rows[0].day)}`
        : `Troca de turno: ${rows.length} marcações de estagiárias (manhã)`,
    line: (name, r) =>
      `• ${name} — ${formatBR(r.day)} (${weekday(r.day)}): vai trabalhar de MANHÃ, em vez de à tarde (mesmo expediente de 5 horas)`,
    intro: "As seguintes estagiárias marcaram no Hub que vão trabalhar de manhã, em vez de à tarde:",
    outro: "O horário de manhã vale só nos dias indicados; nos demais dias o expediente continua à tarde.",
  },
];

// Processa uma tabela: reserva atomicamente as marcações ainda não avisadas e envia
// UM e-mail. Se algo falhar, libera a reserva para a próxima execução tentar de novo.
async function processKind(kind: Kind, dryRun: boolean): Promise<Record<string, unknown>> {
  let claimedIds: string[] = [];
  try {
    const today = todayBR();
    const pending: { id: string }[] =
      (await rest(`${kind.table}?select=id&notified_at=is.null${kind.pendingFilter(today)}`)) || [];
    if (!pending.length) return { table: kind.table, sent: false, count: 0 };
    if (dryRun) return { table: kind.table, sent: false, dryRun: true, count: pending.length };

    const ids = pending.map((p) => p.id).join(",");
    const claimed: Row[] =
      (await rest(`${kind.table}?notified_at=is.null&id=in.(${ids})&select=id,user_id,day`, {
        method: "PATCH",
        prefer: "return=representation",
        body: JSON.stringify({ notified_at: new Date().toISOString() }),
      })) || [];
    if (!claimed.length) return { table: kind.table, sent: false, already: true };
    claimedIds = claimed.map((c) => c.id);

    const userIds = [...new Set(claimed.map((c) => c.user_id))].join(",");
    const people: { id: string; full_name: string | null; email: string }[] =
      (await rest(`profiles?select=id,full_name,email&id=in.(${userIds})`)) || [];
    const nameOf = new Map(people.map((p) => [p.id, p.full_name || p.email]));

    const recipients: { email: string }[] =
      (await rest("profiles?select=email&is_intern=eq.false&left_at=is.null&email=not.is.null")) || [];
    const toEmails = recipients.map((r) => r.email).filter(Boolean);
    if (!toEmails.length) throw new Error("sem destinatários");

    const sorted = [...claimed].sort((a, b) => a.day.localeCompare(b.day));
    const lines = sorted.map((c) => kind.line(nameOf.get(c.user_id) || "Estagiária", c)).join("\n");
    const subject = kind.subject(sorted, nameOf);
    const content = `Olá!\n\n${kind.intro}\n\n${lines}\n\n${kind.outro}\n\n— Hub Feijó Souza (mensagem automática)`;

    const token = await getGraphToken();
    await sendGraphMail(token, toEmails, subject, content);
    return { table: kind.table, sent: true, count: claimed.length };
  } catch (e) {
    console.error(`half-day-email (${kind.table}):`, e);
    if (claimedIds.length) {
      try {
        await rest(`${kind.table}?id=in.(${claimedIds.join(",")})`, {
          method: "PATCH",
          body: JSON.stringify({ notified_at: null }),
        });
      } catch (e2) {
        console.error(`half-day-email (liberar reserva, ${kind.table}):`, e2);
      }
    }
    return { table: kind.table, error: true };
  }
}

Deno.serve(async (req) => {
  if (!authorized(req)) return json({ error: "não autorizado" }, 401);
  let dryRun = false;
  try {
    const body = await req.json();
    dryRun = body?.dryRun === true;
  } catch (_) { /* corpo vazio */ }

  const results = [];
  for (const kind of KINDS) results.push(await processKind(kind, dryRun));
  const failed = results.some((r) => r.error);
  return json({ results }, failed ? 500 : 200);
});
