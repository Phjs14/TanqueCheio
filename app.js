// =====================================================================
// TanqueCheio — app.js (ES Module) v2
// Seções: 1 Config · 2 Estado · 3 Utils · 4 Mapa · 5 GPS/Geofence/Modo parado ·
//         6 APIs externas · 7 Supabase · 8 Render · 9 Modal · 10 Init
// Novidades v2: modo "parado" (velocidade do GPS), botão de confirmação com 1 toque,
//               flag para desligar a semeadura de postos pelo cliente.
// =====================================================================
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

// ---------- 1. CONFIG ----------
const CONFIG = {
  SUPABASE_URL: 'https://kavvpcbvqnstibwxymai.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImthdnZwY2J2cW5zdGlid3h5bWFpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI3NjEzNTEsImV4cCI6MjEwODMzNzM1MX0.Mvk8AtS-wUO2rMs2ldoE_jntkJdyLxFny5avG-H67RY',      // a anon key é pública; a segurança está no RLS + RPC
  GEOFENCE_M: 150,                         // regra de negócio: raio máximo p/ atualizar preço
  GPS_MAX_ACCURACY_M: 100,                 // GPS pior que isso não libera atualização
  VELOCIDADE_MAX_KMH: 5,                   // acima disso = "em movimento": atualização bloqueada
  BUFFER_ROTA_M: 500,
  SEMEAR_PELO_CLIENTE: true,               // true = início rápido; false = só Edge Function popula postos
  OVERPASS: 'https://overpass-api.de/api/interpreter',
  OSRM: 'https://router.project-osrm.org/route/v1/driving', // demo: só para testes, ver README
  NOMINATIM: 'https://nominatim.openstreetmap.org/search',
};
const COMBUSTIVEIS = {
  gasolina_comum: 'Gasolina', gasolina_aditivada: 'Gas. Aditivada', etanol: 'Etanol',
  diesel_s10: 'Diesel S10', diesel_s500: 'Diesel S500', gnv: 'GNV',
};
const SELOS = {
  nao_verificado: '🔴 Não verificado', pendente: '🟡 Pendente', verificado: '🟢 Verificado',
};
const COR_PIN = { nao_verificado: '#EF4444', pendente: '#EAB308', verificado: '#10B981' };

const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

// ---------- 2. ESTADO ----------
const S = {
  map: null, userMarker: null, camadaRota: null, camadaPostos: null,
  userPos: null,                // { lat, lng, acc, speed }  speed em m/s (ou null)
  rota: null,                   // GeoJSON LineString
  combustivel: 'gasolina_comum',
  aba: 'rota',
  postos: [],
  postoAtivo: null,
  primeiroFix: true,
};

// ---------- 3. UTILS ----------
const $ = (id) => document.getElementById(id);
// Nomes vêm do OSM (conteúdo de terceiros) => SEMPRE escapar antes de usar em innerHTML
const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const brl = (n) => Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 3 });

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

// Reduz os pontos da rota (OSRM devolve milhares) mantendo 1 ponto a cada `minM` metros.
// Para buffer de 500 m, 300 m de espaçamento mantém precisão suficiente e payload pequeno.
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
  L.control.zoom({ position: 'topright' }).addTo(S.map);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '© OpenStreetMap contributors',
  }).addTo(S.map);
  S.camadaPostos = L.layerGroup().addTo(S.map);
}

function pinIcon(nivel, texto) {
  return L.divIcon({
    className: '', iconSize: [30, 30], iconAnchor: [15, 30],
    html: `<div class="pin" style="background:${COR_PIN[nivel]}"><span>${esc(texto)}</span></div>`,
  });
}

// ---------- 5. GPS + GEOFENCE + MODO PARADO ----------
function iniciarGPS() {
  if (!('geolocation' in navigator)) return setGps('GPS indisponível', false);
  navigator.geolocation.watchPosition(onPos, onPosErro, {
    enableHighAccuracy: true, maximumAge: 5000, timeout: 20000,
  });
}
function onPos(p) {
  S.userPos = {
    lat: p.coords.latitude, lng: p.coords.longitude,
    acc: p.coords.accuracy, speed: p.coords.speed,        // speed: m/s, pode vir null
  };
  const ll = [S.userPos.lat, S.userPos.lng];
  if (!S.userMarker) {
    S.userMarker = L.circleMarker(ll, { radius: 9, color: '#fff', weight: 3, fillColor: '#3B82F6', fillOpacity: 1 }).addTo(S.map);
  } else S.userMarker.setLatLng(ll);

  atualizarStatusGps();
  if (S.primeiroFix) { S.primeiroFix = false; S.map.setView(ll, 13); buscarProximos(); }
  atualizarBotoesGeofence();             // destrava/trava botões conforme a distância/velocidade mudam

  // Segurança: se o veículo começar a andar com o modal aberto, fecha na hora
  if ($('modalPreco').open && !parado()) {
    $('modalPreco').close();
    toast('🛑 Veículo em movimento. Pare para atualizar o preço.');
  }
}
function onPosErro(e) {
  setGps(e.code === 1 ? 'GPS negado' : 'GPS sem sinal', false);
}
function setGps(txt, ok) {
  const el = $('gpsStatus'); el.textContent = txt; el.className = 'gps ' + (ok ? 'ok' : 'bad');
}
function atualizarStatusGps() {
  const u = S.userPos; if (!u) return;
  const kmh = u.speed != null ? Math.round(u.speed * 3.6) : null;
  setGps(`GPS ±${Math.round(u.acc)} m${kmh != null ? ` · ${kmh} km/h` : ''}`, u.acc <= CONFIG.GPS_MAX_ACCURACY_M);
}

