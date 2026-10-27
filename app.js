// =====================================================================
// TanqueCheio — app.js (ES Module) v3
// Seções: 1 Config · 2 Estado · 3 Utils · 4 Mapa · 5 Painel (sheet) · 6 GPS/Permissão/Geofence ·
//         7 APIs externas · 8 Supabase · 9 Render · 10 Modal · 11 Init
// Novidades v3: interface limpa (mapa em destaque + painel inferior), fluxo de permissão de
// localização por clique (sem pedir no carregamento), chaves do Supabase em config.js.
// =====================================================================
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

// ---------- 1. CONFIG ----------
const CONFIG = {
  GEOFENCE_M: 150,                         // raio máximo p/ atualizar preço
  GPS_MAX_ACCURACY_M: 100,                 // GPS pior que isso não libera atualização
  VELOCIDADE_MAX_KMH: 5,                   // acima disso = "em movimento"
  BUFFER_ROTA_M: 500,
  SEMEAR_PELO_CLIENTE: true,               // false quando a Edge Function já popular os postos
  OVERPASS: 'https://overpass-api.de/api/interpreter',
  OSRM: 'https://router.project-osrm.org/route/v1/driving', // demo: só para testes
  NOMINATIM: 'https://nominatim.openstreetmap.org/search',
};
const COMBUSTIVEIS = {
  gasolina_comum: 'Gasolina', gasolina_aditivada: 'Aditivada', etanol: 'Etanol',
  diesel_s10: 'Diesel S10', diesel_s500: 'Diesel S500', gnv: 'GNV',
};
const SELOS = { nao_verificado: '🔴 Não verificado', pendente: '🟡 Pendente', verificado: '🟢 Verificado' };
const COR_PIN = { nao_verificado: '#EF4444', pendente: '#EAB308', verificado: '#10B981' };
const IN_APP = /FBAN|FBAV|Instagram|WhatsApp|Snapchat|Line\/|; wv\)/i.test(navigator.userAgent);

let sb = null;   // cliente Supabase (criado no init, depois de ler o config.js)

// ---------- 2. ESTADO ----------
const combSalvo = localStorage.getItem('tc:comb');
const S = {
  map: null, userMarker: null, userCircle: null, camadaRota: null, camadaPostos: null,
  markers: new Map(),
  userPos: null,                // { lat, lng, acc, speed }  speed em m/s (ou null)
  locEstado: 'verificando',     // verificando | prompt | buscando | ok | denied | inseguro | indisponivel
  watchId: null, primeiroFix: true,
  rota: null,
  combustivel: combSalvo in COMBUSTIVEIS ? combSalvo : 'gasolina_comum',
  aba: 'proximos',
  postos: [], selId: null, postoAtivo: null,
  sheet: 'peek', sessao: null,
};

// ---------- 3. UTILS ----------
const $ = (id) => document.getElementById(id);
// Nomes vêm do OSM (conteúdo de terceiros) => SEMPRE escapar antes de usar em innerHTML
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const brl = (n) => Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 3 });
const fmtDist = (m) => (m >= 1000 ? (m / 1000).toFixed(1).replace('.', ',') + ' km' : Math.round(m) + ' m');

function toast(msg, ms = 3200) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

// Distância Haversine em metros entre dois pontos {lat,lng}
function haversine(a, b) {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Mantém 1 ponto a cada `minM` metros (OSRM devolve milhares de pontos)
function decimar(coords, minM) {
  if (coords.length < 3) return coords;
  const out = [coords[0]]; let ult = { lat: coords[0][1], lng: coords[0][0] };
  for (let i = 1; i < coords.length - 1; i++) {
    const p = { lat: coords[i][1], lng: coords[i][0] };
    if (haversine(ult, p) >= minM) { out.push(coords[i]); ult = p; }
  }
  out.push(coords[coords.length - 1]);
  return out;
}

// ---------- 4. MAPA ----------
function initMap() {
  S.map = L.map('map', { zoomControl: false }).setView([-14.2, -51.9], 4);
  if (innerWidth >= 900) L.control.zoom({ position: 'topright' }).addTo(S.map);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  }).addTo(S.map);
  // Atribuição obrigatória do OSM, movida para o rodapé do painel (não polui o mapa)
  S.map.attributionControl.setPrefix(false);
  $('attr').appendChild(S.map.attributionControl.getContainer());
  S.camadaPostos = L.layerGroup().addTo(S.map);
}

