-- ============================================================================
-- Hub Feijó Souza — schema do banco de dados (Supabase / Postgres)
-- ============================================================================
-- Como usar: no painel do Supabase, vá em "SQL Editor" > "New query",
-- cole todo este arquivo e clique em "Run". Ele cria as tabelas, as regras
-- de segurança (RLS) e o gatilho que cria automaticamente o perfil de cada
-- pessoa na primeira vez que ela faz login.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. PROFILES — um registro por pessoa do escritório
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text,
  birth_date date,          -- aniversário da pessoa (dia/mês; o ano é ignorado na exibição)
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Qualquer pessoa autenticada pode VER todos os perfis (nomes e aniversários)
create policy "profiles_select_all_authenticated"
  on public.profiles for select
  to authenticated
  using (true);

-- Cada pessoa só pode ATUALIZAR o próprio nome e data de aniversário
-- (o campo is_admin é ignorado pela política de coluna abaixo; promoção a
-- admin deve ser feita manualmente pelo SQL Editor, nunca pelo app)
create policy "profiles_update_own"
  on public.profiles for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- ----------------------------------------------------------------------------
-- 2. HOMEOFFICE_ENTRIES — dias de home office indicados por cada pessoa
-- ----------------------------------------------------------------------------
create table if not exists public.homeoffice_entries (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  entry_date date not null,
  created_at timestamptz not null default now(),
  unique (user_id, entry_date)
);

alter table public.homeoffice_entries enable row level security;

-- Todos podem VER a escala de todo mundo (para saber quem estará no escritório)
create policy "homeoffice_select_all_authenticated"
  on public.homeoffice_entries for select
  to authenticated
  using (true);

-- Cada pessoa só pode marcar/desmarcar os PRÓPRIOS dias
create policy "homeoffice_insert_own"
  on public.homeoffice_entries for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "homeoffice_delete_own"
  on public.homeoffice_entries for delete
  to authenticated
  using (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- 3. OFFICE_SETTINGS — configurações gerais (ex.: data de fundação do escritório)
-- ----------------------------------------------------------------------------
create table if not exists public.office_settings (
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
);

alter table public.office_settings enable row level security;

create policy "settings_select_all_authenticated"
  on public.office_settings for select
  to authenticated
  using (true);

-- Somente administradores podem alterar configurações
create policy "settings_admin_write"
  on public.office_settings for all
  to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

-- Valor inicial de exemplo — troque a data pela data real de fundação do escritório
insert into public.office_settings (key, value)
values ('office_founding_date', '2010-01-01')
on conflict (key) do nothing;

-- ----------------------------------------------------------------------------
-- 4. MANUALS — manuais e procedimentos do escritório (links para os arquivos)
-- ----------------------------------------------------------------------------
create table if not exists public.manuals (
  id bigint generated always as identity primary key,
  title text not null,
  category text,
  url text not null,
  created_by uuid references public.profiles (id),
  updated_at timestamptz not null default now()
);

alter table public.manuals enable row level security;

create policy "manuals_select_all_authenticated"
  on public.manuals for select
  to authenticated
  using (true);

create policy "manuals_admin_write"
  on public.manuals for all
  to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

-- ----------------------------------------------------------------------------
-- 5. Gatilho: cria automaticamente um perfil quando alguém faz login por vez
-- ----------------------------------------------------------------------------
-- OBS (atualizado depois, ver seção 15): esta função também trava o domínio
-- do e-mail (só @feijosouza.com.br), como defesa em profundidade além da
-- config. do Azure AD. O corpo abaixo já reflete essa versão atualizada.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if new.email is null or new.email not ilike '%@feijosouza.com.br' then
    raise exception 'Domínio de e-mail não autorizado para o Hub Feijó Souza: %', new.email;
  end if;

  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'name', new.raw_user_meta_data ->> 'full_name', new.email)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ----------------------------------------------------------------------------
-- 6. Depois de rodar este script e a primeira pessoa (você) fizer login pelo
--    site uma vez, torne-se administrador rodando (troque o e-mail):
-- ----------------------------------------------------------------------------
-- update public.profiles set is_admin = true where email = 'seu-email@feijosouza.com.br';

