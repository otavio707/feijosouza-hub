// =============================================================================
// half-day-email
// Roda de hora em hora no horário comercial (pg_cron, seg-sex 8h-18h de Brasília).
// Se houver marcações de meio período (prova) das estagiárias ainda não avisadas,
// envia UM e-mail a todas as pessoas ativas que não são estagiárias (admins e
// advogados) pelo Microsoft Graph (mesmas credenciais do Azure das outras funções).
//
// Segurança: "Verify JWT" fica DESLIGADO (o projeto usa chaves publishable). O que
// protege é o desenho: a função não recebe dados de quem chama; o e-mail só vai
// para o escritório; a reserva por notified_at é atômica, então chamá-la várias
// vezes não gera e-mail repetido; e a resposta traz apenas contagens.
// =============================================================================

const TENANT_ID = Deno.env.get("AZURE_TENANT_ID")!;
const CLIENT_ID = Deno.env.get("AZURE_CLIENT_ID")!;
const CLIENT_SECRET = Deno.env.get("AZURE_CLIENT_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const SENDER = "otavio@feijosouza.com.br";

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

Deno.serve(async (req) => {
  let claimedIds: string[] = [];
  try {
    let dryRun = false;
    try {
      const body = await req.json();
      dryRun = body?.dryRun === true;
    } catch (_) { /* corpo vazio */ }

    const today = todayBR();
    const pending: { id: string }[] =
      (await rest(`intern_half_days?select=id&notified_at=is.null&day=gte.${today}`)) || [];
    if (!pending.length) return json({ sent: false, count: 0 });
    if (dryRun) return json({ sent: false, dryRun: true, count: pending.length });

    // Reserva atômica: só segue com as marcações que ainda ninguém avisou.
    const ids = pending.map((p) => p.id).join(",");
    const claimed: { id: string; user_id: string; day: string }[] =
      (await rest(`intern_half_days?notified_at=is.null&id=in.(${ids})&select=id,user_id,day`, {
        method: "PATCH",
        prefer: "return=representation",
        body: JSON.stringify({ notified_at: new Date().toISOString() }),
      })) || [];
    if (!claimed.length) return json({ sent: false, already: true });
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
    const lines = sorted
      .map((c) => `• ${nameOf.get(c.user_id) || "Estagiária"} — ${formatBR(c.day)} (${weekday(c.day)}): meia tarde por causa de prova`)
      .join("\n");
    const first = sorted[0];
    const subject = sorted.length === 1
      ? `Meio período (prova): ${nameOf.get(first.user_id) || "Estagiária"} em ${formatBR(first.day)}`
      : `Meio período (prova): ${sorted.length} marcações de estagiárias`;
    const content = `Olá!\n\nAs seguintes estagiárias marcaram meio período no Hub por causa de prova na faculdade ` +
      `(Lei do Estágio, art. 10, §2º):\n\n${lines}\n\n` +
      `As marcações também aparecem no Calendário da equipe.\n\n— Hub Feijó Souza (mensagem automática)`;

    const token = await getGraphToken();
    await sendGraphMail(token, toEmails, subject, content);
    return json({ sent: true, count: claimed.length });
  } catch (e) {
    console.error("half-day-email:", e);
    // Libera a reserva para a próxima execução tentar de novo.
    if (claimedIds.length) {
      try {
        await rest(`intern_half_days?id=in.(${claimedIds.join(",")})`, {
          method: "PATCH",
          body: JSON.stringify({ notified_at: null }),
        });
      } catch (e2) {
        console.error("half-day-email (liberar reserva):", e2);
      }
    }
    return json({ error: "falha ao processar" }, 500);
  }
});