// Área do mapa que NÃO está coberta pelo topo/painel — usada para centralizar e dar fitBounds
function padMapa() {
  const desktop = innerWidth >= 900;
  const top = $('topbar').offsetHeight + 8;
  const bottom = desktop ? 16 : alturaSheet() + 8;
  const left = desktop ? 452 : 16;
  return { paddingTopLeft: [left, top], paddingBottomRight: [16, bottom] };
}
function centralizarEm(ll, zoom) {
  const { paddingTopLeft: [l, t], paddingBottomRight: [r, b] } = padMapa();
  const size = S.map.getSize();
  const cx = (l + (size.x - r)) / 2, cy = (t + (size.y - b)) / 2;
  const alvo = S.map.project(ll, zoom).subtract([cx - size.x / 2, cy - size.y / 2]);
  S.map.setView(S.map.unproject(alvo, zoom), zoom, { animate: true });
}

function pinIcon(p, sel) {
  const html = p.preco == null
    ? `<div class="pin-vazio${sel ? ' sel' : ''}">⛽</div>`
    : `<div class="pin-preco${sel ? ' sel' : ''}" style="--c:${COR_PIN[p.nivel_confianca]}">${brl(p.preco)}</div>`;
  return L.divIcon({ className: 'pin-wrap', iconSize: [0, 0], iconAnchor: [0, 0], html });
}

// ---------- 5. PAINEL INFERIOR (mini / peek / full) ----------
const ORDEM_SHEET = ['mini', 'peek', 'full'];
function alturaSheet() {
  return { mini: 88, peek: Math.round(innerHeight * 0.42), full: Math.round(innerHeight * 0.86) }[S.sheet];
}
function setSheet(estado) {
  S.sheet = estado;
  const el = $('sheet'); el.classList.remove('mini', 'peek', 'full'); el.classList.add(estado);
}
function mudarSheet(dir) {   // dir: +1 sobe, -1 desce, undefined = cicla
  const i = ORDEM_SHEET.indexOf(S.sheet);
  setSheet(ORDEM_SHEET[dir == null ? (i + 1) % 3 : Math.max(0, Math.min(2, i + dir))]);
}
function bindSheet() {
  $('handle').addEventListener('click', () => mudarSheet());
  let y0 = null;                                          // gesto de arrastar no cabeçalho
  const head = $('sheetHead');
  head.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; }, { passive: true });
  head.addEventListener('touchend', (e) => {
    if (y0 == null) return;
    const dy = e.changedTouches[0].clientY - y0; y0 = null;
    if (Math.abs(dy) > 30) mudarSheet(dy < 0 ? +1 : -1);
  });
}

// ---------- 6. GPS + PERMISSÃO + GEOFENCE + MODO PARADO ----------
// Regra de ouro: NÃO pedimos localização ao carregar a página. Se o navegador já tem permissão,
// começamos sozinhos; senão mostramos um botão e o pedido vem de um CLIQUE (o Chrome do celular
// bloqueia sozinho pedidos feitos sem gesto do usuário ou ignorados repetidamente).
async function checarPermissaoGps() {
  if (!window.isSecureContext) return setLocEstado('inseguro');
  if (!('geolocation' in navigator)) return setLocEstado('indisponivel');
  try {
    const st = await navigator.permissions.query({ name: 'geolocation' });
    const aplicar = () => {
      if (st.state === 'granted') comecarGPS();
      else { pararGPS(); setLocEstado(st.state); }        // 'prompt' | 'denied'
    };
    st.onchange = aplicar; aplicar();
  } catch { setLocEstado('prompt'); }                      // navegador sem Permissions API (Safari antigo)
}
function comecarGPS() {
  if (S.watchId != null) return;
  if (S.locEstado !== 'ok') setLocEstado('buscando');
  S.watchId = navigator.geolocation.watchPosition(onPos, onPosErro, {
    enableHighAccuracy: true, maximumAge: 5000, timeout: 20000,
  });
}
function pararGPS() {
  if (S.watchId != null) { navigator.geolocation.clearWatch(S.watchId); S.watchId = null; }
}
function pedirLocalizacao() { comecarGPS(); }               // chamado por clique => abre o prompt do navegador