// MODO PARADO: velocidade desconhecida (null) é tratada como parado, porque vários aparelhos
// devolvem null quando estão realmente imóveis. O servidor também checa (RPC enviar_preco).
function parado() {
  const v = S.userPos?.speed;
  return v == null || v * 3.6 <= CONFIG.VELOCIDADE_MAX_KMH;
}

// Regra do blindex (lado cliente — o servidor revalida): ≤150 m, GPS preciso e veículo parado
function distAtePosto(posto) { return S.userPos ? haversine(S.userPos, { lat: posto.lat, lng: posto.lng }) : Infinity; }
function podeAtualizar(posto) {
  return !!S.userPos && S.userPos.acc <= CONFIG.GPS_MAX_ACCURACY_M
    && distAtePosto(posto) <= CONFIG.GEOFENCE_M && parado();
}
function textoBotao(posto) {
  if (!S.userPos) return '📍 Aguardando GPS…';
  if (S.userPos.acc > CONFIG.GPS_MAX_ACCURACY_M) return '📍 GPS impreciso';
  const d = distAtePosto(posto);
  if (d > CONFIG.GEOFENCE_M) return `🔒 Chegue a ${CONFIG.GEOFENCE_M} m (faltam ${Math.round(d - CONFIG.GEOFENCE_M)} m)`;
  if (!parado()) return '🛑 Pare o veículo para atualizar';
  return '✏️ Atualizar preço';
}
function atualizarBotoesGeofence() {
  document.querySelectorAll('[data-btn-posto]').forEach((b) => {
    const posto = S.postos.find((p) => p.id === b.dataset.btnPosto);
    if (!posto) return;
    b.disabled = !podeAtualizar(posto);
    b.textContent = textoBotao(posto);
  });
}

// ---------- 6. APIs EXTERNAS ----------
async function geocodificar(q) {
  const url = `${CONFIG.NOMINATIM}?format=json&limit=1&countrycodes=br&q=${encodeURIComponent(q)}`;
  const r = await fetch(url, { headers: { 'Accept-Language': 'pt-BR' } });
  const j = await r.json();
  if (!j.length) throw new Error(`Local não encontrado: ${q}`);
  return { lat: +j[0].lat, lng: +j[0].lon };
}

async function obterRota(o, d) {
  const url = `${CONFIG.OSRM}/${o.lng},${o.lat};${d.lng},${d.lat}?overview=full&geometries=geojson`;
  const r = await fetch(url); const j = await r.json();
  if (j.code !== 'Ok') throw new Error('Não consegui traçar a rota');
  return j.routes[0].geometry.coordinates;         // [[lng,lat],...]
}

// Lê postos amenity=fuel do OSM e envia ao Supabase (insert-only).
// `aroundArg` = "raio,lat,lng,lat,lng..." (polilinha na rota) ou "raio,lat,lng" (ponto)
async function semearPostosOSM(aroundArg) {
  if (!CONFIG.SEMEAR_PELO_CLIENTE || !navigator.onLine) return;
  const q = `[out:json][timeout:25];nwr["amenity"="fuel"](around:${aroundArg});out center tags;`;
  const r = await fetch(`${CONFIG.OVERPASS}?data=${encodeURIComponent(q)}`);
  if (!r.ok) throw new Error('Overpass indisponível');
  const j = await r.json();
  const lista = j.elements.map((e) => ({
    osm_ref: `${e.type}/${e.id}`,
    nome: e.tags?.name || e.tags?.brand || '',
    marca: e.tags?.brand || '',
    lat: e.lat ?? e.center?.lat, lng: e.lon ?? e.center?.lon,
  })).filter((p) => p.lat != null && p.lng != null);
  for (let i = 0; i < lista.length; i += 400) {                  // lotes de até 400
    await sb.rpc('upsert_postos_osm', { p_postos: lista.slice(i, i + 400) });
  }
}

