-- =====================================================================
-- TanqueCheio — schema.sql (v2, idempotente: pode rodar de novo sem medo)
-- Antes: Authentication > Providers > habilitar "Allow anonymous sign-ins"
-- Novidades da v2: referência de preço da ANP, centroides de municípios,
-- trava de velocidade ("modo parado") na RPC enviar_preco.
-- =====================================================================
create extension if not exists postgis with schema extensions;
set search_path = public, extensions;

-- ---------- POSTOS (carga inicial vem do OpenStreetMap) ----------
create table if not exists postos (
  id         uuid primary key default gen_random_uuid(),
  osm_ref    text unique,                       -- ex.: 'node/123456' (evita duplicar no upsert)
  nome       text not null default 'Posto sem nome',
  marca      text,
  geom       geography(Point, 4326) not null,   -- geography => distâncias em metros
  criado_em  timestamptz not null default now()
);
create index if not exists postos_geom_gix on postos using gist (geom);

-- ---------- PREÇO ATUAL (1 linha por posto + combustível) ----------
create table if not exists combustiveis_precos (
  id              uuid primary key default gen_random_uuid(),
  posto_id        uuid not null references postos(id) on delete cascade,
  tipo            text not null check (tipo in
                    ('gasolina_comum','gasolina_aditivada','etanol','diesel_s10','diesel_s500','gnv')),
  preco           numeric(6,3) not null check (preco > 0),
  nivel_confianca text not null default 'nao_verificado'
                    check (nivel_confianca in ('nao_verificado','pendente','verificado')),
  confirmacoes    int  not null default 0,
  atualizado_por  uuid references auth.users(id) on delete set null,
  atualizado_em   timestamptz not null default now(),
  unique (posto_id, tipo)
);
create index if not exists precos_tipo_idx on combustiveis_precos (tipo, preco);

-- ---------- HISTÓRICO (auditoria + base para contar confirmações) ----------
create table if not exists historico_atualizacoes (
  id           bigserial primary key,
  posto_id     uuid not null references postos(id) on delete cascade,
  tipo         text not null,
  preco        numeric(6,3) not null,
  user_id      uuid not null references auth.users(id) on delete cascade,
  geom_usuario geography(Point, 4326) not null,
  distancia_m  numeric(8,1) not null,
  criado_em    timestamptz not null default now()
);
create index if not exists hist_busca_idx on historico_atualizacoes (posto_id, tipo, criado_em desc);

-- ---------- REPUTAÇÃO / GAMIFICAÇÃO ----------
create table if not exists usuarios_reputacao (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  pontos        int  not null default 0,
  atualizacoes  int  not null default 0,
  nivel         text not null default 'novato',  -- novato | confiavel | embaixador
  atualizado_em timestamptz not null default now()
);

-- ---------- REFERÊNCIA DA ANP (preenchida pelo scripts/importar_anp.py) ----------
-- Serve de "régua" para o filtro de outlier quando a região ainda tem poucos preços de motoristas.
create table if not exists municipios_ref (
  uf             text not null,
  nome           text not null,
  municipio_norm text not null,                 -- MAIÚSCULO, sem acento
  geom           geography(Point, 4326) not null,
  primary key (uf, municipio_norm)
);
create index if not exists municipios_ref_gix on municipios_ref using gist (geom);

create table if not exists referencia_anp (
  uf             text not null,
  municipio_norm text not null,                 -- '*' = mediana da UF inteira (fallback)
  tipo           text not null,
  mediana        numeric(6,3) not null,
  amostras       int not null,
  semana         date,
  primary key (uf, municipio_norm, tipo)
);

-- ---------- RLS: leitura pública, escrita SÓ via RPC / service_role ----------
alter table postos                 enable row level security;
alter table combustiveis_precos    enable row level security;
alter table historico_atualizacoes enable row level security;
alter table usuarios_reputacao     enable row level security;
alter table municipios_ref         enable row level security;   -- sem policies: só service_role
alter table referencia_anp         enable row level security;   -- sem policies: só service_role

