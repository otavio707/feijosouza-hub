// =============================================================================
// work-anniversary-email
// Roda todo dia (pg_cron, 8h de Brasília). Se alguém completa aniversário de
// casa HOJE, envia UM e-mail aos administradores pelo Microsoft Graph (as mesmas
// credenciais do Azure da função notify-announcement), com o remetente abaixo.
//
// Segurança: este projeto usa chaves "publishable" (não JWT), então a função é
// publicada com "Verify JWT" DESLIGADO. O que protege é o desenho: o e-mail só
// vai para administradores, só existe quando há aniversário de casa HOJE e a
// tabela anniversary_email_log impede que a mesma pessoa gere dois e-mails na
// mesma data, mesmo que a função seja chamada várias vezes por qualquer um.
// A resposta traz apenas contagens, nunca nomes ou datas de admissão.
// =============================================================================

const TENANT_ID = Deno.env.get("AZURE_TENANT_ID")!;
const CLIENT_ID = Deno.env.get("AZURE_CLIENT_ID")!;
const CLIENT_SECRET = Deno.env.get("AZURE_CLIENT_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

// Caixa do escritório de onde sai o e-mail.
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
  if (!resp.ok) throw new Error(`Falha ao obter token do Microsoft Graph: ${resp.status} ${await resp.text()}`);
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
  if (!resp.ok) throw new Error(`Falha ao enviar e-mail via Microsoft Graph: ${resp.status} ${await resp.text()}`);
}

// Data de hoje no fuso de Brasília (YYYY-MM-DD).
function todayBR(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(new Date());
}

Deno.serve(async (req) => {
  let claimed: { user_id: string }[] = [];
  const today = todayBR();
  try {
    let dryRun = false;
    try {
      const body = await req.json();
      dryRun = body?.dryRun === true;
    } catch (_) { /* corpo vazio */ }

    const admins = await rest("profiles?select=email&is_admin=eq.true&email=not.is.null");
    const adminEmails: string[] = (admins || []).map((a: { email: string }) => a.email).filter(Boolean);
    if (!adminEmails.length) return json({ sent: false, reason: "sem administradores" });

    const rows: { user_id: string; full_name: string; years: number }[] =
      (await rest("rpc/work_anniversaries", {
        method: "POST",
        body: JSON.stringify({ d_from: today, d_to: today }),
      })) || [];
    if (!rows.length) return json({ sent: false, count: 0 });
    if (dryRun) return json({ sent: false, dryRun: true, count: rows.length, recipients: adminEmails.length });

    // Reserva as linhas: só segue com quem ainda não gerou e-mail nesta data.
    claimed = (await rest("anniversary_email_log?on_conflict=user_id,anniversary", {
      method: "POST",
      prefer: "resolution=ignore-duplicates,return=representation",
      body: JSON.stringify(rows.map((r) => ({ user_id: r.user_id, anniversary: today }))),
    })) || [];
    if (!claimed.length) return json({ sent: false, already: true });

    const claimedIds = new Set(claimed.map((c) => c.user_id));
    const people = rows.filter((r) => claimedIds.has(r.user_id));
    const yearsText = (n: number) => `${n} ${n === 1 ? "ano" : "anos"} de casa`;
    const first = people[0];
    const subject = people.length === 1
      ? `Anos de casa hoje: ${first.full_name} (${yearsText(first.years)})`
      : `Anos de casa hoje: ${people.length} pessoas`;
    const lines = people.map((p) => `• ${p.full_name} — ${yearsText(p.years)}`).join("\n");
    const content = `Olá!\n\nHoje é aniversário de casa de:\n\n${lines}\n\n` +
      `Que tal mandar uma mensagem de parabéns?\n\n— Hub Feijó Souza (mensagem automática)`;

    const token = await getGraphToken();
    await sendGraphMail(token, adminEmails, subject, content);
    return json({ sent: true, count: people.length });
  } catch (e) {
    console.error("work-anniversary-email:", e);
    // Libera a reserva para que a próxima execução tente de novo.
    if (claimed.length) {
      try {
        const ids = claimed.map((c) => c.user_id).join(",");
        await rest(`anniversary_email_log?anniversary=eq.${today}&user_id=in.(${ids})`, { method: "DELETE" });
      } catch (e2) {
        console.error("work-anniversary-email (liberar reserva):", e2);
      }
    }
    return json({ error: "falha ao processar" }, 500);
  }
});
