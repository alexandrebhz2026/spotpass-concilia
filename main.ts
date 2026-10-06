import { App } from "fresh";

export const app = new App();

const EDI_BASE = "https://edi.api.pagbank.com.br/movement/v3.00";
const PARCEL_MONTHLY_RATE = 1.55;
const FINANCIAL_DAY_CACHE = new Map<string, { expires: number; payload: any }>();

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
  if (text.includes("CABAL")) return { brand: "CABAL", source: "EDI" };
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

async function ediPage(user: string, token: string, day: string, page: number, pageSize = 1000, movement: "transactional" | "financial" = "transactional") {
  const auth = btoa(user + ":" + token);
  const url = `${EDI_BASE}/${movement}/${day}?pageNumber=${page}&pageSize=${pageSize}`;
  let response: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await fetch(url, { headers: { Authorization: "Basic " + auth, Accept: "application/json" } });
    if (![429, 500, 502, 503, 504].includes(response.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 450 * (attempt + 1)));
  }

  if (!response) throw new Error("PagBank EDI sem resposta.");
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
  const pageConcurrency = 5;
  for (let startPage = 2; startPage <= first.totalPages; startPage += pageConcurrency) {
    const pageNumbers = Array.from(
      { length: Math.min(pageConcurrency, first.totalPages - startPage + 1) },
      (_, i) => startPage + i,
    );
    const settled = await Promise.allSettled(pageNumbers.map((p) => ediPage(user, token, day, p)));
    for (const item of settled) {
      if (item.status === "fulfilled") pages.push(item.value);
      else throw item.reason;
    }
  }
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
function normalizeFinancial(row: Record<string, unknown>, day: string) {
  const method = paymentMethod(row);
  const installments = Math.max(
    1,
    Math.round(n(pick(row, ["quantidade_parcelas", "numero_parcelas", "qtd_parcelas", "installments"]), 1)),
  );
  const installment = Math.max(1, Math.round(n(pick(row, ["parcela", "numero_parcela"]), 1)));
  const resolved = resolveBrand(row, method);
  const gross = n(pick(row, ["valor_original_transacao", "valor_total_transacao"]), 0);
  const settled = n(pick(row, ["valor_parcela", "valor_liquido_transacao"]), 0);
  const intermediation = n(pick(row, ["taxa_intermediacao"]), 0);
  const tariff = n(pick(row, ["tarifa_intermediacao"]), 0);
  const eventType = String(pick(row, ["tipo_evento"]) || "");
  const transactionType = String(pick(row, ["tipo_transacao"]) || "");
  const paymentStatus = String(pick(row, ["status_pagamento"]) || "");
  const rate = baseRate(resolved.brand, method, installments);
  const parcelled = method === "CREDIT" && installments > 1;
  const comparable = eventType === "1" && transactionType === "1" && !parcelled && rate !== null && gross > 0;
  const expected = comparable ? round2(gross - gross * Number(rate) / 100) : null;
  const difference = expected === null ? null : round2(expected - settled);

  return {
    movement_id: String(pick(row, ["movimento_api_codigo"]) || crypto.randomUUID()).trim().toUpperCase(),
    transaction_id: String(pick(row, ["codigo_transacao"]) || "").trim().toUpperCase() || null,
    sale_code: String(pick(row, ["codigo_venda"]) || "").trim() || null,
    movement_date: String(pick(row, ["data_movimentacao", "data_venda_ajuste"]) || day),
    sale_date: String(pick(row, ["data_inicial_transacao"]) || "") || null,
    expected_payment_date: String(pick(row, ["data_prevista_pagamento"]) || "") || null,
    event_type: eventType || null,
    transaction_type: transactionType || null,
    payment_status: paymentStatus || null,
    payment_method: method,
    brand: resolved.brand,
    provider_brand: String(pick(row, ["instituicao_financeira", "bandeira", "brand"]) || "").trim().toUpperCase() || null,
    installments,
    installment,
    gross_amount: round2(gross),
    settled_amount: round2(settled),
    intermediation_fee_amount: round2(intermediation),
    tariff_amount: round2(tariff),
    total_fee_amount: round2(intermediation + tariff),
    contract_rate: rate,
    expected_settlement_amount: expected,
    settlement_difference_amount: difference,
    comparable,
    edi_day: day,
  };
}

async function financialDay(user: string, token: string, day: string) {
  const first = await ediPage(user, token, day, 1, 1000, "financial");
  if (!first.available) return { day, available: false, validated: null, rows: [], received: 0 };
  if (first.validated === false) return { day, available: true, validated: false, rows: [], received: first.details.length };

  const pages = [first];
  const pageConcurrency = 5;
  for (let startPage = 2; startPage <= first.totalPages; startPage += pageConcurrency) {
    const pageNumbers = Array.from(
      { length: Math.min(pageConcurrency, first.totalPages - startPage + 1) },
      (_, i) => startPage + i,
    );
    const settled = await Promise.allSettled(
      pageNumbers.map((p) => ediPage(user, token, day, p, 1000, "financial")),
    );
    for (const item of settled) {
      if (item.status === "fulfilled") pages.push(item.value);
      else throw item.reason;
    }
  }

  const raw = pages.flatMap((p) => p.details);
  const rows = raw.map((row) => normalizeFinancial(row, day));
  const seen = new Set<string>();
  const unique = rows.filter((row) => {
    if (seen.has(row.movement_id)) return false;
    seen.add(row.movement_id);
    return true;
  });
  return { day, available: true, validated: true, rows: unique, received: raw.length };
}

