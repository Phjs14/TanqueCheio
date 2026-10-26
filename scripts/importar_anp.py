#!/usr/bin/env python3
"""
TanqueCheio — importar_anp.py
Lê o CSV do levantamento semanal de preços da ANP e grava, no Supabase, a MEDIANA de preço
por (UF, município, combustível) na tabela `referencia_anp`. Essa referência alimenta o filtro de
outlier (±25%) da RPC `enviar_preco` enquanto a região ainda tem poucos preços de motoristas.
Opcionalmente carrega os centroides dos municípios (tabela `municipios_ref`), que a RPC usa para
descobrir de qual município um posto está mais perto.

Só usa a biblioteca padrão do Python 3.8+ (sem pip install).

Uso:
  export SUPABASE_URL="https://SEU-PROJETO.supabase.co"
  export SUPABASE_SERVICE_KEY="..."            # service_role: NUNCA coloque no front-end nem no git
  python3 scripts/importar_anp.py levantamento_anp.csv --centroides municipios.csv --dry-run
  python3 scripts/importar_anp.py levantamento_anp.csv --centroides municipios.csv

Arquivo da ANP: CSV do "Levantamento de Preços de Combustíveis" (dados abertos, gov.br).
  Colunas esperadas (nomes tolerantes a acento/caixa): Estado - Sigla, Municipio, Produto,
  Data da Coleta, Valor de Venda.
Arquivo de centroides: CSV com nome do município, UF (sigla ou codigo_uf do IBGE), latitude e longitude.
Rode primeiro com --dry-run para conferir a leitura das colunas.
"""
import argparse, csv, io, json, os, re, statistics, sys, unicodedata
import urllib.request, urllib.error
from collections import defaultdict
from datetime import datetime, timedelta

CODIGO_UF = {
    "11":"RO","12":"AC","13":"AM","14":"RR","15":"PA","16":"AP","17":"TO","21":"MA","22":"PI","23":"CE",
    "24":"RN","25":"PB","26":"PE","27":"AL","28":"SE","29":"BA","31":"MG","32":"ES","33":"RJ","35":"SP",
    "41":"PR","42":"SC","43":"RS","50":"MS","51":"MT","52":"GO","53":"DF",
}

def norm(s):
    """MAIÚSCULO, sem acento, só letras/números/espaço."""
    s = unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode()
    s = re.sub(r"[^A-Za-z0-9 ]+", " ", s).upper()
    return re.sub(r"\s+", " ", s).strip()

def ler_csv(caminho):
    """Detecta encoding e separador. Devolve (cabeçalho_normalizado, linhas_como_listas)."""
    bruto = open(caminho, "rb").read()
    for enc in ("utf-8-sig", "latin-1"):
        try:
            texto = bruto.decode(enc); break
        except UnicodeDecodeError:
            continue
    primeira = texto.splitlines()[0]
    sep = max([";", ",", "\t"], key=primeira.count)
    linhas = list(csv.reader(io.StringIO(texto), delimiter=sep))
    return [norm(h) for h in linhas[0]], linhas[1:]

def achar(cab, *candidatos, exato=False):
    """Índice da primeira coluna cujo nome contém (ou é igual a) algum candidato."""
    for c in candidatos:
        for i, h in enumerate(cab):
            if (h == c) if exato else (c in h):
                return i
    return None

def tipo_produto(produto):
    p = norm(produto).replace(" ", "")
    if p.startswith("GASOLINA"):
        return "gasolina_aditivada" if "ADITIVADA" in p else "gasolina_comum"
    if p.startswith("ETANOL"): return "etanol"
    if p.startswith("DIESEL"):
        return "diesel_s10" if "S10" in p else "diesel_s500"
    if p == "GNV": return "gnv"
    return None      # GLP etc. não interessam

def parse_data(s):
    s = str(s).strip()[:10]
    for fmt in ("%d/%m/%Y", "%Y-%m-%d"):
        try: return datetime.strptime(s, fmt).date()
        except ValueError: pass
    return None

def parse_preco(s):
    try: return float(str(s).strip().replace(",", "."))
    except ValueError: return None

def enviar(tabela, linhas, conflito, url, chave, dry):
    if dry:
        print(f"[dry-run] {tabela}: {len(linhas)} linhas (amostra: {json.dumps(linhas[:2], ensure_ascii=False)})")
        return
    for i in range(0, len(linhas), 500):
        req = urllib.request.Request(
            f"{url}/rest/v1/{tabela}?on_conflict={conflito}",
            data=json.dumps(linhas[i:i+500]).encode(),
            method="POST",
            headers={
                "apikey": chave, "Authorization": f"Bearer {chave}",
                "Content-Type": "application/json",
                "Prefer": "resolution=merge-duplicates,return=minimal",
            })
        try:
            urllib.request.urlopen(req, timeout=60).read()
        except urllib.error.HTTPError as e:
            sys.exit(f"Erro {e.code} em {tabela}: {e.read().decode()[:400]}")
    print(f"{tabela}: {len(linhas)} linhas enviadas")