// ---------- 7. SUPABASE ----------
async function garantirSessao() {
  const { data } = await sb.auth.getSession();
  if (!data.session) {
    const { error } = await sb.auth.signInAnonymously();   // zero fricção p/ motorista
    if (error) toast('Falha ao iniciar sessão: ' + error.message);
  }
}

async function tracarRota() {
  const btn = $('btnRota'); btn.disabled = true; btn.textContent = 'Buscando…';
  try {
    const txtO = $('origem').value.trim(), txtD = $('destino').value.trim();
    if (!txtD) throw new Error('Informe o destino');
    const origem = txtO ? await geocodificar(txtO) : S.userPos;
    if (!origem) throw new Error('Sem GPS: informe a origem');
    const destino = await geocodificar(txtD);

    const completa = await obterRota(origem, destino);
    const coords = decimar(completa, 300);
    S.rota = { type: 'LineString', coordinates: coords };

    if (S.camadaRota) S.camadaRota.remove();
    S.camadaRota = L.polyline(completa.map(([lng, lat]) => [lat, lng]), { color: '#10B981', weight: 5 }).addTo(S.map);
    S.map.fitBounds(S.camadaRota.getBounds(), { padding: [20, 20] });

    // Semeia postos do OSM só no corredor da rota (pontos a cada ~3 km, máx. 120)
    let pts = decimar(coords, 3000); const passo = Math.ceil(pts.length / 120);
    pts = pts.filter((_, i) => i % passo === 0);
    try { await semearPostosOSM(`600,${pts.map(([lng, lat]) => `${lat.toFixed(5)},${lng.toFixed(5)}`).join(',')}`); }
    catch (e) { console.warn('Semeadura OSM falhou (segue com a base atual):', e); }

    trocarAba('rota', false);
    await buscarNaRota();
  } catch (e) { toast(e.message); }
  finally { btn.disabled = false; btn.textContent = 'Buscar postos na rota'; }
}

async function buscarNaRota() {
  if (!S.rota) return renderLista();
  const { data, error } = await sb.rpc('buscar_postos_na_rota', {
    p_rota: S.rota, p_tipo: S.combustivel, p_buffer_m: CONFIG.BUFFER_ROTA_M, p_limite: 40,
  });
  return aplicarResultado('rota', data, error);
}

async function buscarProximos() {
  if (!S.userPos) return renderLista();
  try { await semearPostosOSM(`6000,${S.userPos.lat.toFixed(5)},${S.userPos.lng.toFixed(5)}`); } catch { /* offline ok */ }
  const { data, error } = await sb.rpc('buscar_postos_proximos', {
    p_lat: S.userPos.lat, p_lng: S.userPos.lng, p_tipo: S.combustivel, p_raio_m: 6000, p_limite: 40,
  });
  return aplicarResultado('proximos', data, error);
}

// Sucesso => guarda no localStorage. Erro/offline => mostra o último resultado salvo.
function aplicarResultado(aba, data, error) {
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

function trocarAba(aba, buscar = true) {
  S.aba = aba;
  document.querySelectorAll('nav.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.aba === aba)));
  if (buscar) (aba === 'rota' ? buscarNaRota : buscarProximos)();
}

// ---------- 8. RENDER ----------
function renderLista() {
  const box = $('lista'); S.camadaPostos.clearLayers();
  if (!S.postos.length) {
    box.innerHTML = `<div class="vazio-msg">${S.aba === 'rota'
      ? 'Busque uma rota para ver os postos no trajeto.' : 'Nenhum posto por perto ainda.'}</div>`;
    return;
  }
  box.innerHTML = S.postos.map((p) => {
    const temPreco = p.preco != null;
    const info = S.aba === 'rota'
      ? `km ${p.km_na_rota} da rota · desvio ${p.desvio_m} m`
      : `${p.desvio_m >= 1000 ? (p.desvio_m / 1000).toFixed(1) + ' km' : p.desvio_m + ' m'} de você`;
    return `
      <article class="posto">
        <div class="linha">
          <div><h3>${esc(p.nome)}</h3><div class="meta">${esc(p.marca || '')} ${esc(p.marca ? '· ' : '')}${info}</div></div>
          <span class="selo ${p.nivel_confianca}">${SELOS[p.nivel_confianca]}</span>
        </div>
        <div class="linha">
          <div class="preco ${temPreco ? '' : 'vazio'}">${temPreco ? 'R$ ' + brl(p.preco) : 'Sem preço — seja o primeiro!'}</div>
          <div class="meta">${esc(COMBUSTIVEIS[S.combustivel])}</div>
        </div>
        <button class="btn" data-btn-posto="${esc(p.id)}"></button>
      </article>`;
  }).join('');

  box.querySelectorAll('[data-btn-posto]').forEach((b) =>
    b.addEventListener('click', () => abrirModal(S.postos.find((p) => p.id === b.dataset.btnPosto))));
  atualizarBotoesGeofence();

  S.postos.forEach((p) => {
    L.marker([p.lat, p.lng], { icon: pinIcon(p.nivel_confianca, p.preco != null ? brl(p.preco).slice(0, 4) : '?') })
      .addTo(S.camadaPostos).bindPopup(`<b>${esc(p.nome)}</b><br>${p.preco != null ? 'R$ ' + brl(p.preco) : 'Sem preço'}`);
  });
}

function renderChips() {
  $('chipsCombustivel').innerHTML = Object.entries(COMBUSTIVEIS).map(([k, v]) =>
    `<button class="chip" data-comb="${k}" aria-pressed="${k === S.combustivel}">${v}</button>`).join('');
  $('chipsCombustivel').addEventListener('click', (e) => {
    const b = e.target.closest('[data-comb]'); if (!b) return;
    S.combustivel = b.dataset.comb;
    document.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c === b)));
    (S.aba === 'rota' ? buscarNaRota : buscarProximos)();
  });
}