drop policy if exists "postos_leitura" on postos;
drop policy if exists "precos_leitura" on combustiveis_precos;
drop policy if exists "hist_proprio"   on historico_atualizacoes;
drop policy if exists "reput_propria"  on usuarios_reputacao;
create policy "postos_leitura" on postos              for select using (true);
create policy "precos_leitura" on combustiveis_precos for select using (true);
create policy "hist_proprio"   on historico_atualizacoes for select using (auth.uid() = user_id);
create policy "reput_propria"  on usuarios_reputacao  for select using (auth.uid() = user_id);

-- =====================================================================
-- RPC 1: buscar_postos_na_rota
-- p_rota = GeoJSON {"type":"LineString","coordinates":[[lng,lat],...]}
-- ST_DWithin(geography, ..., 500) cobre os DOIS lados da pista (esquerda e direita).
-- Ordena: menor preço primeiro (sem preço vai pro fim) e depois menor desvio.
-- =====================================================================
create or replace function buscar_postos_na_rota(
  p_rota     jsonb,
  p_tipo     text,
  p_buffer_m int default 500,
  p_limite   int default 40
)
returns table (
  id uuid, nome text, marca text, lat double precision, lng double precision,
  preco numeric, nivel_confianca text, confirmacoes int, atualizado_em timestamptz,
  desvio_m numeric, km_na_rota numeric
)
language sql stable
set search_path = public, extensions
as $$
  with r as (
    select st_setsrid(st_geomfromgeojson(p_rota::text), 4326) as g
  )
  select
    p.id, p.nome, p.marca,
    st_y(p.geom::geometry), st_x(p.geom::geometry),
    cp.preco,
    -- preço com mais de 7 dias perde o selo (dado velho não é confiável)
    case when cp.id is null or cp.atualizado_em < now() - interval '7 days'
         then 'nao_verificado' else cp.nivel_confianca end,
    coalesce(cp.confirmacoes, 0),
    cp.atualizado_em,
    round(st_distance(p.geom, r.g::geography)::numeric, 0),                    -- desvio até a rota (col. 10)
    round((st_linelocatepoint(r.g, p.geom::geometry)
           * st_length(r.g::geography) / 1000)::numeric, 1)                    -- km desde a origem
  from r
  cross join postos p
  left join combustiveis_precos cp on cp.posto_id = p.id and cp.tipo = p_tipo
  where st_dwithin(p.geom, r.g::geography, least(p_buffer_m, 500))
  order by cp.preco asc nulls last, 10 asc
  limit least(p_limite, 100);
$$;

-- RPC 2: postos próximos do usuário (aba "Próximos")
create or replace function buscar_postos_proximos(
  p_lat double precision, p_lng double precision,
  p_tipo text, p_raio_m int default 5000, p_limite int default 40
)
returns table (
  id uuid, nome text, marca text, lat double precision, lng double precision,
  preco numeric, nivel_confianca text, confirmacoes int, atualizado_em timestamptz,
  desvio_m numeric, km_na_rota numeric
)
language sql stable
set search_path = public, extensions
as $$
  with u as (select st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography as g)
  select p.id, p.nome, p.marca, st_y(p.geom::geometry), st_x(p.geom::geometry),
         cp.preco,
         case when cp.id is null or cp.atualizado_em < now() - interval '7 days'
              then 'nao_verificado' else cp.nivel_confianca end,
         coalesce(cp.confirmacoes, 0), cp.atualizado_em,
         round(st_distance(p.geom, u.g)::numeric, 0), null::numeric
  from u cross join postos p
  left join combustiveis_precos cp on cp.posto_id = p.id and cp.tipo = p_tipo
  where st_dwithin(p.geom, u.g, least(p_raio_m, 50000))
  order by cp.preco asc nulls last, 10 asc
  limit least(p_limite, 100);
$$;

-- =====================================================================
-- RPC 3: enviar_preco — O "BLINDEX". Toda validação acontece aqui.
-- v2: + trava de velocidade (modo parado) + referência ANP no outlier.
-- =====================================================================
drop function if exists enviar_preco(uuid,text,numeric,double precision,double precision,double precision);

