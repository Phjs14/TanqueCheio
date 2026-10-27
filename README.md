# ⛽ TanqueCheio — Rode mais, pague menos.

PWA para motoristas, caminhoneiros e rodoviários acharem o combustível mais barato **ao longo da rota** e atualizarem preços de forma colaborativa, com validação geográfica.

## Estrutura

```
tanquecheio/
├── index.html                      UI (mapa em tela cheia + painel inferior)
├── app.js                          Lógica (Leaflet, GPS, permissão, geofence, modo parado, Supabase)
├── config.js                       URL e anon key do Supabase  <-- você preenche
├── sw.js                           Service Worker
├── manifest.json                   Manifesto PWA
├── icons/                          icon-192, icon-512, maskable-512
├── schema.sql                      Banco (PostGIS, RLS, RPCs). Idempotente.
├── scripts/importar_anp.py         Referência de preços da ANP (filtro de outlier)
└── supabase/functions/importar-postos-osm/index.ts   Importador de postos do OSM por estado
```

## Passo a passo

### 1. Banco (já feito se você rodou o schema.sql)
1. Se o Supabase for compartilhado com outro app: rode antes a "trava" que bloqueia sessões anônimas nas tabelas do outro app.
2. Authentication → Sign In / Providers → **Allow anonymous sign-ins** (ligar).
3. SQL Editor: rode `schema.sql` (pode rodar de novo quando houver versão nova).

### 2. Front-end
1. Preencha `config.js` com `SUPABASE_URL` e `SUPABASE_ANON_KEY`.
2. Publique **todos os arquivos** (inclusive `config.js` e a pasta `icons`) em hospedagem **HTTPS**.
3. Atualizando uma versão: publique os arquivos novos e abra o app. Ele se recarrega sozinho quando detecta a versão nova (se não, feche e abra de novo).

### 3. Localização no celular
O app **não pede** localização ao abrir. Toque em **📍 Ativar localização** (topo) e permita.
Se aparecer "Localização bloqueada", o navegador guardou uma negação anterior:
- **Chrome (Android/PC):** ícone ao lado do endereço (🔒/ⓘ) → Permissões → Localização → Permitir. Depois toque em "Já liberei, tentar de novo".
- **Chrome Android, por configurações:** ⋮ → Configurações → Configurações do site → Localização → procure o seu site → Permitir.
- **iPhone/Safari:** Ajustes → Privacidade e Segurança → Serviços de Localização → Safari.
- **App instalado na tela inicial:** segure o ícone → Informações do app → Permissões → Localização.
- Confira também se a **Localização do celular** está ligada e se você abriu o link no **Chrome**, e não dentro do WhatsApp/Instagram.

### 4. Postos do OSM
Dois modos:
- **Início rápido** (padrão): o próprio app lê o Overpass e envia os postos perto de você e ao longo da rota (`SEMEAR_PELO_CLIENTE: true` no `app.js`).
- **Produção** (recomendado): Edge Function `importar-postos-osm`.
  1. Supabase → Edge Functions → criar função `importar-postos-osm`, colar o `index.ts`, desligar **Verify JWT** e publicar (ou via CLI: `supabase functions deploy importar-postos-osm --no-verify-jwt`).
  2. Edge Functions → Secrets: criar `CRON_SECRET` com um valor longo e aleatório.
  3. Database → Extensions: ativar `pg_cron` e `pg_net`.
  4. Primeira carga (um estado por vez; o timeout de 150 s é importante):
     ```sql
     select net.http_post(
       url     := 'https://SEU-PROJETO.supabase.co/functions/v1/importar-postos-osm',
       headers := '{"Content-Type":"application/json","x-cron-secret":"SEU_CRON_SECRET"}'::jsonb,
       body    := jsonb_build_object('uf', uf),
       timeout_milliseconds := 150000
     ) from unnest(array['SE']) as uf;      -- depois: 'BA', 'AL', 'PE'...
     ```
     Veja o resultado em Edge Functions → Logs (campo `lidos`).
  5. Agendamento diário (um estado por dia, rodízio de 27 dias):
     ```sql
     select cron.schedule('tanquecheio-osm', '0 3 * * *', $$
       select net.http_post(
         url     := 'https://SEU-PROJETO.supabase.co/functions/v1/importar-postos-osm',
         headers := '{"Content-Type":"application/json","x-cron-secret":"SEU_CRON_SECRET"}'::jsonb,
         body    := '{"uf":"auto"}'::jsonb,
         timeout_milliseconds := 150000
       );
     $$);
     ```
  6. Quando os postos estiverem populados: `SEMEAR_PELO_CLIENTE: false` no `app.js` e, no SQL, `revoke execute on function upsert_postos_osm(jsonb) from authenticated;`