function setLocEstado(e) { S.locEstado = e; atualizarPill(); renderLista(); }

function onPos(p) {
  S.userPos = {
    lat: p.coords.latitude, lng: p.coords.longitude,
    acc: p.coords.accuracy, speed: p.coords.speed,          // speed: m/s, pode vir null
  };
  const ll = [S.userPos.lat, S.userPos.lng];
  if (!S.userMarker) {
    S.userMarker = L.marker(ll, {
      icon: L.divIcon({ className: 'me-wrap', iconSize: [0, 0], html: '<div class="me"></div>' }),
      interactive: false, zIndexOffset: 2000,
    }).addTo(S.map);
    S.userCircle = L.circle(ll, { radius: S.userPos.acc, color: '#3B82F6', weight: 1, fillOpacity: 0.1, interactive: false }).addTo(S.map);
  } else { S.userMarker.setLatLng(ll); S.userCircle.setLatLng(ll).setRadius(Math.min(S.userPos.acc, 500)); }

  const eraOk = S.locEstado === 'ok';
  S.locEstado = 'ok'; atualizarPill();
  if (!eraOk) renderLista();                                // some o aviso de permissão
  if (S.primeiroFix) { S.primeiroFix = false; centralizarEm(ll, 14); buscarProximos(); }
  atualizarBotoesGeofence();

  // Segurança: se o veículo começar a andar com o modal aberto, fecha na hora
  if ($('modalPreco').open && !parado()) {
    $('modalPreco').close();
    toast('🛑 Veículo em movimento. Pare para atualizar o preço.');
  }
}
function onPosErro(e) {
  if (e.code === 1) { pararGPS(); S.userPos = null; setLocEstado('denied'); }   // permissão negada
  else if (!S.userPos) { atualizarPill(); toast('Sem sinal de GPS. Vá para um local aberto.'); }
}
function atualizarPill() {
  const el = $('gpsStatus'); let txt, cls;
  switch (S.locEstado) {
    case 'ok': {
      const u = S.userPos, kmh = u.speed != null ? Math.round(u.speed * 3.6) : null;
      txt = kmh != null && kmh > CONFIG.VELOCIDADE_MAX_KMH ? `🚗 ${kmh} km/h` : `📍 GPS ±${Math.round(u.acc)} m`;
      cls = u.acc <= CONFIG.GPS_MAX_ACCURACY_M ? 'ok' : 'warn'; break;
    }
    case 'prompt': txt = '📍 Ativar localização'; cls = 'cta'; break;
    case 'denied': txt = '🚫 Localização bloqueada'; cls = 'bad'; break;
    case 'inseguro': txt = '🔒 Precisa de HTTPS'; cls = 'bad'; break;
    case 'indisponivel': txt = '📍 GPS indisponível'; cls = 'bad'; break;
    default: txt = '📍 Buscando GPS…'; cls = 'warn';
  }
  el.textContent = txt; el.className = 'gps ' + cls;
}
function aoClicarPill() {
  if (S.locEstado === 'prompt') return pedirLocalizacao();
  if (S.locEstado === 'ok') return centralizar();
  setSheet('peek'); $('lista').scrollTo({ top: 0, behavior: 'smooth' });   // mostra as instruções
}
function centralizar() {
  if (S.userPos) return centralizarEm([S.userPos.lat, S.userPos.lng], Math.max(S.map.getZoom(), 15));
  aoClicarPill();
}

