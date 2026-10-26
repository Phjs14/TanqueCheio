// =====================================================================
// Edge Function: importar-postos-osm
// Baixa todos os postos (amenity=fuel) de UM estado do OpenStreetMap (Overpass)
// e grava na tabela `postos` (insert-only: nunca sobrescreve o que já existe).
//
// Chamada: POST { "uf": "BA" }  ou  { "uf": "auto" }
//   "auto" = escolhe um estado por dia (rodízio de 27 dias) -> 1 job diário cobre o Brasil todo.
// Proteção: header  x-cron-secret  deve ser igual ao secret CRON_SECRET.
//
// Deploy:
//   supabase functions deploy importar-postos-osm --no-verify-jwt
//   supabase secrets set CRON_SECRET=um-segredo-grande-e-aleatorio
// (SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já são injetados automaticamente.)
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const UFS = ["AC","AL","AM","AP","BA","CE","DF","ES","GO","MA","MG","MS","MT","PA","PB","PE","PI","PR","RJ","RN","RO","RR","RS","SC","SE","SP","TO"];
const OVERPASS = "https://overpass-api.de/api/interpreter";

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  // 1) Autenticação simples por segredo compartilhado (a função roda sem JWT)
  const segredo = Deno.env.get("CRON_SECRET");
  if (!segredo || req.headers.get("x-cron-secret") !== segredo) return json({ erro: "não autorizado" }, 401);

  // 2) Descobre o estado
  const body = await req.json().catch(() => ({}));
  let uf = String(body.uf ?? "auto").toUpperCase();
  if (uf === "AUTO") {
    const diaDoAno = Math.floor(Date.now() / 86_400_000);
    uf = UFS[diaDoAno % UFS.length];
  }
  if (!UFS.includes(uf)) return json({ erro: "uf inválida" }, 400);

  // 3) Overpass: todos os postos da UF (area pelo código ISO 3166-2)
  const query = `[out:json][timeout:150];
area["ISO3166-2"="BR-${uf}"]["admin_level"="4"]->.a;
nwr["amenity"="fuel"](area.a);
out center tags;`;

  const r = await fetch(OVERPASS, {
    method: "POST",
    headers: { "User-Agent": "TanqueCheio/1.0 (importador de postos)" },
    body: new URLSearchParams({ data: query }),
  });
  if (!r.ok) return json({ erro: `Overpass respondeu ${r.status}`, uf }, 502);
  const dados = await r.json();

  // 4) Normaliza. geom em EWKT: o PostgREST/PostGIS converte para geography.
  const linhas = (dados.elements ?? [])
    .map((e: any) => {
      const lat = e.lat ?? e.center?.lat, lng = e.lon ?? e.center?.lon;
      if (lat == null || lng == null) return null;
      if (lat < -34 || lat > 6 || lng < -74 || lng > -34) return null;      // só Brasil
      const nome = String(e.tags?.name ?? e.tags?.brand ?? "").slice(0, 80) || "Posto sem nome";
      return {
        osm_ref: `${e.type}/${e.id}`,
        nome,
        marca: String(e.tags?.brand ?? "").slice(0, 40) || null,
        geom: `SRID=4326;POINT(${lng} ${lat})`,
      };
    })
    .filter(Boolean);

  // 5) Grava em lotes (ignoreDuplicates = ON CONFLICT DO NOTHING)
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let erros = 0;
  for (let i = 0; i < linhas.length; i += 500) {
    const { error } = await sb.from("postos").upsert(linhas.slice(i, i + 500), {
      onConflict: "osm_ref", ignoreDuplicates: true,
    });
    if (error) { erros++; console.error(error.message); }
  }

  return json({ uf, lidos: linhas.length, lotes_com_erro: erros });
});