-- ----------------------------------------------------------------------------
-- 7. MANUALS — upload de arquivo (Word/PDF) direto no hub, em vez de link
--    externo. Os arquivos ficam num bucket PRIVADO do Supabase Storage:
--    só quem estiver logado no hub consegue abrir, através de um link
--    temporário gerado na hora pelo próprio app.
-- ----------------------------------------------------------------------------
alter table public.manuals
  add column if not exists storage_path text,
  add column if not exists file_name text;

alter table public.manuals
  alter column url drop not null;

insert into storage.buckets (id, name, public)
values ('manuals', 'manuals', false)
on conflict (id) do nothing;

drop policy if exists "manuals_bucket_select_authenticated" on storage.objects;
create policy "manuals_bucket_select_authenticated"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'manuals');

drop policy if exists "manuals_bucket_admin_insert" on storage.objects;
create policy "manuals_bucket_admin_insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'manuals'
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

drop policy if exists "manuals_bucket_admin_update" on storage.objects;
create policy "manuals_bucket_admin_update"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'manuals'
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

drop policy if exists "manuals_bucket_admin_delete" on storage.objects;
create policy "manuals_bucket_admin_delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'manuals'
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

-- ----------------------------------------------------------------------------
-- 8. ANNOUNCEMENTS — avisos do escritório (somente administradores publicam)
-- ----------------------------------------------------------------------------
create table if not exists public.announcements (
  id bigint generated always as identity primary key,
  title text not null,
  body text not null,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);

alter table public.announcements enable row level security;

drop policy if exists "announcements_select_all_authenticated" on public.announcements;
create policy "announcements_select_all_authenticated"
  on public.announcements for select
  to authenticated
  using (true);

drop policy if exists "announcements_admin_write" on public.announcements;
create policy "announcements_admin_write"
  on public.announcements for all
  to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

-- ----------------------------------------------------------------------------
-- 9. VACATIONS — férias de cada pessoa (cada um cadastra as próprias)
-- ----------------------------------------------------------------------------
create table if not exists public.vacations (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  start_date date not null,
  end_date date not null,
  created_at timestamptz not null default now(),
  constraint vacations_dates_check check (end_date >= start_date)
);

alter table public.vacations enable row level security;

drop policy if exists "vacations_select_all_authenticated" on public.vacations;
create policy "vacations_select_all_authenticated"
  on public.vacations for select
  to authenticated
  using (true);

drop policy if exists "vacations_insert_own" on public.vacations;
create policy "vacations_insert_own"
  on public.vacations for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "vacations_delete_own" on public.vacations;