create or replace function enviar_preco(
  p_posto_id     uuid,
  p_tipo         text,
  p_preco        numeric,
  p_lat          double precision,
  p_lng          double precision,
  p_precisao_m   double precision default null,
  p_velocidade_ms double precision default null     -- coords.speed do navegador (m/s)
)
returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  v_uid     uuid := auth.uid();
  v_posto   geography;
  v_user    geography;
  v_dist    numeric;
  v_ref     numeric;      -- preço de referência para o filtro de outlier
  v_n       int;
  v_uf      text;
  v_mun     text;
  v_conf    int;
  v_nivel   text;
  v_atualiz int;
  v_pontos  int;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_tipo not in ('gasolina_comum','gasolina_aditivada','etanol','diesel_s10','diesel_s500','gnv')
    then raise exception 'TIPO_INVALIDO'; end if;
  if p_preco is null or p_preco < 1 or p_preco > 30 then raise exception 'PRECO_INVALIDO'; end if;

  select geom into v_posto from postos where id = p_posto_id;
  if v_posto is null then raise exception 'POSTO_NAO_ENCONTRADO'; end if;

  -- 0) MODO PARADO: acima de ~5 km/h (1,4 m/s) não aceita (segurança no trânsito).
  --    Obs.: a velocidade vem do cliente, então é uma trava de segurança/UX, não antifraude.
  if p_velocidade_ms is not null and p_velocidade_ms > 1.4 then raise exception 'EM_MOVIMENTO'; end if;

  -- 1) GEOFENCING (150 m) validado no servidor
  v_user := st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography;
  v_dist := st_distance(v_posto, v_user);
  if v_dist > 150 then raise exception 'FORA_DO_RAIO:%', round(v_dist); end if;
  if p_precisao_m is not null and p_precisao_m > 100 then raise exception 'GPS_IMPRECISO'; end if;

  -- 2) OUTLIER (>25% da referência regional)
  -- 2a) Mediana dos preços dos motoristas num raio de 50 km, últimos 30 dias.
  --     Mediana (e não média): um preço absurdo já gravado não "puxa" a referência.
  select percentile_cont(0.5) within group (order by cp.preco), count(*)
    into v_ref, v_n
  from combustiveis_precos cp
  join postos p on p.id = cp.posto_id
  where cp.tipo = p_tipo
    and cp.posto_id <> p_posto_id
    and cp.atualizado_em > now() - interval '30 days'
    and st_dwithin(p.geom, v_posto, 50000);

  -- 2b) Poucas amostras locais (<3)? Prefere a mediana da ANP (município mais próximo, senão UF).
  if coalesce(v_n, 0) < 3 then
    select m.uf, m.municipio_norm into v_uf, v_mun
    from municipios_ref m
    where st_dwithin(m.geom, v_posto, 150000)
    order by m.geom <-> v_posto
    limit 1;

    if v_uf is not null then
      select r.mediana into v_ref
      from referencia_anp r
      where r.uf = v_uf and r.tipo = p_tipo and r.municipio_norm in (v_mun, '*')
      order by (r.municipio_norm = '*') asc      -- município primeiro, UF como fallback
      limit 1;
    end if;
  end if;

  if v_ref is not null and abs(p_preco - v_ref) / v_ref > 0.25 then
    raise exception 'OUTLIER';
  end if;

  -- 3) Rate limit: mesmo usuário, mesmo posto/combustível, 1x por hora
  if exists (select 1 from historico_atualizacoes
             where user_id = v_uid and posto_id = p_posto_id and tipo = p_tipo
               and criado_em > now() - interval '1 hour') then
    raise exception 'AGUARDE';
  end if;

  insert into historico_atualizacoes (posto_id, tipo, preco, user_id, geom_usuario, distancia_m)
  values (p_posto_id, p_tipo, p_preco, v_uid, v_user, v_dist);

  -- 4) Confirmações = motoristas DISTINTOS que reportaram ~o mesmo preço (±R$0,02) em 48h
  select count(distinct user_id) into v_conf
  from historico_atualizacoes
  where posto_id = p_posto_id and tipo = p_tipo
    and criado_em > now() - interval '48 hours'
    and abs(preco - p_preco) <= 0.02;

  -- Selo: 🟢 2+ motoristas | 🟡 1 atualização de usuário já com histórico | 🔴 usuário novo
  select coalesce(atualizacoes, 0) into v_atualiz from usuarios_reputacao where user_id = v_uid;
  v_nivel := case
    when v_conf >= 2                then 'verificado'
    when coalesce(v_atualiz,0) >= 2 then 'pendente'
    else 'nao_verificado' end;

  insert into combustiveis_precos (posto_id, tipo, preco, nivel_confianca, confirmacoes, atualizado_por, atualizado_em)
  values (p_posto_id, p_tipo, p_preco, v_nivel, v_conf, v_uid, now())
  on conflict (posto_id, tipo) do update
    set preco = excluded.preco, nivel_confianca = excluded.nivel_confianca,
        confirmacoes = excluded.confirmacoes, atualizado_por = excluded.atualizado_por,
        atualizado_em = excluded.atualizado_em;

  -- 5) Gamificação
  v_pontos := case when v_conf >= 2 then 15 else 10 end;
  insert into usuarios_reputacao (user_id, pontos, atualizacoes)
  values (v_uid, v_pontos, 1)
  on conflict (user_id) do update
    set pontos = usuarios_reputacao.pontos + v_pontos,
        atualizacoes = usuarios_reputacao.atualizacoes + 1,
        nivel = case when usuarios_reputacao.pontos + v_pontos >= 300 then 'embaixador'
                     when usuarios_reputacao.pontos + v_pontos >= 60  then 'confiavel'
                     else 'novato' end,
        atualizado_em = now();

  return jsonb_build_object('nivel', v_nivel, 'confirmacoes', v_conf, 'pontos', v_pontos);
