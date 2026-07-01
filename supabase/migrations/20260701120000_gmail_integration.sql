-- Buqo – Gmail-Integration: verbundene Postfächer + Warteschlange erkannter Rechnungen
-- Ausführen im Supabase SQL-Editor (oder via `supabase db push`) BEVOR die gmail-* Edge Functions deployed werden.

-- Verbundene Gmail-Postfächer (OAuth-Refresh-Token). Nur der Service-Role-Key (Edge Functions)
-- darf Token-Spalten lesen/schreiben – eingeloggte App-Nutzer sehen nur den öffentlichen Teil (siehe GRANTs unten).
create table if not exists public.gmail_accounts (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  refresh_token text not null,
  access_token text,
  token_expiry timestamptz,
  status text not null default 'connected' check (status in ('connected','error','disconnected')),
  last_sync_at timestamptz,
  last_error text,
  connected_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.gmail_accounts enable row level security;

-- Eingeloggte Nutzer dürfen die Liste sehen (Status/Zeitpunkt), aber NICHT die Tokens (Spalten-Rechte unten).
drop policy if exists gmail_accounts_select_authenticated on public.gmail_accounts;
create policy gmail_accounts_select_authenticated on public.gmail_accounts
  for select to authenticated using (true);

-- Nutzer dürfen ein Postfach trennen (nur Status), z. B. "Verbindung trennen" in den Einstellungen.
drop policy if exists gmail_accounts_update_authenticated on public.gmail_accounts;
create policy gmail_accounts_update_authenticated on public.gmail_accounts
  for update to authenticated using (true) with check (true);

revoke all on public.gmail_accounts from authenticated, anon;
grant select (id, email, status, last_sync_at, last_error, created_at) on public.gmail_accounts to authenticated;
grant update (status) on public.gmail_accounts to authenticated;
-- service_role (von den Edge Functions verwendet) umgeht RLS und hat als Tabellen-Owner vollen Zugriff.

-- Aus Gmail gefundene Anhänge, die die KI bereits ausgelesen hat – warten auf Bestätigung durch den Nutzer.
-- Wird vom Client in die bestehenden Bankauszug-„Entwürfe" übernommen (siehe addImportDrafts in index.html).
create table if not exists public.gmail_import_queue (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.gmail_accounts(id) on delete cascade,
  message_id text not null,
  thread_id text,
  received_at timestamptz,
  from_email text,
  subject text,
  extracted jsonb,
  file_path text,
  status text not null default 'pending' check (status in ('pending','imported','dismissed','failed')),
  error text,
  created_at timestamptz not null default now(),
  unique (account_id, message_id)
);

alter table public.gmail_import_queue enable row level security;

drop policy if exists gmail_queue_select_authenticated on public.gmail_import_queue;
create policy gmail_queue_select_authenticated on public.gmail_import_queue
  for select to authenticated using (true);

-- Nutzer markiert eine Zeile als übernommen/verworfen, sobald sie in die Entwürfe eingereiht wurde.
drop policy if exists gmail_queue_update_authenticated on public.gmail_import_queue;
create policy gmail_queue_update_authenticated on public.gmail_import_queue
  for update to authenticated using (true) with check (true);

revoke all on public.gmail_import_queue from authenticated, anon;
grant select on public.gmail_import_queue to authenticated;
grant update (status) on public.gmail_import_queue to authenticated;

create index if not exists gmail_import_queue_status_idx on public.gmail_import_queue (status);

-- ── Optional: automatischer Hintergrund-Sync per pg_cron ──────────────────────────────
-- Dieses Skript legt den Cron-Job NICHT selbst an, weil dafür der Service-Role-Key nötig ist
-- (ein Geheimnis, das nicht in Git landen darf). Bitte NACH dem Deploy der Edge Function
-- "gmail-sync" folgenden Block im Supabase SQL-Editor ausführen (Projekt-Einstellungen →
-- Database → Extensions: "pg_cron" und "pg_net" aktivieren, falls noch nicht geschehen):
--
-- select cron.schedule(
--   'gmail-sync-every-15-min',
--   '*/15 * * * *',
--   $$
--   select net.http_post(
--     url := 'https://<DEIN-PROJEKT-REF>.supabase.co/functions/v1/gmail-sync',
--     headers := jsonb_build_object(
--       'Authorization', 'Bearer <DEIN-SERVICE-ROLE-KEY>',
--       'Content-Type', 'application/json'
--     ),
--     body := '{}'::jsonb
--   );
--   $$
-- );
--
-- Zum Entfernen: select cron.unschedule('gmail-sync-every-15-min');
