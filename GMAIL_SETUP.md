# Gmail-Integration einrichten

Diese Anleitung ergänzt den Code in `supabase/functions/gmail-*` und
`supabase/migrations/20260701120000_gmail_integration.sql`. Die Schritte hier
lassen sich **nicht** von Claude automatisieren, weil sie in eurem eigenen
Google-Cloud- bzw. Supabase-Dashboard passieren (Zugangsdaten, die niemals ins
Repo gehören).

Voraussetzung: Die zu verbindenden Postfächer liegen auf eurer eigenen
**Google-Workspace-Domain** (z. B. `@designpeak.io`). Damit könnt ihr die
OAuth-App als **"Intern"** einstellen – keine Google-Prüfung nötig, Tokens
laufen nicht nach 7 Tagen ab.

## 1. Google Cloud Projekt + Gmail API

1. [Google Cloud Console](https://console.cloud.google.com/) öffnen, neues
   Projekt anlegen (oder ein bestehendes verwenden).
2. **APIs & Dienste → Bibliothek** → "Gmail API" suchen → **Aktivieren**.
3. **APIs & Dienste → OAuth-Zustimmungsbildschirm**:
   - Nutzertyp: **Intern** (nur sichtbar, wenn ihr mit einem
     Google-Workspace-Konto eingeloggt seid).
   - App-Name, Support-E-Mail, Logo etc. ausfüllen.
   - Scope hinzufügen: `.../auth/gmail.readonly`, `email`, `openid`.
4. **APIs & Dienste → Anmeldedaten → Anmeldedaten erstellen → OAuth-Client-ID**:
   - Anwendungstyp: **Web-Anwendung**.
   - Autorisierte Weiterleitungs-URI:
     `https://rlorfhpgxmyplmsgmkzw.supabase.co/functions/v1/gmail-oauth-callback`
   - Client-ID und Client-Secret notieren (nur in Supabase-Secrets hinterlegen,
     niemals committen).

## 2. Supabase-Secrets setzen

Im Supabase-Dashboard → **Project Settings → Edge Functions → Secrets**
(oder per CLI `supabase secrets set ...`):

```
GOOGLE_CLIENT_ID=<Client-ID aus Schritt 1>
GOOGLE_CLIENT_SECRET=<Client-Secret aus Schritt 1>
GOOGLE_REDIRECT_URI=https://rlorfhpgxmyplmsgmkzw.supabase.co/functions/v1/gmail-oauth-callback
```

`SUPABASE_URL` und `SUPABASE_SERVICE_ROLE_KEY` sind bei Supabase-Projekten
i. d. R. bereits automatisch als Secrets für Edge Functions verfügbar.
`ANTHROPIC_API_KEY` ist schon vorhanden (wird von `ai/index.ts` verwendet).

## 3. Datenbank-Migration ausführen

`supabase/migrations/20260701120000_gmail_integration.sql` im Supabase
SQL-Editor ausführen (oder `supabase db push`, falls ihr die CLI mit diesem
Projekt verknüpft habt). Legt die Tabellen `gmail_accounts` und
`gmail_import_queue` inkl. Rechten an.

## 4. Edge Functions deployen

```
supabase functions deploy gmail-oauth-start
supabase functions deploy gmail-oauth-callback
supabase functions deploy gmail-sync
```

`gmail-oauth-callback` braucht `verify_jwt = false` (siehe
`supabase/config.toml`) – Google ruft die Funktion ohne App-Login-Header auf.

## 5. Automatischen Hintergrund-Sync aktivieren (pg_cron)

1. Supabase-Dashboard → **Database → Extensions** → `pg_cron` und `pg_net`
   aktivieren.
2. Im SQL-Editor (Platzhalter durch euren Service-Role-Key ersetzen – diesen
   niemals in eine Datei committen):

   ```sql
   select cron.schedule(
     'gmail-sync-every-15-min',
     '*/15 * * * *',
     $$
     select net.http_post(
       url := 'https://rlorfhpgxmyplmsgmkzw.supabase.co/functions/v1/gmail-sync',
       headers := jsonb_build_object(
         'Authorization', 'Bearer <SERVICE-ROLE-KEY>',
         'Content-Type', 'application/json'
       ),
       body := '{}'::jsonb
     );
     $$
   );
   ```

## 6. In der App verbinden

In SP Finanz unter **Einstellungen → Gmail** auf "Postfach verbinden" klicken
(öffnet ein Google-Consent-Popup). Danach erscheinen neue Rechnungs-Anhänge
automatisch (alle 15 Minuten) als Entwürfe unter **Import → Kontoauszug**,
wo sie wie gewohnt bestätigt und einem Konto zugeordnet werden.

## Funktionsweise (kurz)

- `gmail-oauth-start` erzeugt die Google-Consent-URL für den eingeloggten
  Nutzer.
- `gmail-oauth-callback` tauscht den Code gegen Tokens, ermittelt die
  verbundene Adresse und speichert sie in `gmail_accounts`.
- `gmail-sync` (manuell per Button oder per Cron) durchsucht jedes verbundene
  Postfach nach Mails mit PDF/Bild-Anhang, lässt neue Treffer von Claude
  auslesen (gleiche Logik wie der manuelle Beleg-Scan), lädt den Anhang in den
  Storage-Bucket `belege` hoch und legt einen Eintrag in
  `gmail_import_queue` an.
- Die App holt offene Einträge aus `gmail_import_queue` und reiht sie in die
  bestehenden Bankauszug-Entwürfe ein – dieselbe Oberfläche, die auch für
  hochgeladene Kontoauszüge genutzt wird (Dubletten-Erkennung, Konto-Zuordnung
  etc. funktionieren automatisch mit).