// ---------- 9. MODAL DE PREÇO ----------
function abrirModal(posto) {
  if (!podeAtualizar(posto)) return toast(textoBotao(posto));
  S.postoAtivo = posto;
  $('mpNome').textContent = posto.nome;
  $('mpInfo').textContent = `Você está a ${Math.round(distAtePosto(posto))} m do posto ✔`;
  $('mpTipo').innerHTML = Object.entries(COMBUSTIVEIS).map(([k, v]) =>
    `<option value="${k}" ${k === S.combustivel ? 'selected' : ''}>${v}</option>`).join('');
  $('precoInput').value = '';
  $('mpErro').textContent = '';

  // Confirmação com 1 toque: se já existe preço, mostra "✅ Confirmar R$ X" (conta como confirmação)
  const bc = $('mpConfirmar');
  if (posto.preco != null) {
    bc.hidden = false; bc.textContent = `✅ Confirmar R$ ${brl(posto.preco)}`;
    bc.dataset.preco = String(posto.preco);
  } else { bc.hidden = true; delete bc.dataset.preco; }

  $('modalPreco').showModal();
  if (posto.preco == null) $('precoInput').focus();     // sem preço: já abre digitando
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
function traduzErro(msg = '') {
  const k = Object.keys(ERROS).find((c) => msg.includes(c));
  return k ? ERROS[k] : 'Não foi possível enviar. Tente novamente.';
}

// Envio comum (digitado OU confirmação com 1 toque). O servidor revalida tudo.
async function enviarPrecoValor(preco) {
  const posto = S.postoAtivo; if (!posto) return;
  if (!podeAtualizar(posto)) { $('mpErro').textContent = textoBotao(posto); return; }   // recheca no envio

  const btns = [$('mpEnviar'), $('mpConfirmar')]; btns.forEach((b) => (b.disabled = true));
  const { data, error } = await sb.rpc('enviar_preco', {
    p_posto_id: posto.id, p_tipo: $('mpTipo').value, p_preco: preco,
    p_lat: S.userPos.lat, p_lng: S.userPos.lng, p_precisao_m: S.userPos.acc,
    p_velocidade_ms: S.userPos.speed,
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
  // Só vale para o combustível que está no card; se o motorista trocou o select, usa o digitado
  const preco = parseFloat($('mpConfirmar').dataset.preco);
  if ($('mpTipo').value !== S.combustivel) { $('mpErro').textContent = 'Digite o preço do combustível escolhido.'; return; }
  enviarPrecoValor(preco);
}

// ---------- 10. INIT ----------
async function init() {
  initMap(); renderChips(); renderLista();
  await garantirSessao();
  iniciarGPS();

  $('btnRota').addEventListener('click', tracarRota);
  $('destino').addEventListener('keydown', (e) => e.key === 'Enter' && tracarRota());
  document.querySelectorAll('nav.tabs button').forEach((b) => b.addEventListener('click', () => trocarAba(b.dataset.aba)));
  $('formPreco').addEventListener('submit', enviarDigitado);
  $('mpConfirmar').addEventListener('click', enviarConfirmacao);
  $('mpCancelar').addEventListener('click', () => $('modalPreco').close());

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(console.warn);
}
init();