create policy "vacations_delete_own"
  on public.vacations for delete
  to authenticated
  using (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- 10. INTERN_ASSIGNMENTS — escala dos estagiários por projeto/setor
--     (estagiários não usam login próprio; somente administradores cadastram)
-- ----------------------------------------------------------------------------
create table if not exists public.intern_assignments (
  id bigint generated always as identity primary key,
  intern_name text not null,
  project text not null,
  notes text,
  created_by uuid references public.profiles (id),
  updated_at timestamptz not null default now()
);

alter table public.intern_assignments enable row level security;

drop policy if exists "intern_assignments_select_all_authenticated" on public.intern_assignments;
create policy "intern_assignments_select_all_authenticated"
  on public.intern_assignments for select
  to authenticated
  using (true);

drop policy if exists "intern_assignments_admin_write" on public.intern_assignments;
create policy "intern_assignments_admin_write"
  on public.intern_assignments for all
  to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

-- ----------------------------------------------------------------------------
-- 11. INTERN_ASSIGNMENTS — alocação passa a ser por semana (segunda-feira
--     da semana em questão), em vez de uma lista única sem data.
-- ----------------------------------------------------------------------------
alter table public.intern_assignments
  add column if not exists week_start date;

-- ----------------------------------------------------------------------------
-- 12. HOMEOFFICE_ENTRIES — passa a ser por período (manhã/tarde), permitindo
--     até 4 períodos por semana (equivalente a 2 dias inteiros).
-- ----------------------------------------------------------------------------
alter table public.homeoffice_entries
  drop constraint if exists homeoffice_entries_user_id_entry_date_key;

alter table public.homeoffice_entries
  add column if not exists period text not null default 'manha';

alter table public.homeoffice_entries
  drop constraint if exists homeoffice_entries_period_check;
alter table public.homeoffice_entries
  add constraint homeoffice_entries_period_check check (period in ('manha', 'tarde'));

alter table public.homeoffice_entries
  drop constraint if exists homeoffice_entries_user_date_period_key;
alter table public.homeoffice_entries
  add constraint homeoffice_entries_user_date_period_key unique (user_id, entry_date, period);

-- ----------------------------------------------------------------------------
-- 13. Estagiárias passam a ter login próprio e marcam home office com um
--     toggle simples de um período por dia (sem manhã/tarde, sem o limite de
--     4 períodos que vale para os advogados).
-- ----------------------------------------------------------------------------
alter table public.profiles
  add column if not exists is_intern boolean not null default false;

alter table public.homeoffice_entries
  drop constraint if exists homeoffice_entries_period_check;
alter table public.homeoffice_entries
  add constraint homeoffice_entries_period_check check (period in ('manha', 'tarde', 'dia'));

-- Depois que a estagiária fizer login pelo menos uma vez, marque-a como
-- estagiária rodando (troque o e-mail):
-- update public.profiles set is_intern = true where email = 'email.da.estagiaria@feijosouza.com.br';

-- ----------------------------------------------------------------------------
-- 14. Segurança: trava is_admin/is_intern contra alteração pelo próprio app,
--     e permite EDITAR (em vez de só apagar e recriar) avisos, férias e
--     alocação de estagiários.
-- ----------------------------------------------------------------------------

-- A política "profiles_update_own" (seção 1) só restringe QUAL linha cada
-- pessoa pode atualizar, não QUAIS COLUNAS. Este gatilho bloqueia a troca de
-- is_admin/is_intern sempre que o pedido vier autenticado como usuário comum
-- (via app/API) — só é possível alterar essas colunas rodando o SQL
-- diretamente pelo SQL Editor do Supabase.
create or replace function public.prevent_self_privilege_escalation()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if (new.is_admin is distinct from old.is_admin or new.is_intern is distinct from old.is_intern)
     and auth.role() = 'authenticated' then
    raise exception 'Alteração de is_admin/is_intern não é permitida pelo aplicativo. Peça a um administrador para alterar pelo SQL Editor do Supabase.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_prevent_self_privilege_escalation on public.profiles;
create trigger trg_prevent_self_privilege_escalation
  before update on public.profiles
  for each row execute procedure public.prevent_self_privilege_escalation();

drop policy if exists "announcements_admin_write" on public.announcements;
create policy "announcements_admin_write"
  on public.announcements for all
  to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

drop policy if exists "vacations_update_own" on public.vacations;
create policy "vacations_update_own"
  on public.vacations for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "intern_assignments_admin_write" on public.intern_assignments;
create policy "intern_assignments_admin_write"
  on public.intern_assignments for all
  to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

-- manuals_admin_write já é "for all" (cobre update também) — nada a fazer.

-- ----------------------------------------------------------------------------
-- 15. Trava de domínio no login, direto no banco (defesa em profundidade).
-- ----------------------------------------------------------------------------
-- O login é via Microsoft (Azure AD / Entra ID), e o App Registration está
-- configurado como "Somente minha organização" (single-tenant) — a própria
-- Microsoft já rejeita o login de qualquer conta fora do tenant da Feijó
-- Souza antes mesmo de chegar no Supabase. Essa é a trava principal.
--
-- Só que, até aqui, essa era a ÚNICA trava: o gatilho que cria o perfil no
-- primeiro login (handle_new_user, seção 5) nunca checava o domínio do
-- e-mail. Se um dia a config. do Azure mudar (de propósito ou sem querer),
-- ou um "guest" de outro domínio for convidado pro tenant, o app aceitaria
-- o login sem nenhum aviso.
--
-- A função handle_new_user (seção 5, já atualizada acima) agora também
-- rejeita qualquer e-mail que não termine em @feijosouza.com.br, derrubando
-- a criação da conta inteira no Supabase Auth (não só o perfil). Essa trava
-- vale mesmo que a configuração do Azure mude no futuro.
--
-- Testado em produção (dentro de uma transação com rollback, sem deixar
-- rastro): e-mail fora do domínio foi bloqueado com
-- "ERROR: P0001: Domínio de e-mail não autorizado..."; e-mail
-- @feijosouza.com.br passou normalmente.

-- ----------------------------------------------------------------------------
-- 16. FEEDBACK_ENTRIES — feedbacks dados por administradores para cada
--     colaborador(a), com suporte a data retroativa (created_at editável).
--     OBS: esta tabela já existia em produção (criada direto pelo SQL
--     Editor) e só foi documentada aqui depois — reconstruída a partir do
--     schema e das políticas confirmadas em produção em 2026-09-16.
-- ----------------------------------------------------------------------------
create table if not exists public.feedback_entries (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  body text not null,
  score smallint,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);

alter table public.feedback_entries enable row level security;

drop policy if exists "feedback_select_own_or_admin" on public.feedback_entries;
create policy "feedback_select_own_or_admin"
  on public.feedback_entries for select
  to authenticated
  using (
    auth.uid() = user_id
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

drop policy if exists "feedback_admin_write" on public.feedback_entries;
create policy "feedback_admin_write"
  on public.feedback_entries for all
  to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

-- ----------------------------------------------------------------------------
-- 17. EMPLOYEE_PROFILE_DETAILS — também já existe em produção, com RLS
--     ativado e as políticas "profile_details_select_own_or_admin" (SELECT,
--     mesmo padrão "própria linha OU admin" acima) e
--     "profile_details_admin_write" (ALL, somente admin) confirmadas em
--     2026-09-16 — mesmo padrão de segurança das demais tabelas deste
--     arquivo.
--
--     PENDENTE: as colunas exatas dessa tabela ainda não foram copiadas para
--     este arquivo (o acesso ao SQL Editor caiu no meio da revisão). Antes de
--     usar este arquivo para recriar o banco do zero, rode no SQL Editor do
--     Supabase e cole o resultado aqui:
--
--   select column_name, data_type, column_default, is_nullable
--   from information_schema.columns
--   where table_name = 'employee_profile_details'
--   order by ordinal_position;
-- ----------------------------------------------------------------------------

-- ----------------------------------------------------------------------------
-- 18. FÉRIAS — aprovação (pendente / aprovada / recusada)
-- ----------------------------------------------------------------------------
-- Regra do escritório: férias de MAIS DE 5 DIAS ÚTEIS precisam ser autorizadas
-- previamente. A regra é imposta aqui no banco (gatilho), e não só na tela,
-- porque a política "vacations_update_own" deixa cada pessoa editar a própria
-- linha e, sem o gatilho, alguém conseguiria se autoaprovar pela API.

alter table public.vacations
  add column if not exists status text not null default 'approved',
  add column if not exists decided_by uuid references public.profiles (id) on delete set null,
  add column if not exists decided_at timestamptz;

alter table public.vacations drop constraint if exists vacations_status_check;
alter table public.vacations
  add constraint vacations_status_check check (status in ('pending', 'approved', 'rejected'));

-- Páscoa (mesmo algoritmo de Meeus/Jones/Butcher usado em app.js).
create or replace function public.br_easter(y int)
returns date
language plpgsql
immutable
as $$
declare
  a int; b int; c int; d int; e int; f int; g int; h int; i int; k int; l int; m int;
  mo int; dy int;
begin
  a := y % 19;
  b := y / 100;
  c := y % 100;
  d := b / 4;
  e := b % 4;
  f := (b + 8) / 25;
  g := (b - f + 1) / 3;
  h := (19 * a + b - d - g + 15) % 30;
  i := c / 4;
  k := c % 4;
  l := (32 + 2 * e + 2 * i - h - k) % 7;
  m := (a + 11 * h + 22 * l) / 451;
  mo := (h + l - 7 * m + 114) / 31;
  dy := ((h + l - 7 * m + 114) % 31) + 1;
  return make_date(y, mo, dy);
end;
$$;

-- Feriado nacional (mesma lista de app.js: getBrazilHolidayEntries) OU data
-- cadastrada em public.holidays (recesso, feriado municipal etc.).
create or replace function public.br_is_holiday(d date)
returns boolean
language sql
stable
as $$
  select
    ((extract(month from d))::int, (extract(day from d))::int) in
      ((1, 1), (4, 21), (5, 1), (9, 7), (10, 12), (11, 2), (11, 15), (11, 20), (12, 25))
    or d in (
      public.br_easter((extract(year from d))::int) - 48,
      public.br_easter((extract(year from d))::int) - 47,
      public.br_easter((extract(year from d))::int) - 2,
      public.br_easter((extract(year from d))::int) + 60
    )
    or exists (select 1 from public.holidays h where h.date = d);
$$;

-- Dias úteis entre duas datas (inclusive): sem sábado/domingo nem feriados.
create or replace function public.br_business_days(s date, e date)
returns int
language sql
stable
as $$
  select count(*)::int
  from generate_series(s::timestamp, e::timestamp, interval '1 day') as g(d)
  where extract(isodow from g.d) < 6
    and not public.br_is_holiday(g.d::date);
$$;

-- Gatilho: define/protege o status conforme quem está agindo.
create or replace function public.vacations_enforce_approval()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  actor_is_admin boolean := false;
  days int;
begin
  -- Alterações feitas direto no SQL Editor (sem usuário autenticado) passam livres.
  if auth.role() is distinct from 'authenticated' then
    return new;
  end if;

  select coalesce(p.is_admin, false) into actor_is_admin
  from public.profiles p
  where p.id = auth.uid();

  if actor_is_admin then
    -- Administrador decide: registra quem e quando ao aprovar/recusar.
    if tg_op = 'UPDATE' and new.status is distinct from old.status then
      if new.status in ('approved', 'rejected') then
        new.decided_by := auth.uid();
        new.decided_at := now();
      else
        new.decided_by := null;
        new.decided_at := null;
      end if;
    end if;
    return new;
  end if;

  -- Pessoa comum: nunca decide o próprio status.
  if tg_op = 'INSERT'
     or new.start_date is distinct from old.start_date
     or new.end_date is distinct from old.end_date then
    days := public.br_business_days(new.start_date, new.end_date);
    new.status := case when days > 5 then 'pending' else 'approved' end;
    new.decided_by := null;
    new.decided_at := null;
  else
    new.status := old.status;
    new.decided_by := old.decided_by;
    new.decided_at := old.decided_at;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_vacations_enforce_approval on public.vacations;
create trigger trg_vacations_enforce_approval
  before insert or update on public.vacations
  for each row execute procedure public.vacations_enforce_approval();

-- Administradores podem aprovar/recusar (UPDATE) qualquer férias.
drop policy if exists "vacations_admin_update" on public.vacations;
create policy "vacations_admin_update"
  on public.vacations for update
  to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

-- ----------------------------------------------------------------------------
-- 19. FSA ESTUDOS — encontros (FSA Talks / FSA Debates) e seus materiais
-- ----------------------------------------------------------------------------
-- Encontros: só administradores cadastram/editam/removem; todos os logados leem.
-- Materiais: qualquer pessoa logada anexa; cada um remove o que enviou e
-- administradores removem qualquer um. Arquivos ficam no bucket PRIVADO "study",
-- dentro de uma pasta com o id de quem enviou, e são abertos por link temporário.

create table if not exists public.study_sessions (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('talk', 'debate')),
  title text not null check (char_length(title) between 1 and 200),
  description text check (description is null or char_length(description) <= 5000),
  session_date date not null,
  session_time time,
  location text check (location is null or char_length(location) <= 200),
  presenter_id uuid references public.profiles (id) on delete set null,
  summary text check (summary is null or char_length(summary) <= 10000),
  created_by uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);

create index if not exists study_sessions_date_idx on public.study_sessions (session_date);

alter table public.study_sessions enable row level security;

drop policy if exists "study_sessions_select_authenticated" on public.study_sessions;
create policy "study_sessions_select_authenticated"
  on public.study_sessions for select
  to authenticated
  using (true);

drop policy if exists "study_sessions_admin_write" on public.study_sessions;
create policy "study_sessions_admin_write"
  on public.study_sessions for all
  to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin));