function summarizeFinancial(rows: any[]) {
  const normal = rows.filter((r) => r.event_type === "1" && r.transaction_type === "1");
  const comparable = normal.filter((r) => r.comparable);
  const totalSettled = normal.reduce((acc, r) => acc + Number(r.settled_amount || 0), 0);
  const totalFees = normal.reduce((acc, r) => acc + Number(r.total_fee_amount || 0), 0);
  const expected = comparable.reduce((acc, r) => acc + Number(r.expected_settlement_amount || 0), 0);
  const actualComparable = comparable.reduce((acc, r) => acc + Number(r.settled_amount || 0), 0);
  const toRecover = comparable.reduce((acc, r) => acc + Math.max(0, Number(r.settlement_difference_amount || 0)), 0);
  return {
    movement_count: rows.length,
    settlement_count: normal.length,
    adjustment_count: rows.length - normal.length,
    comparable_count: comparable.length,
    total_settled: round2(totalSettled),
    total_fees: round2(totalFees),
    expected_comparable: round2(expected),
    actual_comparable: round2(actualComparable),
    difference_comparable: round2(expected - actualComparable),
    to_recover: round2(toRecover),
  };
}

function daysBetween(from: string, to: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return [];
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const start = Date.UTC(fy, fm - 1, fd);
  const end = Date.UTC(ty, tm - 1, td);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const out: string[] = [];
  for (let t = start; t <= end && out.length < 32; t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
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
    comparable_pagbank_net: 0,
    net_difference: 0,
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
    s.comparable_pagbank_net += Number(row.net_amount || 0);
    const diff = Number(row.difference_amount || 0);
    if (diff > 0) s.to_recover += diff;
    if (Math.abs(diff) >= 0.01) s.divergent_count++;
  }
  s.net_difference = round2(s.expected_net - s.comparable_pagbank_net);
  for (const key of ["gross", "pagbank_net", "pagbank_fee", "expected_base_fee", "expected_net", "comparable_pagbank_net", "net_difference", "to_recover"] as const) {
    s[key] = round2(s[key]);
  }
  return s;
}
function mergeSummaries(parts: any[]) {
  const total = {
    total_rows: 0,
    gross: 0,
    pagbank_net: 0,
    pagbank_fee: 0,
    expected_base_fee: 0,
    expected_net: 0,
    comparable_pagbank_net: 0,
    net_difference: 0,
    to_recover: 0,
    divergent_count: 0,
    unresolved_count: 0,
    parcel_pending_count: 0,
  };
  for (const part of parts) {
    total.total_rows += Number(part.total_rows || 0);
    total.gross += Number(part.gross || 0);
    total.pagbank_net += Number(part.pagbank_net || 0);
    total.pagbank_fee += Number(part.pagbank_fee || 0);
    total.expected_base_fee += Number(part.expected_base_fee || 0);
    total.expected_net += Number(part.expected_net || 0);
    total.comparable_pagbank_net += Number(part.comparable_pagbank_net || 0);
    total.to_recover += Number(part.to_recover || 0);
    total.divergent_count += Number(part.divergent_count || 0);
    total.unresolved_count += Number(part.unresolved_count || 0);
    total.parcel_pending_count += Number(part.parcel_pending_count || 0);
  }
  total.net_difference = round2(total.expected_net - total.comparable_pagbank_net);
  for (const key of ["gross", "pagbank_net", "pagbank_fee", "expected_base_fee", "expected_net", "comparable_pagbank_net", "net_difference", "to_recover"] as const) {
    total[key] = round2(total[key]);
  }
  return total;
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
.rates{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));grid-auto-rows:104px;gap:8px;min-height:0;align-content:start}
.rate{padding:9px 10px;border:1px solid var(--line);background:#fff;border-radius:10px;min-width:0;display:flex;flex-direction:column;justify-content:center}.rate strong{display:block;font-size:16px;margin:4px 0}
.small{font-size:10px}.danger{color:var(--red);font-weight:800}
.pager{height:34px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex:0 0 auto;padding-top:5px}.pager .btn{height:28px}.pagerInfo{font-size:9px;color:var(--muted)}
.audit-head{display:grid;grid-template-columns:minmax(0,1.8fr) .7fr .9fr .9fr .7fr;gap:10px;padding:6px 2px;border-bottom:1px solid var(--line);font-size:8px;font-weight:800;text-transform:uppercase;color:var(--muted)}.audit-list{min-height:0;flex:1;overflow:hidden}.audit-item{height:46px;border-bottom:1px solid #eef0f2;display:grid;grid-template-columns:minmax(0,1.8fr) .7fr .9fr .9fr .7fr;gap:10px;align-items:center;padding:5px 2px;font-size:10px}.audit-item b,.audit-item span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.modal{position:fixed;inset:0;background:rgba(20,23,28,.25);display:grid;place-items:center;z-index:40;padding:18px}.modal.hide{display:none}.modal-card{width:min(760px,94vw);max-height:88vh;background:#fff;border:1px solid var(--line);border-radius:16px;box-shadow:0 20px 55px rgba(17,24,39,.18);padding:16px;overflow:hidden}.modal-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}.detail-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.detail{border:1px solid var(--line);border-radius:9px;padding:9px;min-width:0}.detail span{display:block;font-size:8px;color:var(--muted);text-transform:uppercase;font-weight:800;margin-bottom:4px}.detail b{font-size:11px;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#dash .panel{margin-bottom:0}
#conc .panel,#div .panel{margin-top:0}
#rates{padding-bottom:0}
@media(max-width:1100px){.app{grid-template-columns:190px minmax(0,1fr)}.side{width:190px}.grid{grid-template-columns:repeat(5,minmax(0,1fr))}.card strong{font-size:15px}.rates{grid-template-columns:repeat(4,minmax(0,1fr));grid-auto-rows:96px}.main{padding-left:12px;padding-right:12px}th,td{font-size:8.5px;padding:4px}}
@media(max-width:760px){html,body{overflow:hidden}.app{display:block}.side{position:absolute;z-index:20;width:100%;height:58px;border-right:0;border-bottom:1px solid var(--line);padding:8px 10px;display:flex;align-items:center;gap:8px}.brand{margin:0}.mark{width:32px;height:32px}.side nav{display:flex;gap:3px;overflow:hidden}.side nav button{width:auto;margin:0;padding:7px 8px;font-size:9px}.main{grid-column:auto;height:100vh;padding:58px 8px 8px}.top{height:54px}.page{height:calc(100vh - 112px);padding-top:8px}.top h1{font-size:18px}.grid{grid-template-columns:repeat(2,minmax(0,1fr));grid-auto-rows:58px}.grid .card:nth-child(5){display:none}.rates{grid-template-columns:repeat(2,minmax(0,1fr));grid-auto-rows:76px}.note{font-size:9px}.detail-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style></head><body>
<div id="login" class="login"><form id="loginForm" class="loginbox"><div class="brand"><div class="mark"><svg viewBox="0 0 449 449"><rect width="449" height="449" fill="#F15613"/><path fill="#fff" d="M127 80 L112 91 L99 107 L90 125 L84 151 L84 304 L88 319 L87 321 L93 339 L107 360 L126 376 L150 386 L166 389 L256 390 L282 386 L304 377 L319 366 L331 353 L341 335 L346 320 L349 299 L348 171 L340 164 L282 164 L275 168 L272 174 L272 293 L269 306 L260 317 L244 323 L189 323 L174 318 L165 308 L161 290 L162 157 L165 148 L176 137 L191 133 L232 133 L239 129 L242 119 L241 75 L238 70 L233 67 L170 67 L146 72 L131 78 L131 80 Z"/><path fill="#fff" d="M275 56 L272 64 L272 124 L278 132 L283 134 L350 134 L359 130 L362 125 L362 120 L356 104 L343 86 L328 72 L300 56 L290 53 L281 53 Z"/></svg></div><div><b>SpotPass Concilia</b><small>acesso da equipe</small></div></div><div class="muted small">Use a senha interna do conciliador.</div><input id="password" type="password" placeholder="Senha"><div id="loginErr" class="small" style="color:#b93b4d;min-height:20px"></div><button class="btn primary" style="width:100%;height:42px">Entrar</button></form></div>

<div class="app"><aside class="side"><div class="brand"><div class="mark"><svg viewBox="0 0 449 449"><rect width="449" height="449" fill="#F15613"/><path fill="#fff" d="M127 80 L112 91 L99 107 L90 125 L84 151 L84 304 L88 319 L87 321 L93 339 L107 360 L126 376 L150 386 L166 389 L256 390 L282 386 L304 377 L319 366 L331 353 L341 335 L346 320 L349 299 L348 171 L340 164 L282 164 L275 168 L272 174 L272 293 L269 306 L260 317 L244 323 L189 323 L174 318 L165 308 L161 290 L162 157 L165 148 L176 137 L191 133 L232 133 L239 129 L242 119 L241 75 L238 70 L233 67 L170 67 L146 72 L131 78 L131 80 Z"/><path fill="#fff" d="M275 56 L272 64 L272 124 L278 132 L283 134 L350 134 L359 130 L362 125 L362 120 L356 104 L343 86 L328 72 L300 56 L290 53 L281 53 Z"/></svg></div><div><b>SpotPass</b><small>Concilia</small></div></div><nav>
<button class="active" data-page="dash">Visão geral</button><button data-page="conc">Transações</button><button data-page="recv">Recebimentos PagBank</button><button data-page="rates">Taxas do contrato</button><button data-page="div">A recuperar</button>
</nav></aside>

<main class="main"><header class="top"><div><div class="ey">AUDITORIA DE ADQUIRÊNCIA</div><h1 id="title">Visão geral</h1></div><span id="status" class="status">ONLINE</span></header>

<section id="dash" class="page active"><div class="filters"><label class="muted small">De</label><input id="from" class="input" type="date"><label class="muted small">Até</label><input id="to" class="input" type="date"><button id="load" class="btn primary">Atualizar</button><span id="periodLabel" class="muted small"></span></div><div id="queryNotice" class="note" style="display:none"></div>

<div id="cards" class="grid"></div><div class="panel"><div class="ey">TRANSAÇÃO A TRANSAÇÃO</div><h3 style="margin:5px 0 12px">Maiores diferenças calculáveis</h3><div class="tw"><table><thead><tr><th>Data</th><th>Transação</th><th>Bandeira</th><th>Modalidade</th><th>Parcelas</th><th>Valor vendido</th><th>PagBank deveria pagar</th><th>PagBank pagou</th><th>Diferença</th><th>Situação</th></tr></thead><tbody id="topRows"></tbody></table></div></div></section>

<section id="conc" class="page"><div class="filters"><input id="search" class="input" style="width:260px" placeholder="Buscar transação ou bandeira"><span class="muted small"><b>Leitura:</b> comparamos quanto o PagBank deveria pagar pelo contrato com quanto realmente pagou. Clique em uma linha para abrir os detalhes.</span></div><div class="panel"><div class="tw"><table><thead><tr><th style="width:9%">Data</th><th style="width:13%">Transação</th><th style="width:9%">Bandeira</th><th style="width:7%">Pagamento</th><th style="width:6%">Parc.</th><th style="width:9%">Valor vendido</th><th style="width:7%">Taxa contrato</th><th style="width:11%">PagBank deveria pagar</th><th style="width:11%">PagBank pagou</th><th style="width:9%">Diferença</th><th style="width:9%">Situação</th></tr></thead><tbody id="allRows"></tbody></table></div><div class="pager"><span id="concPageInfo" class="pagerInfo"></span><div><button id="concPrev" class="btn">Anterior</button> <button id="concNext" class="btn">Próxima</button></div></div></div></section>

<section id="recv" class="page">
<div class="filters"><label class="muted small">De</label><input id="finFrom" class="input" type="date"><label class="muted small">Até</label><input id="finTo" class="input" type="date"><button id="loadFinancial" class="btn primary">Atualizar recebimentos</button><span id="finPeriodLabel" class="muted small"></span></div>
<div id="finNotice" class="note" style="display:none"></div>
<div id="finCards" class="grid"></div>
<div class="panel"><div class="ey">EDI FINANCEIRO PAGBANK</div><h3>Liquidações e movimentos financeiros</h3><div class="muted small" style="margin-bottom:7px">Aqui usamos o arquivo <b>financial</b> do EDI PagBank. Ele mostra o que efetivamente entrou na liquidação, parcela por parcela.</div><div class="tw"><table><thead><tr><th style="width:10%">Movimento</th><th style="width:15%">Transação</th><th style="width:10%">Bandeira</th><th style="width:8%">Pagamento</th><th style="width:7%">Parcela</th><th style="width:10%">Venda</th><th style="width:11%">Deveria liquidar</th><th style="width:11%">Liquidado</th><th style="width:9%">Diferença</th><th style="width:9%">Evento</th></tr></thead><tbody id="finRows"></tbody></table></div><div class="pager"><span id="finPageInfo" class="pagerInfo"></span><div><button id="finPrev" class="btn">Anterior</button> <button id="finNext" class="btn">Próxima</button></div></div></div>
</section>

<section id="rates" class="page"><div class="note"><b>Para que serve esta página:</b> estas são as taxas do contrato usadas para calcular quanto o PagBank deveria descontar em cada venda. O sistema escolhe a taxa pela forma de pagamento, bandeira e número de parcelas.</div><div id="rateGrid" class="rates"></div></section>

<section id="div" class="page"><div class="panel"><div class="ey">VALORES A RECUPERAR • LIQUIDAÇÃO</div><h3>Movimentos em que o PagBank liquidou menos do que deveria</h3><div id="divPeriod" class="muted small" style="margin-bottom:7px">Carregando o EDI financeiro...</div><div class="audit-head"><span>Transação</span><span>Vendido</span><span>Deveria liquidar</span><span>Liquidado</span><span>Diferença</span></div><div id="divergences" class="audit-list"></div><div class="pager"><span id="divPageInfo" class="pagerInfo"></span><div><button id="divPrev" class="btn">Anterior</button> <button id="divNext" class="btn">Próxima</button></div></div></div></section>
</main></div>
<div id="detailModal" class="modal hide"><div class="modal-card"><div class="modal-head"><div><div class="ey">DETALHES DA TRANSAÇÃO</div><b id="detailTitle"></b></div><button id="detailClose" class="btn">Fechar</button></div><div id="detailGrid" class="detail-grid"></div></div></div>

<script>
const money=v=>v==null?'—':new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'}).format(Number(v||0));
const pct=v=>v==null?'—':Number(v).toFixed(2).replace('.',',')+'%';
function spDay(value){const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(value));const get=t=>parts.find(p=>p.type===t)?.value||'';return get('year')+'-'+get('month')+'-'+get('day')}
const lastClosedDay=spDay(Date.now()-86400000);
['from','to','finFrom','finTo'].forEach(id=>{const el=document.querySelector('#'+id);el.value=lastClosedDay;el.max=lastClosedDay});
let data={rows:[],summary:{}},financialData={rows:[],summary:{}},concPage=1,divPage=1,finPage=1,financialLoaded=false;
const PAGE_SIZE=8,DIV_SIZE=8,FIN_SIZE=8;
async function api(url,opt){const r=await fetch(url,{credentials:'include',...(opt||{})});if(r.status===401)document.querySelector('#login').classList.remove('hide');return r}
function isoDays(from,to){const a=new Date(from+'T00:00:00Z'),b=new Date(to+'T00:00:00Z'),out=[];for(let t=a.getTime();t<=b.getTime()&&out.length<32;t+=86400000)out.push(new Date(t).toISOString().slice(0,10));return out}
function emptyFinancialSummary(){return {movement_count:0,settlement_count:0,adjustment_count:0,comparable_count:0,total_settled:0,total_fees:0,expected_comparable:0,actual_comparable:0,difference_comparable:0,to_recover:0}}
function addFinancialSummary(a,b){for(const k of ['movement_count','settlement_count','adjustment_count','comparable_count','total_settled','total_fees','expected_comparable','actual_comparable','to_recover'])a[k]=Number(a[k]||0)+Number(b?.[k]||0);a.difference_comparable=Number((a.expected_comparable-a.actual_comparable).toFixed(2));for(const k of ['total_settled','total_fees','expected_comparable','actual_comparable','difference_comparable','to_recover'])a[k]=Number(a[k].toFixed(2));return a}
function currentPage(){return document.querySelector('nav button.active')?.dataset?.page||'dash'}
document.querySelector('#loginForm').onsubmit=async e=>{e.preventDefault();const r=await api('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:document.querySelector('#password').value})});const j=await r.json();if(!r.ok){document.querySelector('#loginErr').textContent=j.message||'Falha';return}document.querySelector('#login').classList.add('hide');load()};
function pill(row){if(row.calculation_status==='PARCELAMENTO_AGUARDA_CALIBRACAO')return '<span class="pill warn">Regra parcelada pendente</span>';if(row.calculation_status==='TAXA_NAO_RESOLVIDA')return '<span class="pill warn">Taxa não identificada</span>';const d=Number(row.difference_amount||0);if(Math.abs(d)<.01)return '<span class="pill ok">Correto</span>';if(d>0)return '<span class="pill bad">Pagou menos</span>';return '<span class="pill ok">Pagou mais</span>'}
function topTr(row){const d=row.difference_amount;return '<tr data-tx="'+row.transaction_id+'"><td>'+String(row.occurred_at||'').replace('T',' ')+'</td><td>'+row.transaction_id+'</td><td>'+(row.brand||row.provider_brand||'—')+'</td><td>'+row.payment_method+'</td><td>'+row.installments+'x</td><td>'+money(row.gross_amount)+'</td><td>'+money(row.expected_net_amount)+'</td><td>'+money(row.net_amount)+'</td><td class="'+(d>0?'danger':'')+'">'+money(d)+'</td><td>'+pill(row)+'</td></tr>'}
function compactTr(row){const d=row.difference_amount;return '<tr data-tx="'+row.transaction_id+'"><td>'+String(row.occurred_at||'').replace('T',' ')+'</td><td>'+row.transaction_id+'</td><td>'+(row.brand||row.provider_brand||'—')+'</td><td>'+row.payment_method+'</td><td>'+row.installments+'x</td><td>'+money(row.gross_amount)+'</td><td>'+pct(row.contract_base_rate)+'</td><td>'+money(row.expected_net_amount)+'</td><td>'+money(row.net_amount)+'</td><td class="'+(d>0?'danger':'')+'">'+money(d)+'</td><td>'+pill(row)+'</td></tr>'}
function filteredRows(){const q=(document.querySelector('#search').value||'').toLowerCase();return data.rows.filter(r=>!q||(r.transaction_id+' '+(r.brand||r.provider_brand||'')+' '+r.payment_method).toLowerCase().includes(q))}
function renderConc(){const rows=filteredRows(),pages=Math.max(1,Math.ceil(rows.length/PAGE_SIZE));if(concPage>pages)concPage=pages;const start=(concPage-1)*PAGE_SIZE,slice=rows.slice(start,start+PAGE_SIZE);document.querySelector('#allRows').innerHTML=slice.map(compactTr).join('')||'<tr><td colspan="11" class="muted">Nenhuma transação.</td></tr>';document.querySelector('#concPageInfo').textContent='Página '+concPage+' de '+pages+' • '+rows.length+' transações';document.querySelector('#concPrev').disabled=concPage<=1;document.querySelector('#concNext').disabled=concPage>=pages}
function renderDiv(){const rows=(financialData.recoverable_rows||[]);const pages=Math.max(1,Math.ceil(rows.length/DIV_SIZE));if(divPage>pages)divPage=pages;const start=(divPage-1)*DIV_SIZE;const range=financialData.range;document.querySelector('#divPeriod').innerHTML=range?'<b>Período financeiro:</b> '+range.from.split('-').reverse().join('/')+' a '+range.to.split('-').reverse().join('/')+' • <b>Total a recuperar:</b> '+money(financialData.summary?.to_recover||0):'Abra Recebimentos PagBank ou aguarde a consulta financeira.';document.querySelector('#divergences').innerHTML=rows.slice(start,start+DIV_SIZE).map(r=>'<div class="audit-item"><b>'+(r.transaction_id||r.movement_id)+' · '+(r.brand||r.provider_brand||'—')+'</b><span>'+money(r.gross_amount)+'</span><span>'+money(r.expected_settlement_amount)+'</span><span>'+money(r.settled_amount)+'</span><span class="danger">'+money(r.settlement_difference_amount)+'</span></div>').join('')||'<div class="muted">Nenhuma liquidação com valor a recuperar neste período.</div>';document.querySelector('#divPageInfo').textContent='Página '+divPage+' de '+pages+' • '+rows.length+' divergências de liquidação';document.querySelector('#divPrev').disabled=divPage<=1;document.querySelector('#divNext').disabled=divPage>=pages}
function finEventLabel(r){if(r.event_type==='1'&&r.transaction_type==='1')return '<span class="pill ok">Liquidação</span>';return '<span class="pill warn">Evento '+(r.event_type||'—')+'</span>'}
function finTr(r){const d=r.settlement_difference_amount;return '<tr><td>'+String(r.movement_date||'')+'</td><td>'+(r.transaction_id||'—')+'</td><td>'+(r.brand||r.provider_brand||'—')+'</td><td>'+r.payment_method+'</td><td>'+r.installment+'/'+r.installments+'</td><td>'+money(r.gross_amount)+'</td><td>'+money(r.expected_settlement_amount)+'</td><td>'+money(r.settled_amount)+'</td><td class="'+(Number(d)>0?'danger':'')+'">'+money(d)+'</td><td>'+finEventLabel(r)+'</td></tr>'}
function renderFinancial(){const s=financialData.summary||{};document.querySelector('#finCards').innerHTML=[['Liquidado no período',money(s.total_settled),(s.settlement_count||0)+' movimentos de liquidação'],['Taxas no financeiro',money(s.total_fees),'taxa + tarifa EDI'],['Deveria liquidar',money(s.expected_comparable),(s.comparable_count||0)+' operações comparáveis'],['Liquidou',money(s.actual_comparable),'mesmas operações comparáveis'],['A recuperar',money(s.to_recover),'diferenças positivas','hot']].map(x=>'<div class="card '+(x[3]||'')+'"><span>'+x[0]+'</span><strong>'+x[1]+'</strong><small class="muted">'+x[2]+'</small></div>').join('');const rows=financialData.rows||[],pages=Math.max(1,Math.ceil(rows.length/FIN_SIZE));if(finPage>pages)finPage=pages;const start=(finPage-1)*FIN_SIZE;document.querySelector('#finRows').innerHTML=rows.slice(start,start+FIN_SIZE).map(finTr).join('')||'<tr><td colspan="10" class="muted">Nenhum movimento financeiro no período.</td></tr>';document.querySelector('#finPageInfo').textContent='Página '+finPage+' de '+pages+' • '+rows.length+' movimentos exibidos';document.querySelector('#finPrev').disabled=finPage<=1;document.querySelector('#finNext').disabled=finPage>=pages}
async function loadFinancial(){
  let f=document.querySelector('#finFrom').value,t=document.querySelector('#finTo').value;
  const notice=document.querySelector('#finNotice'),button=document.querySelector('#loadFinancial');
  if(t>lastClosedDay){t=lastClosedDay;document.querySelector('#finTo').value=t}
  if(f>t){f=t;document.querySelector('#finFrom').value=f}
  const days=isoDays(f,t);
  if(!days.length){notice.style.display='block';notice.textContent='Período inválido.';return}
  button.disabled=true;
  notice.style.display='block';
  notice.innerHTML='<b>Carregando EDI financeiro:</b> 0 de '+days.length+' dias.';
  document.querySelector('#finPeriodLabel').textContent='Consultando '+f.split('-').reverse().join('/')+' a '+t.split('-').reverse().join('/');
  if(['recv','div'].includes(currentPage()))document.querySelector('#status').textContent='FINANCEIRO • 0/'+days.length+' DIAS';
  financialData={rows:[],recoverable_rows:[],summary:emptyFinancialSummary(),range:{from:f,to:t}};
  finPage=1;divPage=1;renderFinancial();renderDiv();
  const failed=[];
  let completed=0;
  const concurrency=3;
  for(let i=0;i<days.length;i+=concurrency){
    const batch=days.slice(i,i+concurrency);
    const results=await Promise.all(batch.map(async dayValue=>{
      try{
        const r=await api('/api/financial-day?day='+encodeURIComponent(dayValue));
        const j=await r.json().catch(()=>({}));
        if(!r.ok||!j.ok)throw new Error(j.message||'Falha EDI');
        return {ok:true,data:j};
      }catch(e){return {ok:false,day:dayValue,message:e?.message||String(e)}}
    }));
    for(const item of results){
      completed++;
      if(!item.ok){failed.push({day:item.day,message:item.message});continue}
      const j=item.data;
      addFinancialSummary(financialData.summary,j.summary||{});
      financialData.rows.push(...(j.rows||[]));
      financialData.recoverable_rows.push(...(j.recoverable_rows||[]));
    }
    financialData.rows=financialData.rows.sort((a,b)=>String(b.movement_date).localeCompare(String(a.movement_date))).slice(0,1000);
    financialData.recoverable_rows=financialData.recoverable_rows.sort((a,b)=>Number(b.settlement_difference_amount||0)-Number(a.settlement_difference_amount||0)).slice(0,500);
    renderFinancial();renderDiv();
    notice.innerHTML='<b>Carregando EDI financeiro:</b> '+completed+' de '+days.length+' dias'+(failed.length?' • '+failed.length+' com falha':'')+'.';
    if(['recv','div'].includes(currentPage()))document.querySelector('#status').textContent='FINANCEIRO • '+completed+'/'+days.length+' DIAS';
  }
  financialLoaded=true;
  financialData.partial=failed.length>0;
  financialData.failed_days=failed;
  document.querySelector('#finPeriodLabel').textContent='Período carregado: '+f.split('-').reverse().join('/')+' a '+t.split('-').reverse().join('/');
  if(failed.length){
    notice.style.display='block';
    notice.innerHTML='<b>Consulta parcial.</b> '+failed.length+' dia(s) falharam: '+failed.map(x=>x.day.split('-').reverse().join('/')).join(', ')+'.';
  }else{
    notice.style.display='none';notice.textContent='';
  }
  if(currentPage()==='recv')document.querySelector('#status').textContent='FINANCEIRO • '+(financialData.summary?.settlement_count||0)+' MOVIMENTOS';
  if(currentPage()==='div')document.querySelector('#status').textContent='A RECUPERAR • '+money(financialData.summary?.to_recover||0);
  button.disabled=false;
}
function render(){const s=data.summary||{};const pend=(s.parcel_pending_count||0)+(s.unresolved_count||0);document.querySelector('#cards').innerHTML=[['Total transacionado',money(s.gross),(s.total_rows||0)+' transações'],['PagBank deveria pagar',money(s.expected_net),pend?pend+' transações ainda sem cálculo':'valor pelo contrato'],['PagBank pagou',money(s.comparable_pagbank_net),'mesmas transações calculadas'],['Diferença',money(s.net_difference),Number(s.net_difference)>0?'faltou o PagBank pagar':(Number(s.net_difference)<0?'PagBank pagou a mais':'valores iguais'),Number(s.net_difference)>0?'hot':''],['A recuperar',money(s.to_recover),'soma das diferenças positivas','hot']].map(x=>'<div class="card '+(x[3]||'')+'"><span>'+x[0]+'</span><strong>'+x[1]+'</strong><small class="muted">'+x[2]+'</small></div>').join('');const calc=data.rows.filter(r=>r.difference_amount!=null).sort((a,b)=>Math.abs(b.difference_amount)-Math.abs(a.difference_amount));document.querySelector('#topRows').innerHTML=calc.slice(0,6).map(topTr).join('')||'<tr><td colspan="10" class="muted">Sem diferenças calculáveis.</td></tr>';renderConc();renderDiv()}
function showDetail(id){const r=data.rows.find(x=>String(x.transaction_id)===String(id));if(!r)return;document.querySelector('#detailTitle').textContent=r.transaction_id;const items=[['Data',String(r.occurred_at||'').replace('T',' ')],['Bandeira',r.brand||r.provider_brand||'—'],['Fonte da bandeira',r.brand_source||'—'],['Modalidade',r.payment_method],['Parcelas',r.installments+'x'],['Bruto',money(r.gross_amount)],['Taxa do contrato',pct(r.contract_base_rate)],['Acréscimo parcelado',r.parcel_monthly_rate?'1,55%/mês':'—'],['Taxa que deveria descontar',money(r.expected_base_fee_amount)],['Taxa que o PagBank descontou',money(r.provider_fee_amount)],['PagBank deveria pagar',money(r.expected_net_amount)],['PagBank pagou',money(r.net_amount)],['Diferença',money(r.difference_amount)],['BIN/IIN',r.card_bin||'—'],['Final cartão',r.last4||'—'],['PDV',r.serial_number||'—']];document.querySelector('#detailGrid').innerHTML=items.map(x=>'<div class="detail"><span>'+x[0]+'</span><b title="'+String(x[1]).replaceAll('"','&quot;')+'">'+x[1]+'</b></div>').join('');document.querySelector('#detailModal').classList.remove('hide')}
async function load(){
  let f=document.querySelector('#from').value,t=document.querySelector('#to').value;
  const notice=document.querySelector('#queryNotice');
  if(t>lastClosedDay){t=lastClosedDay;document.querySelector('#to').value=t}
  if(f>t){f=t;document.querySelector('#from').value=f}
  if(['dash','conc'].includes(currentPage()))document.querySelector('#status').textContent='CARREGANDO TRANSAÇÕES...';
  document.querySelector('#periodLabel').textContent='Consultando '+f.split('-').reverse().join('/')+' a '+t.split('-').reverse().join('/');
  notice.style.display='none';notice.textContent='';
  data={rows:[],summary:{}};concPage=1;divPage=1;render();
  const r=await api('/api/reconcile?from='+encodeURIComponent(f)+'&to='+encodeURIComponent(t));
  const j=await r.json().catch(()=>({}));
  if(!r.ok){
    if(['dash','conc'].includes(currentPage()))document.querySelector('#status').textContent='ERRO';
    notice.style.display='block';
    notice.innerHTML='<b>Não foi possível atualizar '+f.split('-').reverse().join('/')+' a '+t.split('-').reverse().join('/')+':</b> '+(j.message||'falha na consulta EDI.');
    return;
  }
  data=j;concPage=1;divPage=1;render();
  document.querySelector('#periodLabel').textContent='Período carregado: '+f.split('-').reverse().join('/')+' a '+t.split('-').reverse().join('/');
  if(j.partial){
    notice.style.display='block';
    const falhas=(j.failed_days||[]).map(x=>x.day.split('-').reverse().join('/')).join(', ');
    notice.innerHTML='<b>Consulta parcial.</b> O período correto foi aplicado, mas estes dias falharam no EDI: '+falhas+'. Tente Atualizar novamente.';
    if(['dash','conc'].includes(currentPage()))document.querySelector('#status').textContent='PARCIAL • '+(j.summary?.total_rows||0)+' TRANSAÇÕES';
  }else{
    if(['dash','conc'].includes(currentPage()))document.querySelector('#status').textContent='EDI DIRETO • '+(j.summary?.total_rows||0)+' TRANSAÇÕES';
    if((j.summary?.total_rows||0)===0){
      notice.style.display='block';
      notice.innerHTML='<b>Sem movimentos no EDI neste período.</b> A consulta foi feita normalmente. O último dia disponível para consulta fechada é '+lastClosedDay.split('-').reverse().join('/')+'.';
    }
  }
}
document.querySelector('#load').onclick=load;
document.querySelector('#search').oninput=()=>{concPage=1;renderConc()};
document.querySelector('#concPrev').onclick=()=>{if(concPage>1){concPage--;renderConc()}};
document.querySelector('#concNext').onclick=()=>{concPage++;renderConc()};
document.querySelector('#divPrev').onclick=()=>{if(divPage>1){divPage--;renderDiv()}};
document.querySelector('#divNext').onclick=()=>{divPage++;renderDiv()};
document.querySelector('#loadFinancial').onclick=loadFinancial;
document.querySelector('#finPrev').onclick=()=>{if(finPage>1){finPage--;renderFinancial()}};
document.querySelector('#finNext').onclick=()=>{finPage++;renderFinancial()};
document.querySelector('#detailClose').onclick=()=>document.querySelector('#detailModal').classList.add('hide');
document.querySelector('#detailModal').onclick=e=>{if(e.target.id==='detailModal')e.currentTarget.classList.add('hide')};
document.addEventListener('click',e=>{const row=e.target.closest('[data-tx]');if(row)showDetail(row.dataset.tx)});
document.querySelectorAll('nav button[data-page]').forEach(b=>b.onclick=()=>{document.querySelectorAll('nav button').forEach(x=>x.classList.remove('active'));b.classList.add('active');document.querySelectorAll('.page').forEach(x=>x.classList.remove('active'));document.querySelector('#'+b.dataset.page).classList.add('active');document.querySelector('#title').textContent={dash:'Visão geral',conc:'Transações',recv:'Recebimentos PagBank',rates:'Taxas do contrato',div:'A recuperar'}[b.dataset.page];if((b.dataset.page==='recv'||b.dataset.page==='div')&&!financialLoaded){document.querySelector('#finFrom').value=document.querySelector('#from').value;document.querySelector('#finTo').value=document.querySelector('#to').value;loadFinancial()}else if(b.dataset.page==='div'){renderDiv();document.querySelector('#status').textContent='A RECUPERAR • '+money(financialData.summary?.to_recover||0)}else if(b.dataset.page==='recv'){document.querySelector('#status').textContent='FINANCEIRO • '+(financialData.summary?.settlement_count||0)+' MOVIMENTOS'}else if(b.dataset.page==='dash'||b.dataset.page==='conc'){document.querySelector('#status').textContent='EDI TRANSAÇÕES • '+(data.summary?.total_rows||0)+' TRANSAÇÕES'}});
document.querySelector('#rateGrid').innerHTML=[
['Débito Visa / Mastercard / Elo','1,04%'],['Débito Cabal','2,39%'],['Débito demais bandeiras','2,39%'],['PIX','0,10%'],['Visa / Mastercard crédito 1x','3,11%'],['Elo crédito 1x','3,39%'],['Diners crédito 1x','3,19%'],['Hipercard / grupo crédito 1x','3,71%'],['Visa / Mastercard / Elo 2x–6x','2,55%'],['Hipercard / grupo 2x–6x','3,00%'],['Diners 2x–18x','3,79%'],['Crédito 7x–18x (grupo)','5,59%'],['Acréscimo vendas parceladas','1,55%/mês']
].map(x=>'<div class="rate"><span class="muted small">'+x[0]+'</span><strong>'+x[1]+'</strong></div>').join('');
api('/api/session').then(async r=>{const j=await r.json();if(j.authenticated){document.querySelector('#login').classList.add('hide');load()}});
</script></body></html>`;

app.get("/", () => html(PAGE, 200, { "cache-control": "no-store" }));
app.get("/health", () => json({ ok: true, service: "spotpass-concilia", version: "1.3.0" }));
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

app.get("/api/financial-day", async (ctx) => {
  if (!(await hasSession(ctx.req))) return json({ ok: false, message: "Sessão expirada." }, 401);
  const user = Deno.env.get("PAGBANK_EDI_USER");
  const token = Deno.env.get("PAGBANK_EDI_TOKEN");
  if (!user || !token) return json({ ok: false, message: "EDI PagBank ainda não configurado no servidor." }, 503);

  const url = new URL(ctx.req.url);
  const day = url.searchParams.get("day") || "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json({ ok: false, message: "Data inválida." }, 400);

  const cached = FINANCIAL_DAY_CACHE.get(day);
  if (cached && cached.expires > Date.now()) return json({ ...cached.payload, cached: true });

  try {
    const result = await financialDay(user, token, day);
    const allRows = result.rows || [];
    const summary = summarizeFinancial(allRows);
    const rows = [...allRows]
      .sort((a: any, b: any) => String(b.movement_date).localeCompare(String(a.movement_date)))
      .slice(0, 80);
    const recoverableRows = allRows
      .filter((r: any) => r.comparable && Number(r.settlement_difference_amount || 0) > 0)
      .sort((a: any, b: any) => Number(b.settlement_difference_amount || 0) - Number(a.settlement_difference_amount || 0))
      .slice(0, 80);

    const payload = {
      ok: true,
      day,
      available: result.available,
      validated: result.validated,
      received: result.received,
      summary,
      rows,
      recoverable_rows: recoverableRows,
    };

    // Dias validados mudam pouco; cache quente reduz leituras repetidas do EDI.
    if (result.validated === true) {
      FINANCIAL_DAY_CACHE.set(day, { expires: Date.now() + 6 * 60 * 60 * 1000, payload });
    }
    return json(payload);
  } catch (error) {
    return json({ ok: false, day, message: (error instanceof Error ? error.message : String(error)).slice(0, 200) }, 502);
  }
});

app.get("/api/financial", async (ctx) => {
  if (!(await hasSession(ctx.req))) return json({ ok: false, message: "Sessão expirada." }, 401);
  const user = Deno.env.get("PAGBANK_EDI_USER");
  const token = Deno.env.get("PAGBANK_EDI_TOKEN");
  if (!user || !token) return json({ ok: false, message: "EDI PagBank ainda não configurado no servidor." }, 503);

  const url = new URL(ctx.req.url);
  const from = url.searchParams.get("from") || "";
  const to = url.searchParams.get("to") || "";
  const days = daysBetween(from, to);
  if (!days.length) return json({ ok: false, message: "Período inválido." }, 400);
  if (days.length > 31) return json({ ok: false, message: "Consulte no máximo 31 dias por vez." }, 400);

  const successful: any[] = [];
  const failed: { day: string; message: string }[] = [];
  const concurrency = 3;
  for (let i = 0; i < days.length; i += concurrency) {
    const batch = days.slice(i, i + concurrency);
    const settled = await Promise.allSettled(batch.map((day) => financialDay(user, token, day)));
    settled.forEach((item, index) => {
      const day = batch[index];
      if (item.status === "fulfilled") successful.push(item.value);
      else failed.push({ day, message: String(item.reason?.message || item.reason || "Falha EDI financeiro").slice(0, 160) });
    });
  }

  if (!successful.length) {
    return json({ ok: false, message: failed[0]?.message || "Nenhum dia financeiro pôde ser consultado.", failed_days: failed }, 502);
  }

  const allRows = successful.flatMap((r) => r.rows);
  const rows = [...allRows]
    .sort((a: any, b: any) => String(b.movement_date).localeCompare(String(a.movement_date)))
    .slice(0, 1000);
  const recoverableRows = allRows
    .filter((r: any) => r.comparable && Number(r.settlement_difference_amount || 0) > 0)
    .sort((a: any, b: any) => Number(b.settlement_difference_amount || 0) - Number(a.settlement_difference_amount || 0))
    .slice(0, 500);

  return json({
    ok: true,
    partial: failed.length > 0,
    source: "PAGBANK_EDI_FINANCIAL",
    range: { from, to },
    summary: summarizeFinancial(allRows),
    rows,
    recoverable_rows: recoverableRows,
    edi_days: successful.map((r) => ({ day: r.day, available: r.available, validated: r.validated, received: r.received, eligible: r.rows.length })),
    failed_days: failed,
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
  if (days.length > 31) return json({ ok: false, message: "Consulte no máximo 31 dias por vez." }, 400);

  try {
    const successful: any[] = [];
    const failed: { day: string; message: string }[] = [];
    const concurrency = 3;

    for (let i = 0; i < days.length; i += concurrency) {
      const batch = days.slice(i, i + concurrency);
      const settled = await Promise.allSettled(batch.map((day) => ediDay(user, token, day)));

      settled.forEach((item, index) => {
        const day = batch[index];
        if (item.status === "fulfilled") successful.push(item.value);
        else failed.push({ day, message: String(item.reason?.message || item.reason || "Falha EDI").slice(0, 160) });
      });
    }

    if (!successful.length) {
      return json({
        ok: false,
        message: failed[0]?.message || "Nenhum dia do período pôde ser consultado.",
        range: { from, to },
        failed_days: failed,
      }, 502);
    }

    const summaries = successful.map((r) => summarize(r.rows));
    const summary = mergeSummaries(summaries);

    // Mantém a resposta mensal leve: só as linhas mais úteis para auditoria.
    const auditRows = successful
      .flatMap((r) => r.rows)
      .sort((a: any, b: any) => {
        const ad = Math.abs(Number(a.difference_amount ?? -1));
        const bd = Math.abs(Number(b.difference_amount ?? -1));
        if (bd !== ad) return bd - ad;
        return String(b.occurred_at).localeCompare(String(a.occurred_at));
      })
      .slice(0, 500);

    return json({
      ok: true,
      partial: failed.length > 0,
      source: "PAGBANK_EDI_DIRECT",
      range: { from, to },
      summary,
      rows: auditRows,
      rows_mode: days.length > 1 ? "TOP_500_AUDITORIA" : "DIA_COMPLETO_ATE_500",
      edi_days: successful.map((r) => ({
        day: r.day,
        available: r.available,
        validated: r.validated,
        received: r.received,
        eligible: r.rows.length,
      })),
      failed_days: failed,
    });
  } catch (error) {
    return json({ ok: false, message: (error instanceof Error ? error.message : String(error)).slice(0, 250) }, 502);
  }
});