### 5. Referência de preços da ANP (opcional, mas recomendado)
Sem ela, nas regiões com menos de 3 preços de motoristas o filtro de outlier tem pouca régua.
1. Baixe o CSV do levantamento semanal de preços da ANP (dados abertos, gov.br).
2. Tenha um CSV de municípios com nome, UF (sigla ou código IBGE), latitude e longitude.
3. Rode (use `--dry-run` primeiro). No Windows (PowerShell):
   ```powershell
   $env:SUPABASE_URL = "https://SEU-PROJETO.supabase.co"
   $env:SUPABASE_SERVICE_KEY = "..."     # service_role: nunca no front-end, nem no git, nem em print
   py scripts\importar_anp.py levantamento_anp.csv --centroides municipios.csv --dry-run
   py scripts\importar_anp.py levantamento_anp.csv --centroides municipios.csv
   ```
   No Linux/macOS: `export VAR=...` e `python3`.
4. Repita semanalmente (o script sobrescreve a referência anterior).

### 6. Teste de ponta a ponta
1. Abra no celular (Chrome, HTTPS), toque em Ativar localização e veja os postos em **Próximos**.
2. Digite um destino e toque em ➜: a rota aparece e os postos do trajeto ficam em **Na rota**.
3. Para testar a atualização de preço sem estar num posto, crie um posto de teste na sua posição (pegue lat/lng no Google Maps, clique direito → copiar coordenadas):
   ```sql
   insert into postos (osm_ref, nome, geom)
   values ('teste/1', 'Posto Teste', st_setsrid(st_makepoint(LNG, LAT), 4326)::geography);
   ```
   Atualize o preço, confirme com outra conta (outro navegador/aba anônima) e veja o selo ir de 🔴 para 🟢. Depois apague:
   ```sql
   delete from postos where osm_ref = 'teste/1';
   ```
4. Instale na tela inicial e teste com a internet desligada: o app abre e mostra os últimos dados salvos.

## Regras de negócio (validadas no servidor, em `enviar_preco`)
| Regra | Valor |
|---|---|
| Geofence | ≤ 150 m do posto e GPS com precisão ≤ 100 m |
| Modo parado | ≤ 5 km/h (cliente trava o botão; servidor rejeita > 1,4 m/s) |
| Outlier | variação > 25% da mediana regional (motoristas, 50 km, 30 dias; ou ANP se houver < 3 amostras) |
| Rate limit | 1 envio por usuário/posto/combustível por hora |
| Selos | 🔴 usuário novo/base pública · 🟡 1 atualização de usuário com histórico · 🟢 2+ motoristas distintos (±R$ 0,02 em 48 h) |
| Validade | selo some se o preço tiver mais de 7 dias |
| Rota | buffer de até 500 m de cada lado, ordenado por menor preço e menor desvio |

## Limitações conhecidas
- Velocidade, posição e precisão vêm do navegador: o modo parado e o geofence protegem a segurança e a qualidade do dado, mas **não impedem GPS falso**.
- OSRM demo, Nominatim, Overpass e tiles do OSM são serviços públicos de uso justo. Para produção, use provedores próprios ou pagos.
- Login anônimo facilita a entrada, mas permite várias contas por pessoa. Evolua para ponderar confirmações pela reputação.