end;
$$;

-- RPC 4: importar postos do OSM pelo CLIENTE (modo "início rápido").
-- Insert-only, só Brasil. Em produção prefira a Edge Function (supabase/functions/importar-postos-osm)
-- e revogue este acesso (ver bloco comentado no fim).
create or replace function upsert_postos_osm(p_postos jsonb)
returns int
language plpgsql security definer
set search_path = public, extensions
as $$
declare v_n int;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if jsonb_array_length(p_postos) > 500 then raise exception 'LOTE_GRANDE'; end if;

  with ins as (
    insert into postos (osm_ref, nome, marca, geom)
    select x.osm_ref, left(coalesce(nullif(x.nome,''), 'Posto sem nome'), 80), left(x.marca, 40),
           st_setsrid(st_makepoint(x.lng, x.lat), 4326)::geography
    from jsonb_to_recordset(p_postos) as x(osm_ref text, nome text, marca text, lat double precision, lng double precision)
    where x.lat between -34 and 6 and x.lng between -74 and -34       -- só Brasil
    on conflict (osm_ref) do nothing
    returning 1
  ) select count(*) into v_n from ins;
  return v_n;
end;
$$;

-- ---------- Permissões ----------
revoke all on function enviar_preco(uuid,text,numeric,double precision,double precision,double precision,double precision) from public, anon;
revoke all on function upsert_postos_osm(jsonb) from public, anon;
grant execute on function enviar_preco(uuid,text,numeric,double precision,double precision,double precision,double precision) to authenticated;
grant execute on function upsert_postos_osm(jsonb) to authenticated;
grant execute on function buscar_postos_na_rota(jsonb,text,int,int) to anon, authenticated;
grant execute on function buscar_postos_proximos(double precision,double precision,text,int,int) to anon, authenticated;

-- ---------- DEPOIS que a Edge Function estiver populando os postos ----------
-- revoke execute on function upsert_postos_osm(jsonb) from authenticated;
-- (e no app.js coloque CONFIG.SEMEAR_PELO_CLIENTE = false)
