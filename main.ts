import { App } from "fresh";

export const app = new App();

const EDI_BASE = "https://edi.api.pagbank.com.br/movement/v3.00";
const PARCEL_MONTHLY_RATE = 1.55;

function json(data: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}
function html(body: string, status = 200, headers: HeadersInit = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
}
function round2(value: number) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}
function pick(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = row?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return null;
}
function n(value: unknown, fallback = 0) {
  const parsed = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : fallback;
}
function paymentMethod(row: Record<string, unknown>) {
  const code = String(pick(row, ["meio_pagamento"]) || "");
  const arr = String(pick(row, ["arranjo_ur", "arranjo_pagamento"]) || "").toUpperCase();
  if (code === "11" || arr === "PIX") return "PIX";
  if (code === "8" || code === "15" || arr.startsWith("DEBIT_")) return "DEBIT";
  if (code === "3" || code === "14" || arr.startsWith("CREDIT_")) return "CREDIT";
  return "OTHER";
}
function resolveBrand(row: Record<string, unknown>, method: string) {
  if (method === "PIX") return { brand: "PIX", source: "EDI" };
  const provider = String(pick(row, ["bandeira", "instituicao_financeira", "brand"]) || "").trim().toUpperCase();
  const arrangement = String(pick(row, ["arranjo_ur", "arranjo_pagamento"]) || "").trim().toUpperCase();
  const text = (provider + " " + arrangement).replace(/[_-]+/g, " ");

  if (text.includes("VISA")) return { brand: "VISA", source: "EDI" };
  if (text.includes("MASTER")) return { brand: "MASTERCARD", source: "EDI" };
  if (text.includes("ELO")) return { brand: "ELO", source: "EDI" };
  if (text.includes("DINERS")) return { brand: "DINERS", source: "EDI" };
  if (text.includes("HIPER")) return { brand: "HIPERCARD", source: "EDI" };
  if (text.includes("AMEX") || text.includes("AMERICAN EXPRESS")) return { brand: "AMEX", source: "EDI" };

  const bin = String(pick(row, ["cartao_bin", "bin", "first_digits"]) || "").replace(/\D/g, "").slice(0, 8);
  if (/^4/.test(bin)) return { brand: "VISA", source: "BIN" };
  const p2 = Number(bin.slice(0, 2));
  const p4 = Number(bin.slice(0, 4));
  if ((p2 >= 51 && p2 <= 55) || (p4 >= 2221 && p4 <= 2720)) return { brand: "MASTERCARD", source: "BIN" };
  if (p2 === 34 || p2 === 37) return { brand: "AMEX", source: "BIN" };
  return { brand: null, source: bin ? "BIN_NAO_RESOLVIDO" : "NAO_RESOLVIDO" };
}
function baseRate(brand: string | null, method: string, installments: number) {
  const p = Math.max(1, installments || 1);
  if (method === "PIX") return 0.10;
  if (method === "DEBIT") {
    if (brand && ["VISA", "MASTERCARD", "ELO"].includes(brand)) return 1.04;
    if (brand) return 2.39;
    return null;
  }
  if (method !== "CREDIT" || !brand) return null;

  if (p === 1) {
    if (brand === "VISA" || brand === "MASTERCARD") return 3.11;
    if (brand === "ELO") return 3.39;
    if (brand === "DINERS") return 3.19;
    if (brand === "HIPERCARD") return 3.71;
    return 3.71;
  }
  if (p >= 2 && p <= 6) {
    if (["VISA", "MASTERCARD", "ELO"].includes(brand)) return 2.55;
    if (brand === "DINERS") return 3.79;
    if (brand === "HIPERCARD") return 3.00;
    return 3.00;
  }
  if (p >= 7 && p <= 18) {
    if (brand === "DINERS") return 3.79;
    return 5.59;
  }
  return null;
}
function normalize(row: Record<string, unknown>, day: string) {
  const txType = String(pick(row, ["tipo_transacao"]) || "");
  const eventType = String(pick(row, ["tipo_evento"]) || "");
  const status = String(pick(row, ["status_pagamento"]) || "");
  const gross = n(pick(row, ["valor_original_transacao", "valor_total_transacao"]), 0);

  if (txType && txType !== "1") return null;
  if (eventType && eventType !== "1") return null;
  if (status && !["1", "3"].includes(status)) return null;
  if (!(gross > 0)) return null;

  const method = paymentMethod(row);
  if (!["CREDIT", "DEBIT", "PIX"].includes(method)) return null;

  const installments = Math.max(
    1,
    Math.round(n(pick(row, ["quantidade_parcelas", "numero_parcelas", "qtd_parcelas", "parcelas", "installments"]), 1)),
  );
  const resolved = resolveBrand(row, method);
  const rate = baseRate(resolved.brand, method, installments);
  const parcelled = method === "CREDIT" && installments > 1;
  const net = n(pick(row, ["valor_liquido_transacao"]), gross);
  const providerFee = round2(Math.max(0, gross - net));
  const expectedBaseFee = rate === null ? null : round2(gross * rate / 100);

  // O print do contrato informa "acréscimo de 1,55%/mês" para vendas parceladas.
  // Não inventamos a fórmula matemática desse acréscimo. Enquanto não calibrado
  // com transação real do EDI, a linha parcelada não compõe "valor a recuperar".
  const calculationReady = !parcelled && expectedBaseFee !== null;
  const expectedNet = calculationReady ? round2(gross - (expectedBaseFee || 0)) : null;
  const difference = calculationReady ? round2(providerFee - (expectedBaseFee || 0)) : null;

  const date = String(pick(row, ["data_inicial_transacao", "data_venda_ajuste", "data_movimentacao", "data"]) || day);
  const time = String(pick(row, ["hora_inicial_transacao", "hora_venda_ajuste", "hora_movimentacao"]) || "00:00:00");

  return {
    transaction_id: String(pick(row, ["codigo_transacao", "movimento_api_codigo", "codigo_venda"]) || crypto.randomUUID()).trim().toUpperCase(),
    occurred_at: date + "T" + time,
    serial_number: String(pick(row, ["numero_serie_leitor", "serial_number", "numero_serial", "terminal_id"]) || "").trim().toUpperCase() || null,
    payment_method: method,
    installments,
    provider_brand: String(pick(row, ["instituicao_financeira", "bandeira", "brand"]) || "").trim().toUpperCase() || null,
    brand: resolved.brand,
    brand_source: resolved.source,
    card_bin: String(pick(row, ["cartao_bin", "bin", "first_digits"]) || "").replace(/\D/g, "").slice(0, 8) || null,
    last4: String(pick(row, ["ultimos_digitos_cartao", "last_digits"]) || "").replace(/\D/g, "").slice(-4) || null,
    gross_amount: round2(gross),
    net_amount: round2(net),
    provider_fee_amount: providerFee,
    contract_base_rate: rate,
    parcel_monthly_rate: parcelled ? PARCEL_MONTHLY_RATE : 0,
    expected_base_fee_amount: expectedBaseFee,
    expected_net_amount: expectedNet,
    difference_amount: difference,
    calculation_status: rate === null ? "TAXA_NAO_RESOLVIDA" : (parcelled ? "PARCELAMENTO_AGUARDA_CALIBRACAO" : "OK"),
    edi_day: day,
  };
}

