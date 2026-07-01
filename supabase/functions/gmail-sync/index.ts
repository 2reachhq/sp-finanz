// Buqo – Gmail-Sync: holt für jedes verbundene Postfach neue Mails mit Rechnungs-/Beleg-Anhängen,
// lässt sie von der KI auslesen (gleiche Logik wie der manuelle Beleg-Scan in der App) und legt sie in
// "gmail_import_queue" ab. Der Client holt sich offene Zeilen von dort und reiht sie in die bestehenden
// Bankauszug-Entwürfe ein, wo der Nutzer sie wie gewohnt bestätigt/zuordnet.
//
// Aufruf entweder manuell (eingeloggter Nutzer, Button "Jetzt synchronisieren") oder per pg_cron
// (Service-Role-Key als Bearer-Token, siehe supabase/migrations/20260701120000_gmail_integration.sql).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

const MAX_MESSAGES_PER_ACCOUNT = 15;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const ATTACHMENT_EXT = ["pdf", "png", "jpg", "jpeg"];
const CATS = ["Allgemein", "Miete", "Nebenkosten", "Versicherung", "Material", "Personal", "Steuern", "Software", "Marketing", "Reise", "Bewirtung", "Bank & Gebühren", "Sonstiges"];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "content-type": "application/json" } });

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function b64urlToB64(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return s.replace(/-/g, "+").replace(/_/g, "/") + pad;
}
function safeName(s: string): string {
  return String(s || "").replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 80) || "Anhang";
}
function toISODate(d: string): string {
  if (!d) return "";
  const m = String(d).match(/(\d{1,2})[.\/](\d{1,2})[.\/](\d{2,4})/);
  if (m) { let y = m[3]; if (y.length === 2) y = "20" + y; return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`; }
  if (/^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
  return "";
}

async function refreshAccessToken(refreshToken: string): Promise<string> {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error_description || data.error || "Token-Refresh fehlgeschlagen");
  return data.access_token as string;
}

function findAttachmentPart(part: any): any {
  if (!part) return null;
  const filename = String(part.filename || "");
  const ext = (filename.split(".").pop() || "").toLowerCase();
  if (filename && part.body && part.body.attachmentId && ATTACHMENT_EXT.includes(ext)) return part;
  for (const child of part.parts || []) {
    const hit = findAttachmentPart(child);
    if (hit) return hit;
  }
  return null;
}
function headerVal(headers: any[], name: string): string {
  const h = (headers || []).find((x) => String(x.name).toLowerCase() === name.toLowerCase());
  return h ? String(h.value || "") : "";
}

async function extractInvoiceFields(base64: string, mediaType: string): Promise<{ name: string; amount: number; netto: number; mwst: number; kind: string; belegnr: string; datum: string; category: string } | null> {
  const isPdf = mediaType === "application/pdf";
  const block = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
    : { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } };
  const prompt = "Dies ist EIN einzelner Beleg/Rechnung/Quittung (Deutschland) aus einem E-Mail-Anhang. Lies die Felder aus. AUSSCHLIESSLICH minifiziertes JSON:\n"
    + '{"b":"Kunde/Name/Titel","brutto":12.34,"netto":10.37,"mwst":19,"k":"a","d":"TT.MM.JJJJ","r":"Belegnummer","c":"Kategorie","istRechnung":true}\n'
    + "b=Kunde bzw. Name/Titel (keine generische Bezeichnung), brutto=Gesamtbetrag (Punkt-Dezimal), netto=Netto, mwst=MwSt-% (19/7/0), k=\"e\" bei Einnahme sonst \"a\", d/r leer wenn nicht vorhanden, c=Kategorie aus [" + CATS.join(",") + "]. "
    + "istRechnung=false, wenn der Anhang KEIN Beleg/keine Rechnung/Quittung ist (z. B. Newsletter, Vertrag, Flyer, Screenshot ohne Beträge). Erfinde nichts.";
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-4-5", max_tokens: 900, messages: [{ role: "user", content: [block, { type: "text", text: prompt }] }] }),
  });
  const resp = await r.json();
  if (!r.ok) throw new Error(resp?.error?.message || "KI-Anfrage fehlgeschlagen");
  let txt = resp?.content?.[0]?.text || "";
  txt = txt.replace(/```json|```/g, "").trim();
  const mm = txt.match(/\{[\s\S]*\}/); if (mm) txt = mm[0];
  const p = JSON.parse(txt);
  if (p.istRechnung === false) return null;
  const amount = Math.abs(parseFloat(String(p.brutto ?? p.a ?? 0).replace(",", ".")) || 0);
  if (!amount) return null;
  return {
    name: String(p.b || "").slice(0, 70),
    amount,
    netto: Math.abs(parseFloat(String(p.netto ?? 0).replace(",", ".")) || 0),
    mwst: parseFloat(String(p.mwst ?? 0).replace(",", ".")) || 0,
    kind: p.k === "e" ? "ein" : "aus",
    belegnr: String(p.r || ""),
    datum: toISODate(String(p.d || "")),
    category: String(p.c || ""),
  };
}

async function syncAccount(account: any) {
  const result = { email: account.email, checked: 0, added: 0, dismissed: 0, errors: 0 };
  const accessToken = await refreshAccessToken(account.refresh_token);

  const query = [
    "has:attachment",
    "(filename:pdf OR filename:png OR filename:jpg OR filename:jpeg)",
    "-in:spam", "-in:trash",
    account.last_sync_at ? `after:${Math.floor(new Date(account.last_sync_at).getTime() / 1000)}` : "newer_than:45d",
  ].join(" ");

  const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  listUrl.searchParams.set("q", query);
  listUrl.searchParams.set("maxResults", String(MAX_MESSAGES_PER_ACCOUNT));
  const listRes = await fetch(listUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  const listData = await listRes.json();
  if (!listRes.ok) throw new Error(listData?.error?.message || "Gmail-Suche fehlgeschlagen");
  const messages: Array<{ id: string; threadId: string }> = listData.messages || [];
  if (!messages.length) { await admin.from("gmail_accounts").update({ last_sync_at: new Date().toISOString(), status: "connected", last_error: null }).eq("id", account.id); return result; }

  const ids = messages.map((m) => m.id);
  const { data: already } = await admin.from("gmail_import_queue").select("message_id").eq("account_id", account.id).in("message_id", ids);
  const knownIds = new Set((already || []).map((r: any) => r.message_id));
  const fresh = messages.filter((m) => !knownIds.has(m.id));
  result.checked = fresh.length;

  for (const m of fresh) {
    try {
      const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, { headers: { Authorization: `Bearer ${accessToken}` } });
      const msg = await msgRes.json();
      if (!msgRes.ok) throw new Error(msg?.error?.message || "Nachricht konnte nicht geladen werden");
      const headers = msg.payload?.headers || [];
      const subject = headerVal(headers, "Subject");
      const from = headerVal(headers, "From");
      const dateHeader = headerVal(headers, "Date");
      const receivedAt = dateHeader ? new Date(dateHeader).toISOString() : new Date().toISOString();

      const part = findAttachmentPart(msg.payload);
      if (!part) { await admin.from("gmail_import_queue").insert({ account_id: account.id, message_id: m.id, thread_id: m.threadId, received_at: receivedAt, from_email: from, subject, status: "dismissed", error: "Kein passender Anhang gefunden" }); result.dismissed++; continue; }

      const attRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}/attachments/${part.body.attachmentId}`, { headers: { Authorization: `Bearer ${accessToken}` } });
      const att = await attRes.json();
      if (!attRes.ok) throw new Error(att?.error?.message || "Anhang konnte nicht geladen werden");
      if ((att.size || 0) > MAX_ATTACHMENT_BYTES) { await admin.from("gmail_import_queue").insert({ account_id: account.id, message_id: m.id, thread_id: m.threadId, received_at: receivedAt, from_email: from, subject, status: "dismissed", error: "Anhang zu groß" }); result.dismissed++; continue; }

      const ext = (part.filename.split(".").pop() || "").toLowerCase();
      const mediaType = ext === "pdf" ? "application/pdf" : ext === "png" ? "image/png" : "image/jpeg";
      const base64 = b64urlToB64(att.data || "");

      const extracted = await extractInvoiceFields(base64, mediaType);
      if (!extracted) { await admin.from("gmail_import_queue").insert({ account_id: account.id, message_id: m.id, thread_id: m.threadId, received_at: receivedAt, from_email: from, subject, status: "dismissed", error: "Kein Beleg erkannt" }); result.dismissed++; continue; }

      const dt = extracted.datum ? new Date(extracted.datum) : new Date(receivedAt);
      const year = isNaN(dt.getTime()) ? new Date().getFullYear() : dt.getFullYear();
      const month = isNaN(dt.getTime()) ? new Date().getMonth() + 1 : dt.getMonth() + 1;
      const filePath = `Gmail-Import/${year}/${String(month).padStart(2, "0")}/${safeName(extracted.name || subject || "Beleg")}_${m.id.slice(0, 8)}.${ext}`;
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const { error: upErr } = await admin.storage.from("belege").upload(filePath, bytes, { upsert: true, contentType: mediaType });
      if (upErr) throw new Error("Speichern des Anhangs fehlgeschlagen: " + upErr.message);

      await admin.from("gmail_import_queue").insert({
        account_id: account.id, message_id: m.id, thread_id: m.threadId, received_at: receivedAt,
        from_email: from, subject, extracted, file_path: filePath, status: "pending",
      });
      result.added++;
    } catch (e) {
      result.errors++;
      await admin.from("gmail_import_queue").insert({ account_id: account.id, message_id: m.id, thread_id: m.threadId, status: "failed", error: String((e as Error)?.message || e) }).then(() => {}, () => {});
    }
  }

  await admin.from("gmail_accounts").update({ last_sync_at: new Date().toISOString(), status: "connected", last_error: null }).eq("id", account.id);
  return result;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return json({ error: "GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET fehlen." }, 500);
    const { data: accounts, error } = await admin.from("gmail_accounts").select("*").eq("status", "connected");
    if (error) return json({ error: error.message }, 500);

    const results = [];
    for (const account of accounts || []) {
      try { results.push(await syncAccount(account)); }
      catch (e) {
        const message = String((e as Error)?.message || e);
        await admin.from("gmail_accounts").update({ status: "error", last_error: message }).eq("id", account.id);
        results.push({ email: account.email, error: message });
      }
    }
    return json({ ok: true, accounts: results });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
