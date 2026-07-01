// Buqo – Gmail-Anbindung: OAuth-Redirect-Ziel. Wird von Google aufgerufen (kein App-Login-Header),
// tauscht den Code gegen Tokens, speichert sie serverseitig und schließt sich selbst (Popup-Flow).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
const GOOGLE_REDIRECT_URI = Deno.env.get("GOOGLE_REDIRECT_URI") || `${SUPABASE_URL}/functions/v1/gmail-oauth-callback`;
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function b64urlToStr(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
}

async function signState(payloadB64: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(SERVICE_ROLE_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function popupResponse(ok: boolean, message: string) {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Gmail</title></head>
<body style="font-family:system-ui,sans-serif;background:#0A0A0A;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
<div style="text-align:center;padding:24px;max-width:360px;">
  <p style="font-size:15px;line-height:1.5;">${message.replace(/</g, "&lt;")}</p>
  <p style="font-size:12px;opacity:.6;">Dieses Fenster schließt sich gleich automatisch.</p>
</div>
<script>
  try { if (window.opener) window.opener.postMessage({ source: 'buqo-gmail-oauth', ok: ${ok ? "true" : "false"}, message: ${JSON.stringify(message)} }, '*'); } catch (e) {}
  setTimeout(() => window.close(), ${ok ? 1200 : 3500});
</script>
</body></html>`;
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") || "";
  const oauthError = url.searchParams.get("error");

  try {
    if (oauthError) return popupResponse(false, "Gmail-Verbindung abgebrochen: " + oauthError);
    if (!code || !state.includes(".")) return popupResponse(false, "Ungültige Anfrage (fehlender Code/State).");

    const [payloadB64, sig] = state.split(".");
    const expectedSig = await signState(payloadB64);
    if (sig !== expectedSig) return popupResponse(false, "Ungültige oder manipulierte Anfrage.");
    const payload = JSON.parse(b64urlToStr(payloadB64));
    if (!payload || typeof payload.ts !== "number" || Date.now() - payload.ts > STATE_MAX_AGE_MS) {
      return popupResponse(false, "Anfrage abgelaufen – bitte erneut verbinden.");
    }

    // 1) Code gegen Tokens tauschen
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok) return popupResponse(false, "Token-Austausch fehlgeschlagen: " + (tokens.error_description || tokens.error || tokenRes.status));

    const accessToken = tokens.access_token as string;
    const refreshToken = (tokens.refresh_token as string) || null;
    const expiresIn = Number(tokens.expires_in) || 3600;

    // 2) E-Mail-Adresse des verbundenen Postfachs ermitteln
    let email = "";
    if (tokens.id_token) {
      try { email = JSON.parse(b64urlToStr(String(tokens.id_token).split(".")[1])).email || ""; } catch (_e) { /* ignore */ }
    }
    if (!email) {
      const profRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (profRes.ok) { const prof = await profRes.json(); email = prof.emailAddress || ""; }
    }
    if (!email) return popupResponse(false, "Konnte die Gmail-Adresse nicht ermitteln.");

    // 3) Speichern. Ohne neuen Refresh-Token (z. B. erneutes Verbinden) den alten behalten.
    const { data: existing } = await admin.from("gmail_accounts").select("id,refresh_token").eq("email", email).maybeSingle();
    const row = {
      email,
      refresh_token: refreshToken || existing?.refresh_token || "",
      access_token: accessToken,
      token_expiry: new Date(Date.now() + expiresIn * 1000).toISOString(),
      status: "connected",
      last_error: null,
      connected_by: payload.uid || null,
    };
    if (!row.refresh_token) return popupResponse(false, "Google hat keinen Refresh-Token geliefert. Bitte Zugriff in den Google-Kontoeinstellungen widerrufen und erneut verbinden.");

    const { error: upErr } = await admin.from("gmail_accounts").upsert(row, { onConflict: "email" });
    if (upErr) return popupResponse(false, "Speichern fehlgeschlagen: " + upErr.message);

    return popupResponse(true, `Gmail-Postfach „${email}" wurde verbunden.`);
  } catch (e) {
    return popupResponse(false, "Unerwarteter Fehler: " + String(e));
  }
});