async function ediPage(user: string, token: string, day: string, page: number, pageSize = 1000) {
  const auth = btoa(user + ":" + token);
  const url = `${EDI_BASE}/transactional/${day}?pageNumber=${page}&pageSize=${pageSize}`;
  const response = await fetch(url, { headers: { Authorization: "Basic " + auth, Accept: "application/json" } });

  if (response.status === 401 || response.status === 403) throw new Error("Credencial EDI recusada pelo PagBank.");
  if (response.status === 404) return { available: false, validated: null, totalPages: 0, details: [] as Record<string, unknown>[] };
  if (!response.ok) throw new Error("PagBank EDI HTTP " + response.status);

  const validHeader = response.headers.get("VALIDADO") ?? response.headers.get("validado");
  const validated = validHeader === null ? null : String(validHeader).toUpperCase() === "TRUE";
  const payload = await response.json();

  return {
    available: true,
    validated,
    totalPages: Math.max(1, Number(payload?.pagination?.totalPages || payload?.pagination?.total_pages || 1)),
    details: Array.isArray(payload?.detalhes) ? payload.detalhes : (Array.isArray(payload?.details) ? payload.details : []),
  };
}
async function ediDay(user: string, token: string, day: string) {
  const first = await ediPage(user, token, day, 1);
  if (!first.available) return { day, available: false, validated: null, rows: [], received: 0 };
  if (first.validated === false) return { day, available: true, validated: false, rows: [], received: first.details.length };

  const pages = [first];
  for (let p = 2; p <= first.totalPages; p++) pages.push(await ediPage(user, token, day, p));
  const raw = pages.flatMap((p) => p.details);
  const rows = raw.map((row) => normalize(row, day)).filter(Boolean) as any[];

  const seen = new Set<string>();
  const unique = rows.filter((row) => {
    if (seen.has(row.transaction_id)) return false;
    seen.add(row.transaction_id);
    return true;
  });

  return { day, available: true, validated: true, rows: unique, received: raw.length };
}
function daysBetween(from: string, to: string) {
  const start = new Date(from + "T12:00:00-03:00");
  const end = new Date(to + "T12:00:00-03:00");
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end < start) return [];
  const out: string[] = [];
  for (let t = start.getTime(); t <= end.getTime() && out.length < 8; t += 86400000) {
    out.push(new Date(t).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }));
  }
  return out;
}
function summarize(rows: any[]) {
  const s = {
    total_rows: rows.length,
    gross: 0,
    pagbank_net: 0,
    pagbank_fee: 0,
    expected_base_fee: 0,
    expected_net: 0,
    to_recover: 0,
    divergent_count: 0,
    unresolved_count: 0,
    parcel_pending_count: 0,
  };
  for (const row of rows) {
    s.gross += Number(row.gross_amount || 0);
    s.pagbank_net += Number(row.net_amount || 0);
    s.pagbank_fee += Number(row.provider_fee_amount || 0);

    if (row.calculation_status === "TAXA_NAO_RESOLVIDA") {
      s.unresolved_count++;
      continue;
    }
    if (row.calculation_status === "PARCELAMENTO_AGUARDA_CALIBRACAO") {
      s.parcel_pending_count++;
      continue;
    }

    s.expected_base_fee += Number(row.expected_base_fee_amount || 0);
    s.expected_net += Number(row.expected_net_amount || 0);
    const diff = Number(row.difference_amount || 0);
    if (diff > 0) s.to_recover += diff;
    if (Math.abs(diff) >= 0.01) s.divergent_count++;
  }
  for (const key of ["gross", "pagbank_net", "pagbank_fee", "expected_base_fee", "expected_net", "to_recover"] as const) {
    s[key] = round2(s[key]);
  }
  return s;
}

