// Buqo – Rechnungen per E-Mail-Weiterleitung: Webhook-Ziel für "Resend Inbound".
// Wird von Resend (über Svix) aufgerufen, wenn eine Mail an die eingerichtete Empfangsadresse
// eingeht (z. B. rechnungen@inbound.designpeak.io). Lädt PDF/Bild-Anhänge, lässt sie von Claude
// auslesen (gleiche Logik wie der manuelle Beleg-Scan) und legt Treffer in "resend_import_queue"
// ab. Der Client holt sich offene Zeilen von dort und reiht sie in die bestehenden
// Bankauszug-Entwürfe ein – unabhängig von der Gmail-Integration.
//
// Setup siehe RESEND_INBOUND_SETUP.md. verify_jwt=false in supabase/config.toml, weil Resend/Svix
// die Anfrage ohne Supabase-Login-Header aufruft (Prüfung erfolgt selbst über die Svix-Signatur).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const RESEND_WEBHOOK_SECRET = Deno.env.get("RESEND_WEBHOOK_SECRET")!; // "whsec_…" aus dem Resend-Dashboard
const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

const TIMESTAMP_TOLERANCE_SEC = 300;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const ATTACHMENT_EXT = ["pdf", "png", "jpg", "jpeg"];
const CATS = ["Allgemein", "Miete", "Nebenkosten", "Versicherung", "Material", "Personal", "Steuern", "Software", "Marketing", "Reise", "Bewirtung", "Bank & Gebühren", "Sonstiges"];

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

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
function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Svix-Signaturprüfung (von Resend für Webhooks verwendet): HMAC-SHA256("{id}.{ts}.{body}") mit dem
// base64-dekodierten Teil des "whsec_"-Secrets, verglichen gegen jede "v1,<sig>"-Angabe im Header.
async function verifySvixSignature(id: string, timestamp: string, body: string, signatureHeader: string): Promise<boolean> {
  const ts = parseInt(timestamp, 10);
  if (!ts || Math.abs(Date.now() / 1000 - ts) > TIMESTAMP_TOLERANCE_SEC) return false;
  const secretB64 = RESEND_WEBHOOK_SECRET.startsWith("whsec_") ? RESEND_WEBHOOK_SECRET.slice(6) : RESEND_WEBHOOK_SECRET;
  const keyBytes = base64ToBytes(secretB64);
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signedContent = `${id}.${timestamp}.${body}`;
  const sigBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedContent));
  const expected = bytesToBase64(new Uint8Array(sigBytes));
  const candidates = signatureHeader.split(" ").map((p) => p.split(",")[1]).filter(Boolean);
  return candidates.some((c) => timingSafeEqual(c, expected));
}

async function extractInvoiceFields(base64: string, mediaType: string) {
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

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const rawBody = await req.text();
  const svixId = req.headers.get("svix-id") || "";
  const svixTimestamp = req.headers.get("svix-timestamp") || "";
  const svixSignature = req.headers.get("svix-signature") || "";

  try {
    if (!RESEND_WEBHOOK_SECRET) return new Response("RESEND_WEBHOOK_SECRET fehlt", { status: 500 });
    if (!svixId || !svixTimestamp || !svixSignature) return new Response("Fehlende Signatur-Header", { status: 401 });
    const valid = await verifySvixSignature(svixId, svixTimestamp, rawBody, svixSignature);
    if (!valid) return new Response("Ungültige Signatur", { status: 401 });

    const payload = JSON.parse(rawBody);
    if (payload.type !== "email.received") return new Response("ok", { status: 200 });

    const d = payload.data || {};
    const emailId: string = d.email_id;
    const attachments: Array<{ id: string; filename: string; content_type: string }> = d.attachments || [];
    const from = Array.isArray(d.from) ? d.from[0] : d.from;
    const to = Array.isArray(d.to) ? d.to[0] : d.to;
    const receivedAt = payload.created_at || new Date().toISOString();

    const candidates = attachments.filter((a) => ATTACHMENT_EXT.includes((a.filename.split(".").pop() || "").toLowerCase()));
    if (!candidates.length) return new Response("ok", { status: 200 });

    for (const att of candidates) {
      try {
        const { data: exists } = await admin.from("resend_import_queue").select("id").eq("email_id", emailId).eq("attachment_id", att.id).maybeSingle();
        if (exists) continue; // Webhook wurde erneut zugestellt – bereits verarbeitet

        const metaRes = await fetch(`https://api.resend.com/emails/receiving/${emailId}/attachments/${att.id}`, {
          headers: { Authorization: `Bearer ${RESEND_API_KEY}` },
        });
        const meta = await metaRes.json();
        if (!metaRes.ok) throw new Error(meta?.message || "Anhang-Metadaten konnten nicht geladen werden");
        if ((meta.size || 0) > MAX_ATTACHMENT_BYTES) { await admin.from("resend_import_queue").insert({ email_id: emailId, attachment_id: att.id, from_email: from, to_email: to, subject: d.subject, received_at: receivedAt, status: "dismissed", error: "Anhang zu groß" }); continue; }

        const fileRes = await fetch(meta.download_url);
        if (!fileRes.ok) throw new Error("Anhang-Download fehlgeschlagen");
        const bytes = new Uint8Array(await fileRes.arrayBuffer());
        const base64 = bytesToBase64(bytes);

        const ext = (att.filename.split(".").pop() || "").toLowerCase();
        const mediaType = ext === "pdf" ? "application/pdf" : ext === "png" ? "image/png" : "image/jpeg";

        const extracted = await extractInvoiceFields(base64, mediaType);
        if (!extracted) { await admin.from("resend_import_queue").insert({ email_id: emailId, attachment_id: att.id, from_email: from, to_email: to, subject: d.subject, received_at: receivedAt, status: "dismissed", error: "Kein Beleg erkannt" }); continue; }

        const dt = extracted.datum ? new Date(extracted.datum) : new Date(receivedAt);
        const year = isNaN(dt.getTime()) ? new Date().getFullYear() : dt.getFullYear();
        const month = isNaN(dt.getTime()) ? new Date().getMonth() + 1 : dt.getMonth() + 1;
        const filePath = `Email-Import/${year}/${String(month).padStart(2, "0")}/${safeName(extracted.name || d.subject || "Beleg")}_${att.id.slice(0, 8)}.${ext}`;
        const { error: upErr } = await admin.storage.from("belege").upload(filePath, bytes, { upsert: true, contentType: mediaType });
        if (upErr) throw new Error("Speichern des Anhangs fehlgeschlagen: " + upErr.message);

        await admin.from("resend_import_queue").insert({
          email_id: emailId, attachment_id: att.id, from_email: from, to_email: to, subject: d.subject,
          received_at: receivedAt, extracted, file_path: filePath, status: "pending",
        });
      } catch (e) {
        await admin.from("resend_import_queue").insert({ email_id: emailId, attachment_id: att.id, from_email: from, to_email: to, subject: d.subject, received_at: receivedAt, status: "failed", error: String((e as Error)?.message || e) }).then(() => {}, () => {});
      }
    }

    return new Response("ok", { status: 200 });
  } catch (e) {
    return new Response("Fehler: " + String(e), { status: 500 });
  }
});
