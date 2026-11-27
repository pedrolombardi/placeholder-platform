/**
 * Teste ponta a ponta da plataforma pela API do Backend Core (Node 18+, sem dependências):
 * criar -> analisar -> homologar os DEFER -> executar -> COMPLETED com o plano
 * validado no sandbox e o script de migração gerado. Falha com exit code 1.
 *
 *   BASE_URL=http://localhost:3000 node scripts/e2e.mjs
 */
const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
// Com AUTH_ENABLED=true no Core, o fluxo roda autenticado como DBA (homologa e executa).
const E2E_USER = process.env.E2E_USER ?? 'dba';
const E2E_PASSWORD = process.env.E2E_PASSWORD ?? 'dba123';
let token = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, body) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
  return data;
}

async function waitWhile(id, busy) {
  for (let i = 0; i < 120; i++) {
    const m = await call('GET', `/migrations/${id}`);
    if (!busy.includes(m.status)) return m;
    await sleep(1000);
  }
  throw new Error(`migração ${id} não saiu de ${busy.join('/')}`);
}

function expect(cond, msg) {
  if (!cond) throw new Error(`FALHOU: ${msg}`);
  console.log(`  ok  ${msg}`);
}

// espera o Core aceitar conexoes (o compose so garante que o container subiu)
let health;
for (let i = 0; ; i++) {
  try { health = await call('GET', '/health'); break; } catch (e) { if (i >= 60) throw e; await sleep(1000); }
}
if (health.auth) {
  // sem token o Core recusa; perfil sem permissão de homologar recebe 403
  const anon = await fetch(BASE + '/migrations');
  expect(anon.status === 401, 'Core exige autenticação (401 sem token)');
  token = (await call('POST', '/auth/login', { username: E2E_USER, password: E2E_PASSWORD })).token;
  const me = await call('GET', '/auth/me');
  expect(me.user?.role === 'DBA', `login como ${E2E_USER} (perfil DBA)`);
}

const created = await call('POST', '/migrations', {
  name: 'e2e vendas',
  source: { type: 'mysql', host: 'mysql', database: 'vendas', user: 'readonly', password: 'readonly' },
  target: { type: 'oracle' },
});
console.log(`migração ${created.id}`);

await call('POST', `/migrations/${created.id}/analyze`);
let m = await waitWhile(created.id, ['CREATED', 'ANALYZING']);
console.log(`análise: ${m.proposal?.summary ?? m.error}`);
expect(m.status === 'WAITING_APPROVAL', 'análise termina aguardando homologação');
const byId = Object.fromEntries(m.proposal.conflicts.map((c) => [c.id, c]));
expect(m.proposal.conflicts.length === 20, '20 colunas classificadas');
expect(m.proposal.conflicts.filter((c) => c.decidedBy === 'rule').length === 15, '15 resolvidas por regra (DB Layer)');
expect(byId['clientes.email'].decidedBy === 'ai' && /VARCHAR2\(300 CHAR\)/.test(byId['clientes.email'].resolution), 'clientes.email: IA propõe VARCHAR2(300 CHAR) com evidência real');
expect(byId['clientes.ativo'].status === 'DEFERRED', 'clientes.ativo: IA devolve DEFER (valores 0, 1 e 2)');

const decisions = m.proposal.conflicts
  .filter((c) => c.status === 'DEFERRED')
  .map((c) => ({ conflictId: c.id, resolution: 'Converter para NULL e registrar no relatório (decisão do DBA)' }));
if (health.auth && process.env.E2E_QA_USER !== '') {
  // perfil DEV_QA analisa e consulta, mas não homologa
  const qa = await call('POST', '/auth/login', { username: process.env.E2E_QA_USER ?? 'qa', password: process.env.E2E_QA_PASSWORD ?? 'qa123' });
  const denied = await fetch(`${BASE}/migrations/${created.id}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${qa.token}` },
    body: JSON.stringify({ decisions }),
  });
  expect(denied.status === 403, 'perfil DEV_QA não pode homologar (403)');
}
await call('POST', `/migrations/${created.id}/approve`, { decisions });
await call('POST', `/migrations/${created.id}/execute`);
m = await waitWhile(created.id, ['APPROVED', 'EXECUTING', 'VALIDATING']);
console.log(`execução: ${m.status}${m.error ? ` (${m.error})` : ''}`);
for (const c of m.result?.validation?.checks ?? []) console.log(`    ${c.passed ? '✓' : '✕'} ${c.name}: ${c.detail ?? ''}`);
expect(m.status === 'COMPLETED', 'migração COMPLETED');
expect(m.result.sandbox.verdict === 'pass', 'Data Layer: anonimização aprovada (leakage/referential)');
expect(m.result.validation.checks.length === 5 && m.result.validation.checks.every((c) => c.passed), '5 verificações do sandbox aprovadas');
expect(/MODIFY \("EMAIL" VARCHAR2\(300 CHAR\)\)/.test(m.result.apply.script), 'script amplia EMAIL para VARCHAR2(300 CHAR)');
expect(/MODIFY \("CRIADO_EM" NULL\)/.test(m.result.apply.script), 'script aceita NULL em PEDIDOS.CRIADO_EM (decisão humana sobre a data zero)');

const rawEvents = await call('GET', `/migrations/${created.id}/events`);
const events = rawEvents.map((e) => e.type);
if (health.auth) expect(rawEvents.some((e) => e.type === 'PROPOSAL_APPROVED' && e.actor === E2E_USER), `auditoria registra o autor da homologação (${E2E_USER})`);
expect(['PROPOSAL_CREATED', 'PROPOSAL_APPROVED', 'SANDBOX_READY', 'PLAN_VALIDATED', 'PLAN_SCRIPT_READY', 'MIGRATION_COMPLETED'].every((t) => events.includes(t)), 'trilha de auditoria completa');
console.log('\nE2E OK');