async function sign(value: string) {
  const secret = Deno.env.get("AUTH_SECRET") || Deno.env.get("APP_PASSWORD") || "spotpass-concilia";
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(signature)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function hasSession(req: Request) {
  const cookie = req.headers.get("cookie") || "";
  const match = cookie.match(/sp_concilia_session=([^;]+)/);
  if (!match) return false;
  const [stamp, signature] = decodeURIComponent(match[1]).split(".");
  if (!stamp || !signature) return false;
  if (Date.now() - Number(stamp) > 12 * 60 * 60 * 1000) return false;
  return signature === await sign(stamp);
}

const PAGE = String.raw`<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SpotPass Concilia</title>
<style>
:root{--o:#F15613;--bg:#f6f7f9;--card:#fff;--line:#e4e7eb;--text:#181a1e;--muted:#69717d;--green:#18794e;--red:#b93b4d;--yellow:#886300}
*{box-sizing:border-box}
html,body{width:100%;height:100%;overflow:hidden}
body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,system-ui,-apple-system,Segoe UI,sans-serif;font-size:13px}
.app{height:100vh;display:grid;grid-template-columns:220px minmax(0,1fr);overflow:hidden}
.side{background:#fff;border-right:1px solid var(--line);padding:16px 12px;position:fixed;inset:0 auto 0 0;width:220px;height:100vh;overflow:hidden}
.brand{display:flex;gap:10px;align-items:center;margin-bottom:18px}
.mark{width:38px;height:38px;border-radius:10px;overflow:hidden;flex:0 0 auto}.mark svg{width:100%;height:100%}.brand b{display:block}.brand small,.muted{color:var(--muted)}
nav button{display:block;width:100%;border:0;background:transparent;text-align:left;padding:9px 10px;border-radius:8px;margin:3px 0;color:#5e6672;font-weight:650;cursor:pointer}
nav button.active{background:#fff1ea;color:#b94310}
.main{grid-column:2;height:100vh;min-width:0;overflow:hidden;padding:0 18px 10px}
.top{height:66px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;background:rgba(246,247,249,.96);backdrop-filter:blur(8px);z-index:5}
.top h1{margin:2px 0 0;font-size:22px;line-height:1.1}.ey{font-size:9px;letter-spacing:.11em;font-weight:800;color:#a94a20}
.status{font-size:9px;font-weight:800;padding:5px 8px;border-radius:99px;border:1px solid #d5eadc;background:#eef9f2;color:#147044;white-space:nowrap}
.page{display:none;height:calc(100vh - 66px);min-height:0;overflow:hidden;padding-top:10px}
.page.active{display:flex;flex-direction:column}
.filters{display:flex;gap:7px;align-items:center;flex-wrap:nowrap;margin:0 0 8px;flex:0 0 auto;min-height:32px}
.input,.btn{height:32px;border:1px solid var(--line);border-radius:8px;background:#fff;padding:0 9px;font-size:11px}.input{min-width:0}.btn{cursor:pointer;font-weight:750;white-space:nowrap}.btn.primary{background:var(--o);border-color:var(--o);color:#fff}
.grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;flex:0 0 auto}
.card,.panel{background:#fff;border:1px solid var(--line);border-radius:12px;box-shadow:0 4px 14px rgba(17,24,39,.025)}
.card{padding:10px 11px;min-width:0}.card span{font-size:8px;color:var(--muted);text-transform:uppercase;font-weight:800;letter-spacing:.03em}.card strong{display:block;font-size:17px;line-height:1.15;margin:5px 0 2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.card.hot strong{color:#b94310}
.panel{padding:10px;margin-top:8px;min-height:0;overflow:hidden;display:flex;flex-direction:column;flex:1}
.panel h3{font-size:13px;margin:3px 0 7px!important;flex:0 0 auto}
.tw{overflow:hidden;min-height:0;flex:1}
table{width:100%;height:auto;border-collapse:collapse;table-layout:fixed;min-width:0}
th,td{padding:5px 6px;border-bottom:1px solid #eef0f2;font-size:9.5px;line-height:1.15;white-space:nowrap;text-align:left;overflow:hidden;text-overflow:ellipsis}
th{font-size:8px;text-transform:uppercase;letter-spacing:.045em;background:#fafafa;color:#78808b;height:25px}
tbody tr{height:29px;cursor:pointer}tbody tr:hover{background:#fffaf7}
.pill{display:inline-flex;max-width:100%;padding:3px 5px;border-radius:99px;font-size:8px;font-weight:800;overflow:hidden;text-overflow:ellipsis}
.ok{background:#ebf8f0;color:#147344}.bad{background:#fff0f2;color:#ad3444}.warn{background:#fff7dc;color:#856000}
.login{position:fixed;inset:0;background:#f7f8fa;display:grid;place-items:center;z-index:30}.login.hide{display:none}.loginbox{width:min(410px,92vw);background:#fff;border:1px solid var(--line);border-radius:17px;padding:24px}.loginbox input{width:100%;height:42px;border:1px solid var(--line);border-radius:9px;padding:0 11px;margin:10px 0}
.note{background:#fffaf6;border:1px solid #f0d4c4;padding:7px 10px;border-radius:9px;margin:0 0 8px;color:#744228;font-size:10px;line-height:1.3;flex:0 0 auto}
.rates{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));grid-template-rows:repeat(3,minmax(0,1fr));gap:8px;min-height:0;flex:1}
.rate{padding:10px;border:1px solid var(--line);background:#fff;border-radius:10px;min-width:0;display:flex;flex-direction:column;justify-content:center}.rate strong{display:block;font-size:17px;margin:4px 0}
.small{font-size:10px}.danger{color:var(--red);font-weight:800}
.pager{height:34px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex:0 0 auto;padding-top:5px}.pager .btn{height:28px}.pagerInfo{font-size:9px;color:var(--muted)}
.audit-list{min-height:0;flex:1;overflow:hidden}.audit-item{height:46px;border-bottom:1px solid #eef0f2;display:grid;grid-template-columns:minmax(0,1.8fr) .7fr .7fr .7fr;gap:10px;align-items:center;padding:5px 2px;font-size:10px}.audit-item b,.audit-item span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.modal{position:fixed;inset:0;background:rgba(20,23,28,.25);display:grid;place-items:center;z-index:40;padding:18px}.modal.hide{display:none}.modal-card{width:min(760px,94vw);max-height:88vh;background:#fff;border:1px solid var(--line);border-radius:16px;box-shadow:0 20px 55px rgba(17,24,39,.18);padding:16px;overflow:hidden}.modal-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}.detail-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.detail{border:1px solid var(--line);border-radius:9px;padding:9px;min-width:0}.detail span{display:block;font-size:8px;color:var(--muted);text-transform:uppercase;font-weight:800;margin-bottom:4px}.detail b{font-size:11px;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#dash .panel{margin-bottom:0}
#conc .panel,#div .panel{margin-top:0}
#rates{padding-bottom:0}
@media(max-width:1100px){.app{grid-template-columns:190px minmax(0,1fr)}.side{width:190px}.grid{grid-template-columns:repeat(5,minmax(0,1fr))}.card strong{font-size:15px}.rates{grid-template-columns:repeat(3,minmax(0,1fr));grid-template-rows:repeat(4,minmax(0,1fr))}.main{padding-left:12px;padding-right:12px}th,td{font-size:8.5px;padding:4px}}
@media(max-width:760px){html,body{overflow:hidden}.app{display:block}.side{position:absolute;z-index:20;width:100%;height:58px;border-right:0;border-bottom:1px solid var(--line);padding:8px 10px;display:flex;align-items:center;gap:8px}.brand{margin:0}.mark{width:32px;height:32px}.side nav{display:flex;gap:3px;overflow:hidden}.side nav button{width:auto;margin:0;padding:7px 8px;font-size:9px}.main{grid-column:auto;height:100vh;padding:58px 8px 8px}.top{height:54px}.page{height:calc(100vh - 112px);padding-top:8px}.top h1{font-size:18px}.grid{grid-template-columns:repeat(2,minmax(0,1fr));grid-auto-rows:58px}.grid .card:nth-child(5){display:none}.rates{grid-template-columns:repeat(2,minmax(0,1fr));grid-template-rows:repeat(6,minmax(0,1fr))}.note{font-size:9px}.detail-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style></head><body>
<div id="login" class="login"><form id="loginForm" class="loginbox"><div class="brand"><div class="mark"><svg viewBox="0 0 449 449"><rect width="449" height="449" fill="#F15613"/><path fill="#fff" d="M127 80 L112 91 L99 107 L90 125 L84 151 L84 304 L88 319 L87 321 L93 339 L107 360 L126 376 L150 386 L166 389 L256 390 L282 386 L304 377 L319 366 L331 353 L341 335 L346 320 L349 299 L348 171 L340 164 L282 164 L275 168 L272 174 L272 293 L269 306 L260 317 L244 323 L189 323 L174 318 L165 308 L161 290 L162 157 L165 148 L176 137 L191 133 L232 133 L239 129 L242 119 L241 75 L238 70 L233 67 L170 67 L146 72 L131 78 L131 80 Z"/><path fill="#fff" d="M275 56 L272 64 L272 124 L278 132 L283 134 L350 134 L359 130 L362 125 L362 120 L356 104 L343 86 L328 72 L300 56 L290 53 L281 53 Z"/></svg></div><div><b>SpotPass Concilia</b><small>acesso da equipe</small></div></div><div class="muted small">Use a senha interna do conciliador.</div><input id="password" type="password" placeholder="Senha"><div id="loginErr" class="small" style="color:#b93b4d;min-height:20px"></div><button class="btn primary" style="width:100%;height:42px">Entrar</button></form></div>

<div class="app"><aside class="side"><div class="brand"><div class="mark"><svg viewBox="0 0 449 449"><rect width="449" height="449" fill="#F15613"/><path fill="#fff" d="M127 80 L112 91 L99 107 L90 125 L84 151 L84 304 L88 319 L87 321 L93 339 L107 360 L126 376 L150 386 L166 389 L256 390 L282 386 L304 377 L319 366 L331 353 L341 335 L346 320 L349 299 L348 171 L340 164 L282 164 L275 168 L272 174 L272 293 L269 306 L260 317 L244 323 L189 323 L174 318 L165 308 L161 290 L162 157 L165 148 L176 137 L191 133 L232 133 L239 129 L242 119 L241 75 L238 70 L233 67 L170 67 L146 72 L131 78 L131 80 Z"/><path fill="#fff" d="M275 56 L272 64 L272 124 L278 132 L283 134 L350 134 L359 130 L362 125 L362 120 L356 104 L343 86 L328 72 L300 56 L290 53 L281 53 Z"/></svg></div><div><b>SpotPass</b><small>Concilia</small></div></div><nav>
<button class="active" data-page="dash">Visão geral</button><button data-page="conc">Conciliação</button><button data-page="rates">Taxas contratadas</button><button data-page="div">Divergências</button>
</nav></aside>

<main class="main"><header class="top"><div><div class="ey">AUDITORIA DE ADQUIRÊNCIA</div><h1 id="title">Visão geral</h1></div><span id="status" class="status">ONLINE</span></header>

<section id="dash" class="page active"><div class="filters"><label class="muted small">De</label><input id="from" class="input" type="date"><label class="muted small">Até</label><input id="to" class="input" type="date"><button id="load" class="btn primary">Atualizar</button></div>
<div class="note"><b>Contrato:</b> não há taxa de antecipação. Para crédito parcelado, os prints informam <b>acréscimo de 1,55%/mês</b>. Enquanto a fórmula exata desse acréscimo não for calibrada com uma transação parcelada real do EDI, o sistema não inclui essas linhas no valor “a recuperar”.</div>
<div id="cards" class="grid"></div><div class="panel"><div class="ey">TRANSAÇÃO A TRANSAÇÃO</div><h3 style="margin:5px 0 12px">Maiores diferenças calculáveis</h3><div class="tw"><table><thead><tr><th>Data</th><th>Transação</th><th>Bandeira</th><th>Modalidade</th><th>Parcelas</th><th>Bruto</th><th>MDR base</th><th>Taxa PagBank</th><th>Diferença</th><th>Status</th></tr></thead><tbody id="topRows"></tbody></table></div></div></section>

<section id="conc" class="page"><div class="filters"><input id="search" class="input" style="width:260px" placeholder="Buscar transação ou bandeira"><span class="muted small">Clique em uma linha para ver todos os detalhes.</span></div><div class="panel"><div class="tw"><table><thead><tr><th style="width:9%">Data</th><th style="width:13%">Transação</th><th style="width:9%">Bandeira</th><th style="width:7%">Tipo</th><th style="width:6%">Parc.</th><th style="width:10%">Bruto</th><th style="width:8%">MDR</th><th style="width:10%">Taxa PagBank</th><th style="width:10%">Líquido</th><th style="width:9%">Diferença</th><th style="width:9%">Status</th></tr></thead><tbody id="allRows"></tbody></table></div><div class="pager"><span id="concPageInfo" class="pagerInfo"></span><div><button id="concPrev" class="btn">Anterior</button> <button id="concNext" class="btn">Próxima</button></div></div></div></section>

<section id="rates" class="page"><div class="note">Taxas transcritas dos prints PagBank enviados. O acréscimo de <b>1,55%/mês</b> aparece nos cartões de crédito parcelados e é tratado separadamente do MDR base.</div><div id="rateGrid" class="rates"></div></section>

<section id="div" class="page"><div class="panel"><div class="ey">FILA DE AUDITORIA</div><h3>Cobranças acima do contrato</h3><div id="divergences" class="audit-list"></div><div class="pager"><span id="divPageInfo" class="pagerInfo"></span><div><button id="divPrev" class="btn">Anterior</button> <button id="divNext" class="btn">Próxima</button></div></div></div></section>
</main></div>
<div id="detailModal" class="modal hide"><div class="modal-card"><div class="modal-head"><div><div class="ey">DETALHES DA TRANSAÇÃO</div><b id="detailTitle"></b></div><button id="detailClose" class="btn">Fechar</button></div><div id="detailGrid" class="detail-grid"></div></div></div>

<script>
const money=v=>v==null?'—':new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(Number(v||0));
const pct=v=>v==null?'—':Number(v).toFixed(2).replace('.',',')+'%';
const day=d=>{const x=new Date(d);return x.toISOString().slice(0,10)};
const today=new Date(),y=new Date(today.getTime()-86400000);document.querySelector('#from').value=day(y);document.querySelector('#to').value=day(y);
let data={rows:[],summary:{}},concPage=1,divPage=1;
const PAGE_SIZE=8,DIV_SIZE=8;
async function api(url,opt){const r=await fetch(url,{credentials:'include',...(opt||{})});if(r.status===401)document.querySelector('#login').classList.remove('hide');return r}
document.querySelector('#loginForm').onsubmit=async e=>{e.preventDefault();const r=await api('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:document.querySelector('#password').value})});const j=await r.json();if(!r.ok){document.querySelector('#loginErr').textContent=j.message||'Falha';return}document.querySelector('#login').classList.add('hide');load()};
function pill(row){if(row.calculation_status==='PARCELAMENTO_AGUARDA_CALIBRACAO')return '<span class="pill warn">Calibrar</span>';if(row.calculation_status==='TAXA_NAO_RESOLVIDA')return '<span class="pill warn">Pendente</span>';const d=Number(row.difference_amount||0);if(Math.abs(d)<.01)return '<span class="pill ok">Correto</span>';if(d>0)return '<span class="pill bad">A recuperar</span>';return '<span class="pill ok">Menor</span>'}
function topTr(row){const d=row.difference_amount;return '<tr data-tx="'+row.transaction_id+'"><td>'+String(row.occurred_at||'').replace('T',' ')+'</td><td>'+row.transaction_id+'</td><td>'+(row.brand||row.provider_brand||'—')+'</td><td>'+row.payment_method+'</td><td>'+row.installments+'x</td><td>'+money(row.gross_amount)+'</td><td>'+pct(row.contract_base_rate)+'</td><td>'+money(row.provider_fee_amount)+'</td><td class="'+(d>0?'danger':'')+'">'+money(d)+'</td><td>'+pill(row)+'</td></tr>'}
function compactTr(row){const d=row.difference_amount;return '<tr data-tx="'+row.transaction_id+'"><td>'+String(row.occurred_at||'').replace('T',' ')+'</td><td>'+row.transaction_id+'</td><td>'+(row.brand||row.provider_brand||'—')+'</td><td>'+row.payment_method+'</td><td>'+row.installments+'x</td><td>'+money(row.gross_amount)+'</td><td>'+pct(row.contract_base_rate)+'</td><td>'+money(row.provider_fee_amount)+'</td><td>'+money(row.net_amount)+'</td><td class="'+(d>0?'danger':'')+'">'+money(d)+'</td><td>'+pill(row)+'</td></tr>'}
function filteredRows(){const q=(document.querySelector('#search').value||'').toLowerCase();return data.rows.filter(r=>!q||(r.transaction_id+' '+(r.brand||r.provider_brand||'')+' '+r.payment_method).toLowerCase().includes(q))}
function renderConc(){const rows=filteredRows(),pages=Math.max(1,Math.ceil(rows.length/PAGE_SIZE));if(concPage>pages)concPage=pages;const start=(concPage-1)*PAGE_SIZE,slice=rows.slice(start,start+PAGE_SIZE);document.querySelector('#allRows').innerHTML=slice.map(compactTr).join('')||'<tr><td colspan="11" class="muted">Nenhuma transação.</td></tr>';document.querySelector('#concPageInfo').textContent='Página '+concPage+' de '+pages+' • '+rows.length+' transações';document.querySelector('#concPrev').disabled=concPage<=1;document.querySelector('#concNext').disabled=concPage>=pages}
function renderDiv(){const rows=data.rows.filter(r=>r.difference_amount!=null&&Number(r.difference_amount)>0).sort((a,b)=>Number(b.difference_amount)-Number(a.difference_amount));const pages=Math.max(1,Math.ceil(rows.length/DIV_SIZE));if(divPage>pages)divPage=pages;const start=(divPage-1)*DIV_SIZE;document.querySelector('#divergences').innerHTML=rows.slice(start,start+DIV_SIZE).map(r=>'<div class="audit-item" data-tx="'+r.transaction_id+'"><b>'+r.transaction_id+' · '+(r.brand||'—')+'</b><span>'+money(r.gross_amount)+'</span><span>'+pct(r.contract_base_rate)+'</span><span class="danger">'+money(r.difference_amount)+'</span></div>').join('')||'<div class="muted">Nenhuma cobrança acima do contrato nas linhas calibradas.</div>';document.querySelector('#divPageInfo').textContent='Página '+divPage+' de '+pages+' • '+rows.length+' divergências';document.querySelector('#divPrev').disabled=divPage<=1;document.querySelector('#divNext').disabled=divPage>=pages}
function render(){const s=data.summary||{};document.querySelector('#cards').innerHTML=[['Total transacionado',money(s.gross),(s.total_rows||0)+' transações'],['Líquido PagBank',money(s.pagbank_net),'informado no EDI'],['Taxa PagBank',money(s.pagbank_fee),'desconto efetivo'],['A recuperar',money(s.to_recover),'linhas calibradas','hot'],['Parceladas pendentes',String(s.parcel_pending_count||0),'calibrar 1,55%/mês']].map(x=>'<div class="card '+(x[3]||'')+'"><span>'+x[0]+'</span><strong>'+x[1]+'</strong><small class="muted">'+x[2]+'</small></div>').join('');const calc=data.rows.filter(r=>r.difference_amount!=null).sort((a,b)=>Math.abs(b.difference_amount)-Math.abs(a.difference_amount));document.querySelector('#topRows').innerHTML=calc.slice(0,6).map(topTr).join('')||'<tr><td colspan="10" class="muted">Sem diferenças calculáveis.</td></tr>';renderConc();renderDiv()}
function showDetail(id){const r=data.rows.find(x=>String(x.transaction_id)===String(id));if(!r)return;document.querySelector('#detailTitle').textContent=r.transaction_id;const items=[['Data',String(r.occurred_at||'').replace('T',' ')],['Bandeira',r.brand||r.provider_brand||'—'],['Fonte da bandeira',r.brand_source||'—'],['Modalidade',r.payment_method],['Parcelas',r.installments+'x'],['Bruto',money(r.gross_amount)],['MDR base',pct(r.contract_base_rate)],['Acréscimo parcelado',r.parcel_monthly_rate?'1,55%/mês':'—'],['Taxa base esperada',money(r.expected_base_fee_amount)],['Taxa PagBank',money(r.provider_fee_amount)],['Líquido esperado',money(r.expected_net_amount)],['Líquido PagBank',money(r.net_amount)],['Diferença',money(r.difference_amount)],['BIN/IIN',r.card_bin||'—'],['Final cartão',r.last4||'—'],['PDV',r.serial_number||'—']];document.querySelector('#detailGrid').innerHTML=items.map(x=>'<div class="detail"><span>'+x[0]+'</span><b title="'+String(x[1]).replaceAll('"','&quot;')+'">'+x[1]+'</b></div>').join('');document.querySelector('#detailModal').classList.remove('hide')}
async function load(){document.querySelector('#status').textContent='CARREGANDO EDI...';const f=document.querySelector('#from').value,t=document.querySelector('#to').value;const r=await api('/api/reconcile?from='+encodeURIComponent(f)+'&to='+encodeURIComponent(t));const j=await r.json().catch(()=>({}));if(!r.ok){document.querySelector('#status').textContent=j.message||'ERRO';return}data=j;concPage=1;divPage=1;render();document.querySelector('#status').textContent='EDI DIRETO • '+(j.summary?.total_rows||0)+' TRANSAÇÕES'}
document.querySelector('#load').onclick=load;
document.querySelector('#search').oninput=()=>{concPage=1;renderConc()};
document.querySelector('#concPrev').onclick=()=>{if(concPage>1){concPage--;renderConc()}};
document.querySelector('#concNext').onclick=()=>{concPage++;renderConc()};
document.querySelector('#divPrev').onclick=()=>{if(divPage>1){divPage--;renderDiv()}};
document.querySelector('#divNext').onclick=()=>{divPage++;renderDiv()};
document.querySelector('#detailClose').onclick=()=>document.querySelector('#detailModal').classList.add('hide');
document.querySelector('#detailModal').onclick=e=>{if(e.target.id==='detailModal')e.currentTarget.classList.add('hide')};
document.addEventListener('click',e=>{const row=e.target.closest('[data-tx]');if(row)showDetail(row.dataset.tx)});
document.querySelectorAll('nav button[data-page]').forEach(b=>b.onclick=()=>{document.querySelectorAll('nav button').forEach(x=>x.classList.remove('active'));b.classList.add('active');document.querySelectorAll('.page').forEach(x=>x.classList.remove('active'));document.querySelector('#'+b.dataset.page).classList.add('active');document.querySelector('#title').textContent={dash:'Visão geral',conc:'Conciliação',rates:'Taxas contratadas',div:'Divergências'}[b.dataset.page]});
document.querySelector('#rateGrid').innerHTML=[
['Débito Visa / Mastercard / Elo','1,04%'],['Débito demais bandeiras','2,39%'],['PIX','0,10%'],['Visa / Mastercard crédito 1x','3,11%'],['Elo crédito 1x','3,39%'],['Diners crédito 1x','3,19%'],['Hipercard / grupo crédito 1x','3,71%'],['Visa / Mastercard / Elo 2x–6x','2,55%'],['Hipercard / grupo 2x–6x','3,00%'],['Diners 2x–18x','3,79%'],['Crédito 7x–18x (grupo)','5,59%'],['Acréscimo vendas parceladas','1,55%/mês']
].map(x=>'<div class="rate"><span class="muted small">'+x[0]+'</span><strong>'+x[1]+'</strong></div>').join('');
api('/api/session').then(async r=>{const j=await r.json();if(j.authenticated){document.querySelector('#login').classList.add('hide');load()}});
</script></body></html>`;

app.get("/", () => html(PAGE, 200, { "cache-control": "no-store" }));
app.get("/health", () => json({ ok: true, service: "spotpass-concilia", version: "1.0.0" }));
app.get("/api/session", async (ctx) => json({ authenticated: await hasSession(ctx.req) }));

app.post("/api/login", async (ctx) => {
  const body = await ctx.req.json().catch(() => ({}));
  const password = Deno.env.get("APP_PASSWORD");
  if (!password) return json({ ok: false, message: "APP_PASSWORD não configurada." }, 503);
  if (String(body?.password || "") !== password) return json({ ok: false, message: "Senha inválida." }, 401);

  const stamp = String(Date.now());
  const signature = await sign(stamp);
  return json({ ok: true }, 200, {
    "set-cookie": `sp_concilia_session=${encodeURIComponent(stamp + "." + signature)}; Path=/; Max-Age=43200; HttpOnly; Secure; SameSite=Lax`,
  });
});

app.get("/api/reconcile", async (ctx) => {
  if (!(await hasSession(ctx.req))) return json({ ok: false, message: "Sessão expirada." }, 401);

  const user = Deno.env.get("PAGBANK_EDI_USER");
  const token = Deno.env.get("PAGBANK_EDI_TOKEN");
  if (!user || !token) return json({ ok: false, message: "EDI PagBank ainda não configurado no servidor." }, 503);

  const url = new URL(ctx.req.url);
  const from = url.searchParams.get("from") || "";
  const to = url.searchParams.get("to") || "";
  const days = daysBetween(from, to);

  if (!days.length) return json({ ok: false, message: "Período inválido." }, 400);
  if (days.length > 7) return json({ ok: false, message: "Consulte no máximo 7 dias por vez nesta fase." }, 400);

  try {
    const results = [];
    for (const day of days) results.push(await ediDay(user, token, day));
    const rows = results.flatMap((r) => r.rows).sort((a: any, b: any) => String(b.occurred_at).localeCompare(String(a.occurred_at)));

    return json({
      ok: true,
      source: "PAGBANK_EDI_DIRECT",
      range: { from, to },
      summary: summarize(rows),
      edi_days: results.map((r) => ({
        day: r.day,
        available: r.available,
        validated: r.validated,
        received: r.received,
        eligible: r.rows.length,
      })),
      rows,
    });
  } catch (error) {
    return json({ ok: false, message: (error instanceof Error ? error.message : String(error)).slice(0, 250) }, 502);
  }
});
