// Buqo – KI-Proxy (hält den Anthropic-Schlüssel geheim)
// Nur eingeloggte App-Nutzer dürfen diese Funktion aufrufen.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

// Erlaubte Modelle (verhindert teure Überraschungen)
const ALLOWED = new Set(["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-8"]);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    // 1) Nur eingeloggte Nutzer
    const authHeader = req.headers.get("Authorization") || "";
    const supa = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await supa.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: "Nicht eingeloggt" }), {
        status: 401, headers: { ...cors, "content-type": "application/json" },
      });
    }

    // 2) Anfrage an Claude weiterreichen
    const body = await req.json();
    const model = ALLOWED.has(body.model) ? body.model : "claude-sonnet-4-6";
    const max_tokens = Math.min(body.max_tokens || 2000, 8000);

    const payload: Record<string, unknown> = {
      model,
      max_tokens,
      messages: body.messages,
    };
    if (body.system) payload.system = body.system;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await r.json();
    return new Response(JSON.stringify(data), {
      status: r.status, headers: { ...cors, "content-type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...cors, "content-type": "application/json" },
    });
  }
});