// MODO PARADO: velocidade desconhecida (null) conta como parado (muitos aparelhos devolvem null parados)
function parado() {
  const v = S.userPos?.speed;
  return v == null || v * 3.6 <= CONFIG.VELOCIDADE_MAX_KMH;
}
function distAtePosto(p) { return S.userPos ? haversine(S.userPos, { lat: p.lat, lng: p.lng }) : Infinity; }
function podeAtualizar(p) {
  return !!S.userPos && S.userPos.acc <= CONFIG.GPS_MAX_ACCURACY_M && distAtePosto(p) <= CONFIG.GEOFENCE_M && parado();
}
function textoBotao(p) {                                   // curto, cabe no card
  if (!S.userPos) return '📍 Sem GPS';
  if (S.userPos.acc > CONFIG.GPS_MAX_ACCURACY_M) return '📍 GPS fraco';
  const d = distAtePosto(p);
  if (d > CONFIG.GEOFENCE_M) return `🔒 a ${fmtDist(d)}`;
  if (!parado()) return '🛑 Pare p/ editar';
  return '✏️ Atualizar';
}
function textoBloqueio(p) {                                // explicação completa (toast/modal)
  if (!S.userPos) return 'Ative a localização para atualizar preços.';
  if (S.userPos.acc > CONFIG.GPS_MAX_ACCURACY_M) return 'Sinal de GPS fraco. Tente em campo aberto.';
  const d = distAtePosto(p);
  if (d > CONFIG.GEOFENCE_M) return `Chegue a até ${CONFIG.GEOFENCE_M} m do posto para atualizar (você está a ${fmtDist(d)}).`;
  return 'Pare o veículo para atualizar o preço.';
}
function atualizarBotoesGeofence() {
  document.querySelectorAll('[data-btn-posto]').forEach((b) => {
    const p = S.postos.find((x) => x.id === b.dataset.btnPosto); if (!p) return;
    b.disabled = !podeAtualizar(p); b.textContent = textoBotao(p);
  });
}

// ---------- 7. APIs EXTERNAS ----------
async function geocodificar(q) {
  const r = await fetch(`${CONFIG.NOMINATIM}?format=json&limit=1&countrycodes=br&q=${encodeURIComponent(q)}`,
    { headers: { 'Accept-Language': 'pt-BR' } });
  const j = await r.json();
  if (!j.length) throw new Error(`Local não encontrado: ${q}`);
  return { lat: +j[0].lat, lng: +j[0].lon };
}
async function obterRota(o, d) {
  const r = await fetch(`${CONFIG.OSRM}/${o.lng},${o.lat};${d.lng},${d.lat}?overview=full&geometries=geojson`);
  const j = await r.json();
  if (j.code !== 'Ok') throw new Error('Não consegui traçar a rota');
  return j.routes[0].geometry.coordinates;                  // [[lng,lat],...]
}
// Lê postos amenity=fuel do OSM e envia ao Supabase (insert-only). `aroundArg` = "raio,lat,lng[,lat,lng...]"
async function semearPostosOSM(aroundArg) {
  if (!CONFIG.SEMEAR_PELO_CLIENTE || !navigator.onLine) return;
  await S.sessao;                                           // a RPC exige sessão (anônima)
  const q = `[out:json][timeout:25];nwr["amenity"="fuel"](around:${aroundArg});out center tags;`;
  const r = await fetch(`${CONFIG.OVERPASS}?data=${encodeURIComponent(q)}`);
  if (!r.ok) throw new Error('Overpass indisponível');
  const j = await r.json();
  const lista = j.elements.map((e) => ({
    osm_ref: `${e.type}/${e.id}`, nome: e.tags?.name || e.tags?.brand || '', marca: e.tags?.brand || '',
    lat: e.lat ?? e.center?.lat, lng: e.lon ?? e.center?.lon,
  })).filter((p) => p.lat != null && p.lng != null);
  for (let i = 0; i < lista.length; i += 400) await sb.rpc('upsert_postos_osm', { p_postos: lista.slice(i, i + 400) });
}

// ---------- 8. SUPABASE ----------
async function garantirSessao() {
  const { data } = await sb.auth.getSession();
  if (!data.session) {
    const { error } = await sb.auth.signInAnonymously();    // zero fricção p/ motorista
    if (error) toast('Falha ao iniciar sessão: ' + error.message);
  }
}

