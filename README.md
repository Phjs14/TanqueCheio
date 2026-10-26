# ⛽ TanqueCheio — Rode mais, pague menos.

PWA para motoristas, caminhoneiros e rodoviários acharem o combustível mais barato **ao longo da rota** e atualizarem preços de forma colaborativa, com validação geográfica.

## Estrutura

```
tanquecheio/
├── index.html                      UI mobile-first (dark #18181B / verde #10B981)
├── app.js                          Lógica (Leaflet, GPS, geofence, modo parado, Supabase)
├── sw.js                           Service Worker (Stale-While-Revalidate)
├── manifest.json                   Manifesto PWA
├── icons/                          icon-192, icon-512, maskable-512
├── schema.sql                      Banco (PostGIS, RLS, RPCs). Idempotente.
├── scripts/importar_anp.py         Referência de preços da ANP (para o filtro de outlier)
└── supabase/functions/importar-postos-osm/index.ts   Importador de postos do OSM por estado
```

## Passo a passo

### 1. Banco
1. No Supabase: **Authentication → Providers → Allow anonymous sign-ins** (ligar).
2. **SQL Editor**: cole e rode `schema.sql` (pode rodar de novo a qualquer momento).

### 2. Front-end
1. Em `app.js`, preencha `SUPABASE_URL` e `SUPABASE_ANON_KEY` (Project Settings → API; a *anon key* é pública).
2. Publique a pasta em qualquer hospedagem **HTTPS** (Netlify, Vercel, GitHub Pages). GPS e Service Worker não funcionam em HTTP.
3. Abra no celular e use "Adicionar à tela inicial".

### 3. Postos do OSM
Dois modos:
- **Início rápido** (padrão): o próprio app lê o Overpass e envia os postos (`SEMEAR_PELO_CLIENTE: true`).
- **Produção** (recomendado): Edge Function.
  ```bash
  supabase functions deploy importar-postos-osm --no-verify-jwt
  supabase secrets set CRON_SECRET=troque-por-um-segredo-grande
  ```
  Teste (um estado):
  ```bash
  curl -X POST "https://SEU-PROJETO.supabase.co/functions/v1/importar-postos-osm" \
    -H "x-cron-secret: troque-por-um-segredo-grande" -H "Content-Type: application/json" \
    -d '{"uf":"SE"}'
  ```
  Agendamento diário (um estado por dia, rodízio de 27 dias) com `pg_cron` + `pg_net`
  (ative as duas extensões em Database → Extensions):
  ```sql
  select cron.schedule('tanquecheio-osm', '0 3 * * *', $$
    select net.http_post(
      url     := 'https://SEU-PROJETO.supabase.co/functions/v1/importar-postos-osm',
      headers := '{"Content-Type":"application/json","x-cron-secret":"troque-por-um-segredo-grande"}'::jsonb,
      body    := '{"uf":"auto"}'::jsonb
    );
  $$);
  ```
  Para o primeiro carregamento, chame manualmente com cada UF.
  Quando os postos estiverem populados: `SEMEAR_PELO_CLIENTE: false` no `app.js` e rode no SQL
  `revoke execute on function upsert_postos_osm(jsonb) from authenticated;`

  Se algum estado grande (SP, MG) estourar o tempo da função, divida a consulta (por exemplo, por mesorregião) ou rode o mesmo script Overpass localmente.

### 4. Referência de preços da ANP (opcional, mas recomendado)
Sem ela, nas regiões com menos de 3 preços de motoristas o filtro de outlier não tem régua.
1. Baixe o CSV do levantamento semanal de preços da ANP (portal de dados abertos, gov.br).
2. Tenha um CSV de municípios com nome, UF (sigla ou código IBGE), latitude e longitude.
3. Rode (use `--dry-run` primeiro para conferir a leitura das colunas):
   ```bash
   export SUPABASE_URL="https://SEU-PROJETO.supabase.co"
   export SUPABASE_SERVICE_KEY="..."   # service_role: nunca no front-end nem no git
   python3 scripts/importar_anp.py levantamento_anp.csv --centroides municipios.csv --dry-run
   python3 scripts/importar_anp.py levantamento_anp.csv --centroides municipios.csv
   ```
4. Repita semanalmente (o script sobrescreve a referência anterior).

> O script foi escrito com base no layout conhecido do CSV da ANP e tolera variações de acento e caixa nos nomes das colunas. Se a ANP mudar o layout, o `--dry-run` mostra o cabeçalho lido.

## Regras de negócio (todas validadas no servidor, em `enviar_preco`)
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