create table if not exists public.study_materials (
  id bigint generated always as identity primary key,
  session_id bigint not null references public.study_sessions (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200),
  category text not null default 'reading_required'
    check (category in ('reading_required', 'reading_optional', 'presentation', 'other')),
  storage_path text,
  file_name text,
  url text check (url is null or url ~* '^https?://'),
  created_by uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at timestamptz not null default now(),
  check (storage_path is not null or url is not null)
);

create index if not exists study_materials_session_idx on public.study_materials (session_id);

alter table public.study_materials enable row level security;

drop policy if exists "study_materials_select_authenticated" on public.study_materials;
create policy "study_materials_select_authenticated"
  on public.study_materials for select
  to authenticated
  using (true);

-- Quem anexa precisa constar como autor e só pode apontar para a própria pasta.
drop policy if exists "study_materials_insert_own" on public.study_materials;
create policy "study_materials_insert_own"
  on public.study_materials for insert
  to authenticated
  with check (
    created_by = auth.uid()
    and (storage_path is null or storage_path like auth.uid()::text || '/%')
  );

drop policy if exists "study_materials_delete_own_or_admin" on public.study_materials;
create policy "study_materials_delete_own_or_admin"
  on public.study_materials for delete
  to authenticated
  using (
    created_by = auth.uid()
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
  );