def importar_centroides(caminho, url, chave, dry):
    cab, linhas = ler_csv(caminho)
    i_nome = achar(cab, "NOME", "MUNICIPIO")
    i_uf = achar(cab, "UF", exato=True)
    i_cuf = achar(cab, "CODIGO UF", "COD UF")
    i_lat = achar(cab, "LATITUDE", "LAT")
    i_lng = achar(cab, "LONGITUDE", "LONG", "LNG", "LON")
    if None in (i_nome, i_lat, i_lng) or (i_uf is None and i_cuf is None):
        sys.exit(f"Centroides: não achei as colunas (cabeçalho lido: {cab})")
    out = {}
    for l in linhas:
        try:
            uf = l[i_uf].strip().upper() if i_uf is not None else CODIGO_UF.get(l[i_cuf].strip())
            lat, lng = float(l[i_lat].replace(",", ".")), float(l[i_lng].replace(",", "."))
        except (ValueError, IndexError, AttributeError):
            continue
        if not uf or not (-34 <= lat <= 6 and -74 <= lng <= -34): continue
        out[(uf, norm(l[i_nome]))] = {
            "uf": uf, "nome": l[i_nome].strip(), "municipio_norm": norm(l[i_nome]),
            "geom": f"SRID=4326;POINT({lng} {lat})",
        }
    enviar("municipios_ref", list(out.values()), "uf,municipio_norm", url, chave, dry)

def importar_anp(caminho, dias, url, chave, dry):
    cab, linhas = ler_csv(caminho)
    i_uf = achar(cab, "ESTADO", "UF", exato=False)
    i_mun = achar(cab, "MUNICIPIO")
    i_prod = achar(cab, "PRODUTO")
    i_val = achar(cab, "VALOR DE VENDA", "VALOR VENDA")
    i_dat = achar(cab, "DATA DA COLETA", "DATA COLETA")
    if None in (i_uf, i_mun, i_prod, i_val, i_dat):
        sys.exit(f"ANP: não achei as colunas (cabeçalho lido: {cab})")

    registros, max_data = [], None
    for l in linhas:
        try:
            uf = l[i_uf].strip().upper()
            tipo = tipo_produto(l[i_prod]); preco = parse_preco(l[i_val]); data = parse_data(l[i_dat])
            mun = norm(l[i_mun])
        except IndexError:
            continue
        if not (uf and mun and tipo and data and preco and 1 <= preco <= 30): continue
        registros.append((uf, mun, tipo, preco, data))
        max_data = max(max_data, data) if max_data else data
    if not registros: sys.exit("Nenhum registro válido encontrado.")

    corte = max_data - timedelta(days=dias)
    municipio, estado = defaultdict(list), defaultdict(list)
    for uf, mun, tipo, preco, data in registros:
        if data < corte: continue                 # só a(s) semana(s) mais recente(s)
        municipio[(uf, mun, tipo)].append(preco)
        estado[(uf, "*", tipo)].append(preco)     # "*" = mediana da UF inteira (fallback)

    saida = []
    for grupo in (municipio, estado):
        for (uf, mun, tipo), valores in grupo.items():
            saida.append({
                "uf": uf, "municipio_norm": mun, "tipo": tipo,
                "mediana": round(statistics.median(valores), 3),
                "amostras": len(valores), "semana": max_data.isoformat(),
            })
    print(f"Coleta mais recente: {max_data} · janela: {dias} dias · {len(registros)} registros lidos")
    enviar("referencia_anp", saida, "uf,municipio_norm,tipo", url, chave, dry)

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("anp_csv")
    ap.add_argument("--centroides", help="CSV com municípios + latitude/longitude")
    ap.add_argument("--dias", type=int, default=14, help="janela (dias) antes da última coleta (padrão 14)")
    ap.add_argument("--dry-run", action="store_true", help="só lê e mostra, não envia")
    a = ap.parse_args()

    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    chave = os.environ.get("SUPABASE_SERVICE_KEY", "")
    if not a.dry_run and not (url and chave):
        sys.exit("Defina SUPABASE_URL e SUPABASE_SERVICE_KEY (ou use --dry-run).")

    if a.centroides: importar_centroides(a.centroides, url, chave, a.dry_run)
    importar_anp(a.anp_csv, a.dias, url, chave, a.dry_run)

if __name__ == "__main__":
    main()