async function tracarRota() {
  const btn = $('btnRota'); btn.disabled = true; btn.textContent = '…';
  try {
    const txtO = $('origem').value.trim(), txtD = $('destino').value.trim();
    if (!txtD) throw new Error('Digite o destino');
    const origem = txtO ? await geocodificar(txtO) : S.userPos;
    if (!origem) throw new Error('Sem GPS: toque em "De:" e informe a origem');
    const destino = await geocodificar(txtD);

    const completa = await obterRota(origem, destino);
    const coords = decimar(completa, 300);
    S.rota = { type: 'LineString', coordinates: coords };

    if (S.camadaRota) S.camadaRota.remove();
    S.camadaRota = L.polyline(completa.map(([lng, lat]) => [lat, lng]), { color: '#10B981', weight: 5, opacity: 0.9 }).addTo(S.map);
    $('btnLimpar').hidden = false; document.activeElement?.blur();
    S.aba = 'rota'; marcarAbas(); setSheet('peek');
    S.map.fitBounds(S.camadaRota.getBounds(), padMapa());

    // Semeia postos do OSM só no corredor da rota (pontos a cada ~3 km, máx. 120)
    let pts = decimar(coords, 3000); const passo = Math.ceil(pts.length / 120);
    pts = pts.filter((_, i) => i % passo === 0);
    try { await semearPostosOSM(`600,${pts.map(([lng, lat]) => `${lat.toFixed(5)},${lng.toFixed(5)}`).join(',')}`); }
    catch (e) { console.warn('Semeadura OSM falhou (segue com a base atual):', e); }
    await buscarNaRota();
  } catch (e) { toast(e.message); }
  finally { btn.disabled = false; btn.textContent = '➜'; }
}
function limparRota() {
  if (S.camadaRota) S.camadaRota.remove();
  S.camadaRota = null; S.rota = null; $('destino').value = ''; $('btnLimpar').hidden = true;
  S.aba = 'proximos'; marcarAbas(); buscarProximos();
}

async function buscarNaRota() {
  if (!S.rota) { S.postos = []; return renderLista(); }
  const { data, error } = await sb.rpc('buscar_postos_na_rota', {
    p_rota: S.rota, p_tipo: S.combustivel, p_buffer_m: CONFIG.BUFFER_ROTA_M, p_limite: 40,
  });
  aplicarResultado('rota', data, error);
}
async function buscarProximos() {
  if (!S.userPos) { S.postos = []; return renderLista(); }
  try { await semearPostosOSM(`6000,${S.userPos.lat.toFixed(5)},${S.userPos.lng.toFixed(5)}`); } catch { /* offline ok */ }
  const { data, error } = await sb.rpc('buscar_postos_proximos', {
    p_lat: S.userPos.lat, p_lng: S.userPos.lng, p_tipo: S.combustivel, p_raio_m: 6000, p_limite: 40,
  });
  aplicarResultado('proximos', data, error);
}
// Sucesso => guarda no localStorage. Erro/offline => mostra o último resultado salvo.
function aplicarResultado(aba, data, error) {
  if (aba !== S.aba) return;                                // usuário já trocou de aba: ignora resposta atrasada
  const chave = `tc:${aba}:${S.combustivel}`;
  if (error) {
    const salvo = JSON.parse(localStorage.getItem(chave) || 'null');
    if (salvo) { toast('Sem conexão: mostrando dados salvos'); S.postos = salvo.postos; }
    else { toast('Erro ao buscar postos'); S.postos = []; }
  } else {
    S.postos = data || [];
    try { localStorage.setItem(chave, JSON.stringify({ postos: S.postos, ts: Date.now() })); } catch { /* quota */ }
  }
  renderLista();
}
function marcarAbas() {
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.aba === S.aba)));
}
function trocarAba(aba) {
  S.aba = aba; marcarAbas(); S.postos = []; renderLista();
  (aba === 'rota' ? buscarNaRota : buscarProximos)();
}

