/**
 * Teste ponta a ponta da plataforma pela API do Backend Core (Node 18+, sem dependências):
 * criar -> analisar -> homologar os DEFER -> executar -> COMPLETED com o plano
 * validado no sandbox e o script de migração gerado. Falha com exit code 1.
 *
 *   BASE_URL=http://localhost:3000 node scripts/e2e.mjs
 */
const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
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
for (let i = 0; ; i++) {
  try { await call('GET', '/migrations'); break; } catch (e) { if (i >= 60) throw e; await sleep(1000); }
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

const events = (await call('GET', `/migrations/${created.id}/events`)).map((e) => e.type);
expect(['PROPOSAL_CREATED', 'PROPOSAL_APPROVED', 'SANDBOX_READY', 'PLAN_VALIDATED', 'PLAN_SCRIPT_READY', 'MIGRATION_COMPLETED'].every((t) => events.includes(t)), 'trilha de auditoria completa');
console.log('\nE2E OK');
