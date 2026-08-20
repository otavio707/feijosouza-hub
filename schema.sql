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
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
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
-- update public.profiles set is_admin = true where email = 'otavio@feijosouza.com.br';

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