-- Bucket privado: até 50 MB por arquivo; só PDF, Word, PowerPoint e Excel.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'study', 'study', false, 52428800,
  array[
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
)
on conflict (id) do nothing;

drop policy if exists "study_bucket_select_authenticated" on storage.objects;
create policy "study_bucket_select_authenticated"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'study');

drop policy if exists "study_bucket_insert_own_folder" on storage.objects;
create policy "study_bucket_insert_own_folder"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'study'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "study_bucket_delete_own_or_admin" on storage.objects;
create policy "study_bucket_delete_own_or_admin"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'study'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
    )
  );

-- ----------------------------------------------------------------------------
-- 20. PERMISSÕES EXPLÍCITAS (GRANT) PARA A DATA API DO SUPABASE
-- ----------------------------------------------------------------------------
-- A partir de 30/10/2026 o Supabase deixa de conceder acesso automático à
-- Data API (supabase-js, PostgREST, GraphQL) a tabelas NOVAS do schema public.
-- As tabelas que já existiam em produção mantêm as permissões que tinham, mas
-- quem recriar o banco a partir deste arquivo (projeto novo, branch de
-- preview, "supabase db reset") precisa destes GRANTs, senão a API responde
-- "permission denied".
--
-- Só o papel "authenticated" (pessoas logadas no Hub) e o "service_role"
-- precisam de acesso. O papel "anon" fica de fora de propósito: o Hub exige
-- login, e quem decide o que cada pessoa vê continua sendo a RLS (políticas
-- acima). O GRANT só abre a porta da API; a RLS controla linha a linha.
--
-- REGRA PARA O FUTURO: toda tabela nova do Hub deve trazer o seu GRANT no
-- mesmo bloco que a cria, por exemplo:
--   grant select, insert, update, delete on table public.nova_tabela to authenticated;
--   grant all on table public.nova_tabela to service_role;

-- OBS: a tabela public.employee_profile_details (dados do perfil: admissão,
-- saldo de férias manual e feedbacks) não é criada neste arquivo. Em um banco
-- novo, dê a ela os mesmos GRANTs (authenticated: select, insert, update,
-- delete; service_role: all) no mesmo bloco que a criar.

grant select, insert, update, delete on table
  public.profiles,
  public.feedback_entries,
  public.homeoffice_entries,
  public.vacations,
  public.holidays,
  public.office_settings,
  public.intern_assignments,
  public.manuals,
  public.announcements,
  public.study_sessions,
  public.study_materials
to authenticated;

grant all on table
  public.profiles,
  public.feedback_entries,
  public.homeoffice_entries,
  public.vacations,
  public.holidays,
  public.office_settings,
  public.intern_assignments,
  public.manuals,
  public.announcements,
  public.study_sessions,
  public.study_materials
to service_role;
