-- Buqo – Rechnungen per E-Mail-Weiterleitung (Resend Inbound)
-- Unabhängig von der Gmail-Integration: Warteschlange für Rechnungs-Anhänge,
-- die an eine per Resend empfangende Adresse (z. B. rechnungen@inbound.designpeak.io)
-- weitergeleitet bzw. direkt dorthin geschickt wurden.
-- Ausführen im Supabase SQL-Editor, siehe RESEND_INBOUND_SETUP.md.

create table if not exists public.resend_import_queue (
  id uuid primary key default gen_random_uuid(),
  email_id text not null,
  attachment_id text not null,
  from_email text,
  to_email text,
  subject text,
  received_at timestamptz,
  extracted jsonb,
  file_path text,
  status text not null default 'pending' check (status in ('pending','imported','dismissed','failed')),
  error text,
  created_at timestamptz not null default now(),
  unique (email_id, attachment_id)
);

alter table public.resend_import_queue enable row level security;

drop policy if exists resend_queue_select_authenticated on public.resend_import_queue;
create policy resend_queue_select_authenticated on public.resend_import_queue
  for select to authenticated using (true);

-- Nutzer markiert eine Zeile als übernommen, sobald sie in die Entwürfe eingereiht wurde.
drop policy if exists resend_queue_update_authenticated on public.resend_import_queue;
create policy resend_queue_update_authenticated on public.resend_import_queue
  for update to authenticated using (true) with check (true);

revoke all on public.resend_import_queue from authenticated, anon;
grant select on public.resend_import_queue to authenticated;
grant update (status) on public.resend_import_queue to authenticated;
-- service_role (Edge Function "resend-inbound") umgeht RLS und schreibt neue Zeilen.

create index if not exists resend_import_queue_status_idx on public.resend_import_queue (status);