// ---------- 9. RENDER ----------
function locBoxHtml() {
  switch (S.locEstado) {
    case 'prompt': return `<div class="locbox"><b>📍 Ative sua localização</b>
      <p>Usamos para mostrar os postos perto de você e liberar a atualização de preço quando você estiver no posto.</p>
      <button class="btn-mini" data-acao="ativar-loc">Ativar localização</button></div>`;
    case 'denied': return `<div class="locbox warn"><b>🚫 Localização bloqueada neste navegador</b>
      <p>O navegador guardou uma negação anterior e por isso não pergunta de novo. Libere uma vez:</p>
      <ol>
        <li><b>Chrome:</b> toque no ícone ao lado do endereço (🔒 ou ⓘ) → <i>Permissões</i> → <i>Localização</i> → <i>Permitir</i>.</li>
        <li><b>iPhone:</b> Ajustes → Privacidade e Segurança → Serviços de Localização → Safari.</li>
        <li>Confira se a <b>Localização do celular</b> está ligada.</li>
        <li>Se instalou o app na tela inicial: segure o ícone → <i>Informações do app</i> → <i>Permissões</i> → Localização.</li>
      </ol>
      ${IN_APP ? '<p>⚠️ Você abriu por dentro de outro app (WhatsApp, Instagram…). Toque em ⋮ → <i>Abrir no Chrome</i>.</p>' : ''}
      <button class="btn-mini" data-acao="tentar-loc">Já liberei, tentar de novo</button></div>`;
    case 'inseguro': return `<div class="locbox warn"><b>🔒 Esta página precisa de HTTPS</b><p>O GPS só funciona em endereço seguro (https://).</p></div>`;
    case 'indisponivel': return `<div class="locbox warn"><b>📍 Este aparelho/navegador não oferece GPS</b></div>`;
    default: return '';
  }
}

function cardHtml(p, melhorId) {
  const temPreco = p.preco != null;
  const info = S.aba === 'rota'
    ? `km ${p.km_na_rota} da rota · desvio ${fmtDist(p.desvio_m)}`
    : `${fmtDist(p.desvio_m)} de você`;
  return `
    <article class="posto${p.id === S.selId ? ' sel' : ''}" data-id="${esc(p.id)}">
      <div class="p-top">
        <div><div class="p-nome">${esc(p.nome)}</div><div class="p-meta">${esc(p.marca ? p.marca + ' · ' : '')}${info}</div></div>
        <div class="p-preco ${temPreco ? '' : 'vazio'}">${temPreco ? 'R$ ' + brl(p.preco) : 'Sem preço — seja o primeiro!'}</div>
      </div>
      <div class="p-bottom">
        <div><span class="selo ${p.nivel_confianca}">${SELOS[p.nivel_confianca]}</span>
          ${p.id === melhorId ? '<span class="melhor"> 🏆 mais barato</span>' : ''}</div>
        <button class="btn-mini" data-btn-posto="${esc(p.id)}"></button>
      </div>
    </article>`;
}

function renderLista() {
  if (!S.map) return;
  const precisaAcao = ['prompt', 'denied', 'inseguro', 'indisponivel'].includes(S.locEstado);
  const melhorId = S.postos[0]?.preco != null ? S.postos[0].id : null;     // lista já vem ordenada por preço
  let corpo;
  if (S.postos.length) corpo = S.postos.map((p) => cardHtml(p, melhorId)).join('');
  else if (S.aba === 'rota') corpo = `<div class="vazio-msg">${S.rota ? 'Nenhum posto encontrado nesse trajeto.' : 'Digite um destino lá em cima para ver os postos no seu caminho.'}</div>`;
  else corpo = precisaAcao || S.locEstado === 'verificando' ? '' : `<div class="vazio-msg">${S.userPos ? 'Nenhum posto por perto ainda.' : 'Buscando sua localização…'}</div>`;
  $('lista').innerHTML = locBoxHtml() + corpo;

  const n = S.postos.length;
  $('tabRota').textContent = `Na rota${S.aba === 'rota' && n ? ` (${n})` : ''}`;
  $('tabProximos').textContent = `Próximos${S.aba === 'proximos' && n ? ` (${n})` : ''}`;
  renderMarkers(); atualizarBotoesGeofence();
}

