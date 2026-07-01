// Buqo – Rechnungsversand per E-Mail (über Resend; hält den Resend-Schlüssel geheim)
// Nur eingeloggte App-Nutzer dürfen diese Funktion aufrufen.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "content-type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    // 1) Nur eingeloggte Nutzer
    const authHeader = req.headers.get("Authorization") || "";
    const supa = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await supa.auth.getUser();
    if (!user) return json({ error: "Nicht eingeloggt" }, 401);

    if (!RESEND_API_KEY) return json({ error: "RESEND_API_KEY ist nicht gesetzt. Bitte im Supabase-Dashboard als Secret hinterlegen." }, 500);

    // 2) Eingabe prüfen
    const body = await req.json();
    const to = String(body.to || "").trim();
    const from = String(body.from || "").trim();      // z. B. "Designpeak GmbH <rechnung@designpeak.io>"
    const subject = String(body.subject || "").trim();
    if (!to || !/.+@.+\..+/.test(to)) return json({ error: "Ungültige Empfänger-Adresse." }, 400);
    if (!from) return json({ error: "Keine Absender-Adresse gesetzt (Einstellungen)." }, 400);
    if (!subject) return json({ error: "Kein Betreff." }, 400);

    const payload: Record<string, unknown> = {
      from,
      to: [to],
      subject,
      html: body.html || undefined,
      text: body.text || undefined,
    };
    if (body.replyTo) payload.reply_to = body.replyTo;
    if (body.bcc) payload.bcc = Array.isArray(body.bcc) ? body.bcc : [body.bcc];
    if (body.pdfBase64 && body.pdfName) {
      payload.attachments = [{ filename: String(body.pdfName), content: String(body.pdfBase64) }];
    }

    // 3) An Resend weiterreichen
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) return json({ error: (data && (data.message || data.name)) || "Versand fehlgeschlagen", details: data }, r.status);
    return json({ ok: true, id: data.id || null });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