function renderMarkers() {
  S.camadaPostos.clearLayers(); S.markers.clear();
  S.postos.forEach((p) => {
    const m = L.marker([p.lat, p.lng], { icon: pinIcon(p, p.id === S.selId) }).addTo(S.camadaPostos);
    m.on('click', () => { if (S.sheet === 'mini') setSheet('peek'); selecionar(p.id, { rolar: true }); });
    S.markers.set(p.id, m);
  });
}

function selecionar(id, { rolar = false, mover = true } = {}) {
  S.selId = id;
  document.querySelectorAll('.posto').forEach((el) => el.classList.toggle('sel', el.dataset.id === id));
  S.postos.forEach((p) => {
    const m = S.markers.get(p.id); if (!m) return;
    m.setIcon(pinIcon(p, p.id === id)); m.setZIndexOffset(p.id === id ? 1000 : 0);
  });
  const p = S.postos.find((x) => x.id === id); if (!p) return;
  if (mover) centralizarEm([p.lat, p.lng], Math.max(S.map.getZoom(), 14));
  if (rolar) document.querySelector(`.posto[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function renderChips() {
  $('chipsCombustivel').innerHTML = Object.entries(COMBUSTIVEIS).map(([k, v]) =>
    `<button class="chip" type="button" data-comb="${k}" aria-pressed="${k === S.combustivel}">${v}</button>`).join('');
}

// ---------- 10. MODAL DE PREÇO ----------
function abrirModal(posto) {
  if (!podeAtualizar(posto)) return toast(textoBloqueio(posto));
  S.postoAtivo = posto;
  $('mpNome').textContent = posto.nome;
  $('mpInfo').textContent = `Você está a ${Math.round(distAtePosto(posto))} m do posto ✔`;
  $('mpTipo').innerHTML = Object.entries(COMBUSTIVEIS).map(([k, v]) =>
    `<option value="${k}" ${k === S.combustivel ? 'selected' : ''}>${v}</option>`).join('');
  $('precoInput').value = ''; $('mpErro').textContent = '';

  // Confirmação com 1 toque: se já existe preço, mostra "✅ Confirmar R$ X" (conta como confirmação)
  const bc = $('mpConfirmar');
  if (posto.preco != null) { bc.hidden = false; bc.textContent = `✅ Confirmar R$ ${brl(posto.preco)}`; bc.dataset.preco = String(posto.preco); }
  else { bc.hidden = true; delete bc.dataset.preco; }

  $('modalPreco').showModal();
  if (posto.preco == null) $('precoInput').focus();
}

const ERROS = {
  FORA_DO_RAIO: 'Você está longe demais do posto (máx. 150 m).',
  GPS_IMPRECISO: 'Sinal de GPS fraco. Tente de novo em campo aberto.',
  EM_MOVIMENTO: 'Pare o veículo para atualizar o preço.',
  OUTLIER: 'Esse preço está muito fora da média da região. Confira o valor.',
  AGUARDE: 'Você já atualizou este combustível há pouco. Tente em 1 hora.',
  PRECO_INVALIDO: 'Preço inválido.',
  AUTH_REQUIRED: 'Sessão expirada. Recarregue o app.',
};
const traduzErro = (msg = '') => ERROS[Object.keys(ERROS).find((c) => msg.includes(c))] || 'Não foi possível enviar. Tente novamente.';

// Envio comum (digitado OU confirmação com 1 toque). O servidor revalida tudo.
async function enviarPrecoValor(preco) {
  const posto = S.postoAtivo; if (!posto) return;
  if (!podeAtualizar(posto)) { $('mpErro').textContent = textoBloqueio(posto); return; }
  const btns = [$('mpEnviar'), $('mpConfirmar')]; btns.forEach((b) => (b.disabled = true));
  const { data, error } = await sb.rpc('enviar_preco', {
    p_posto_id: posto.id, p_tipo: $('mpTipo').value, p_preco: preco,
    p_lat: S.userPos.lat, p_lng: S.userPos.lng, p_precisao_m: S.userPos.acc, p_velocidade_ms: S.userPos.speed,
  });
  btns.forEach((b) => (b.disabled = false));
  if (error) { $('mpErro').textContent = traduzErro(error.message); return; }
  $('modalPreco').close();
  toast(`Obrigado! +${data.pontos} pts · selo ${SELOS[data.nivel]}`);
  (S.aba === 'rota' ? buscarNaRota : buscarProximos)();
}
function enviarDigitado(ev) {
  ev.preventDefault();
  const preco = parseFloat($('precoInput').value.replace(',', '.'));
  if (!(preco >= 1 && preco <= 30)) { $('mpErro').textContent = 'Digite um preço válido (ex.: 5,89).'; return; }
  enviarPrecoValor(preco);
}
function enviarConfirmacao() {
  if ($('mpTipo').value !== S.combustivel) { $('mpErro').textContent = 'Digite o preço do combustível escolhido.'; return; }
  enviarPrecoValor(parseFloat($('mpConfirmar').dataset.preco));
}

// ---------- 11. INIT ----------
async function carregarConfig() {
  try {
    const m = await import('./config.js');
    const c = m.default;
    if (!c?.SUPABASE_URL || c.SUPABASE_URL.includes('SEU-PROJETO')) throw new Error('placeholder');
    return c;
  } catch {
    $('lista').innerHTML = `<div class="locbox warn"><b>⚙️ Falta configurar o Supabase</b>
      <p>Abra o arquivo <b>config.js</b> (ao lado do index.html) e preencha <b>SUPABASE_URL</b> e <b>SUPABASE_ANON_KEY</b>.</p></div>`;
    return null;
  }
}

async function init() {
  const cfg = await carregarConfig(); if (!cfg) return;
  sb = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

  initMap(); renderChips(); bindSheet(); renderLista();

  $('chipsCombustivel').addEventListener('click', (e) => {
    const b = e.target.closest('[data-comb]'); if (!b) return;
    S.combustivel = b.dataset.comb; localStorage.setItem('tc:comb', S.combustivel);
    document.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === b)));
    (S.aba === 'rota' ? buscarNaRota : buscarProximos)();
  });
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => trocarAba(b.dataset.aba)));

  // Lista: clique no botão do card = abrir modal; clique no card = selecionar no mapa; botões do aviso de GPS
  $('lista').addEventListener('click', (e) => {
    const acao = e.target.closest('[data-acao]')?.dataset.acao;
    if (acao === 'ativar-loc') return pedirLocalizacao();
    if (acao === 'tentar-loc') return checarPermissaoGps().then(() => { if (S.locEstado === 'denied') comecarGPS(); });
    const bp = e.target.closest('[data-btn-posto]');
    if (bp) return abrirModal(S.postos.find((p) => p.id === bp.dataset.btnPosto));
    const card = e.target.closest('.posto');
    if (card) { if (S.sheet === 'full') setSheet('peek'); selecionar(card.dataset.id); }
  });

  $('gpsStatus').addEventListener('click', aoClicarPill);
  $('btnCentro').addEventListener('click', centralizar);
  $('btnRota').addEventListener('click', tracarRota);
  $('btnLimpar').addEventListener('click', limparRota);
  $('destino').addEventListener('keydown', (e) => e.key === 'Enter' && tracarRota());
  $('btnOrigem').addEventListener('click', () => {
    const o = $('origem'); o.hidden = !o.hidden;
    $('btnOrigem').textContent = o.hidden ? 'De: minha localização ▾' : 'De: outro lugar ▴ (vazio = minha localização)';
    if (!o.hidden) o.focus();
  });
  $('formPreco').addEventListener('submit', enviarDigitado);
  $('mpConfirmar').addEventListener('click', enviarConfirmacao);
  $('mpCancelar').addEventListener('click', () => $('modalPreco').close());

  // Service Worker + recarrega sozinho quando uma versão nova assume (evita ficar preso no app antigo)
  if ('serviceWorker' in navigator) {
    const tinhaSW = !!navigator.serviceWorker.controller; let recarregou = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (tinhaSW && !recarregou) { recarregou = true; location.reload(); }
    });
    navigator.serviceWorker.register('sw.js').catch(console.warn);
  }

  S.sessao = garantirSessao();      // não bloqueia o GPS
  checarPermissaoGps();
}
init();
