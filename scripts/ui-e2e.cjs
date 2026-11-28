/**
 * Teste ponta a ponta pela interface (Playwright): login real, guarda de rotas, dashboard
 * igual a GET /metrics, migração completa pelo assistente, relatórios + CSV, detalhe,
 * auditoria com autor, conexões (cadastrar, testar, excluir), configurações, perfil, logout
 * e o perfil DEV_QA sem homologação. Falha com exit code 1.
 *
 *   npm i -D playwright && npx playwright install chromium
 *   FRONT_URL=http://localhost:8080 node scripts/ui-e2e.cjs
 */
const { chromium } = require('playwright');
const fs = require('fs');
const BASE = process.env.FRONT_URL ?? 'http://localhost:8080';
const SHOTS = process.env.SHOTS_DIR ?? require('path').join(__dirname, '..', 'docs', 'prints', 'ui-e2e') + '/';
require('fs').mkdirSync(SHOTS, { recursive: true });
const results = [];
const step = async (name, fn) => {
  try { const info = await fn(); results.push(['PASS', name, info ?? '']); console.log('PASS', name, info ?? ''); }
  catch (e) { results.push(['FAIL', name, e.message.split('\n')[0]]); console.log('FAIL', name, e.message.split('\n')[0]); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1366, height: 900 }, acceptDownloads: true });
  const p = await ctx.newPage();
  const errors = [], expected = [];
  // 401 do login com senha errada e 404 das rotas que este Core ainda nao tem sao esperados.
  const EXPECTED = [[401, /\/api\/auth\/login$/], [403, /\/api\/migrations\/[^/]+\/approve$/]];
  const failed = new Map();
  p.on('response', (r) => { if (r.status() >= 400) failed.set(r.url(), r.status()); });
  p.on('console', (m) => {
    if (m.type() !== 'error') return;
    const url = m.location()?.url ?? '';
    const st = failed.get(url);
    if (EXPECTED.some(([s, re]) => s === st && re.test(url))) expected.push(`${st} ${url.replace(BASE, '')}`);
    else errors.push(`${m.text()} @ ${url}`);
  });
  p.on('pageerror', (e) => errors.push('pageerror: ' + e));
  const shot = (n) => p.screenshot({ path: `${SHOTS}new-${n}.png`, fullPage: true });
  const btn = (re) => p.getByRole('button', { name: re });
  const token = () => p.evaluate(() => JSON.parse(localStorage.getItem('placeholder.session')).token);
  const apiGet = async (path) => { const t = await token(); return p.evaluate(async ([path, t]) => (await fetch('/api' + path, { headers: { authorization: 'Bearer ' + t } })).json(), [path, t]); };
  const login = async (u, pw) => {
    await p.goto(BASE + '/login');
    await p.fill('input[name=username]', u); await p.fill('input[name=password]', pw);
    await btn(/^Entrar$/).click();
  };
  const name = `E2E front ${new Date().toISOString().slice(11, 19)}`;
  let migrationId;

  await step('logged out: /app/dashboard redirects to /login', async () => {
    await p.goto(BASE + '/app/dashboard'); await p.waitForURL(/\/login$/, { timeout: 5000 }); await shot('01-redirect-login');
  });
  await step('wrong password shows error', async () => {
    await login('dba', 'errada'); const a = p.getByRole('alert'); await a.waitFor({ timeout: 5000 });
    const t = await a.innerText(); assert(/Usuário ou senha inválidos/.test(t), t); await shot('02-wrong-password'); return t.trim();
  });
  await step('login as dba lands on dashboard', async () => {
    await login('dba', 'dba123'); await p.waitForURL(/\/app\/dashboard$/, { timeout: 5000 });
    await p.getByText('Olá, dba').waitFor({ timeout: 5000 });
    const chip = await p.locator('.user-chip').innerText(); assert(/dba/.test(chip) && /DBA/.test(chip), chip);
  });
  await step('dashboard numbers match GET /metrics', async () => {
    await p.locator('[data-testid=metrics] strong').first().waitFor();
    const shown = await p.locator('[data-testid=metrics] strong').allInnerTexts();
    const m = await apiGet('/metrics');
    const rate = m.migrations.successRate == null ? '—' : `${(m.migrations.successRate * 100).toFixed(1).replace('.', ',').replace(',0', '')}%`;
    const exp = [String(m.migrations.total), String(m.migrations.inProgress), String(m.migrations.byStatus.COMPLETED), rate];
    assert(JSON.stringify(shown) === JSON.stringify(exp), `shown ${shown} expected ${exp}`);
    const donut = await p.locator('.donut__circle strong').innerText(); assert(donut === String(m.conflicts.total), `donut ${donut}`);
    await shot('03-dashboard'); return `shown=${shown.join('/')} conflicts=${donut}`;
  });
  await step('wizard: full migration to COMPLETED', async () => {
    await p.goto(BASE + '/app/migration/new');
    const nameInput = p.locator('label:has-text("Nome da migração") input'); await nameInput.fill(name);
    await shot('04-wizard-source');
    await btn(/Continuar/).click(); await btn(/Analisar migração/).click();
    await p.locator('h2', { hasText: 'Análise' }).waitFor({ timeout: 120000 }); await shot('05-wizard-analysis');
    await btn(/Continuar/).click(); await btn(/Continuar/).click();
    await p.locator('h2', { hasText: 'Homologação' }).waitFor();
    const areas = p.locator('textarea'); const n = await areas.count();
    for (let i = 0; i < n; i++) await areas.nth(i).fill('Converter para NULL e registrar no relatório');
    await shot('06-wizard-approval');
    await btn(/Aprovar e executar/).click();
    await btn(/Nova migração/).waitFor({ timeout: 180000 }); await shot('07-wizard-result');
    const body = await p.locator('.migration-body').innerText();
    assert(/Plano validado no sandbox/.test(body), 'no success hero: ' + body.slice(0, 300));
    const href = await p.getByRole('link', { name: 'Ver detalhes' }).getAttribute('href'); migrationId = href.split('/').pop();
    const m = await apiGet('/migrations/' + migrationId); assert(m.status === 'COMPLETED', m.status);
    return `${n} DEFER decisions, id ${migrationId.slice(0, 8)}, status ${m.status}`;
  });
  await step('reports: rows + CSV export', async () => {
    await p.goto(BASE + '/app/reports'); await p.locator('tbody tr').first().waitFor({ timeout: 10000 });
    const rows = await p.locator('tbody tr').count();
    const [dl] = await Promise.all([p.waitForEvent('download'), btn(/Exportar CSV/).click()]);
    const file = SHOTS + 'new-report.csv'; await dl.saveAs(file);
    const csv = fs.readFileSync(file, 'utf8'); const lines = csv.trim().split(/\r?\n/);
    assert(lines[0].includes('Migração;Finalizada em'), lines[0]); assert(csv.includes(name), 'csv lacks new migration');
    assert(lines.length - 1 === rows, `csv ${lines.length - 1} rows vs table ${rows}`);
    await shot('08-reports'); return `${rows} rows, ${dl.suggestedFilename()}`;
  });
  await step('reports: Visualizar opens detail page', async () => {
    await p.locator('tr', { hasText: name }).getByRole('button', { name: 'Visualizar' }).click();
    await p.waitForURL(new RegExp(`/app/migrations/${migrationId}$`));
    await p.getByText('Trilha de auditoria').waitFor(); await p.getByText(/Verificações no sandbox \(\d+\/\d+/).waitFor();
    await p.getByRole('heading', { name: 'Script de migração' }).waitFor();
    const [dl] = await Promise.all([p.waitForEvent('download'), btn(/Baixar script/).click()]);
    await shot('09-detail'); return `script download ${dl.suggestedFilename()}`;
  });
  await step('projects card links to detail; topbar search filters', async () => {
    await p.fill('input[aria-label="Buscar migrações"]', name); await p.keyboard.press('Enter');
    await p.waitForURL(/\/app\/projects\?q=/); await p.locator('a.project-card').first().waitFor();
    const cards = await p.locator('a.project-card').count(); assert(cards === 1, `${cards} cards`);
    await p.locator('a.project-card').first().click(); await p.waitForURL(new RegExp(`/app/migrations/${migrationId}$`));
  });
  await step('audit shows actor dba, date+time, one row per transition', async () => {
    await p.goto(BASE + '/app/audit'); await p.locator('[data-testid=actor]').first().waitFor({ timeout: 10000 });
    const actors = await p.locator('[data-testid=actor]').allInnerTexts();
    assert(actors.includes('dba'), 'no dba actor: ' + [...new Set(actors)]);
    const rows = await p.locator('.timeline__item', { hasText: name }).allInnerTexts();
    const dup = rows.filter((r) => /Proposta aprovada/.test(r)).length; assert(dup === 1, `approved rows ${dup}`);
    const time = await p.locator('.timeline time').first().innerText(); assert(/\d{2}\/\d{2}\/\d{4}/.test(time), time);
    await shot('10-audit'); return `actors=${[...new Set(actors)].join(',')}; rows for this migration=${rows.length}`;
  });
  await step('connections: live status, add, test, delete (real Core)', async () => {
    await p.goto(BASE + '/app/connections'); await p.getByRole('heading', { name: 'Conexões cadastradas' }).waitFor({ timeout: 10000 });
    const body = await p.locator('main').innerText();
    assert(!/indispon/i.test(body), 'unavailable note shown');
    const connected = await p.getByText('Conectado', { exact: true }).count(); assert(connected >= 2, `connected badges ${connected}`);
    const cname = 'Origem vendas ' + Date.now();
    await p.locator('label:has-text("Nome") input').fill(cname);
    await p.locator('label:has-text("Host") input').fill('mysql');
    await p.locator('label:has-text("Database") input').fill('vendas');
    await p.getByRole('button', { name: 'Cadastrar conexão' }).click();
    const row = p.locator('tr', { hasText: cname }); await row.waitFor({ timeout: 10000 });
    await row.getByRole('button', { name: 'Testar' }).click(); await p.waitForTimeout(1500);
    const rowText = await row.innerText(); await shot('11-connections');
    p.once('dialog', (d) => d.accept()); await row.getByRole('button', { name: 'Excluir' }).click();
    await row.waitFor({ state: 'detached', timeout: 10000 });
    return `live: ${connected} connected; saved+tested+deleted; row after test: ${rowText.replace(/\s+/g, ' ').slice(0, 140)}`;
  });
  await step('settings: three layers from GET /settings', async () => {
    await p.goto(BASE + '/app/settings'); await p.getByRole('heading', { name: 'Camadas' }).waitFor({ timeout: 10000 });
    const ok = await p.getByText('Saudável', { exact: true }).count(); await shot('12-settings');
    assert(ok === 3, `healthy layers ${ok}`); return `${ok}/3 layers healthy`;
  });
  await step('profile shows real user', async () => {
    await p.goto(BASE + '/app/profile'); const t = await p.locator('.page').innerText();
    assert(/dba/.test(t) && /Executar migrações aprovadas/.test(t), t.slice(0, 200)); await shot('13-profile');
  });
  await step('logout', async () => {
    await btn(/^Sair$/).click(); await p.waitForURL(/\/login/);
    const s = await p.evaluate(() => localStorage.getItem('placeholder.session')); assert(s === null, 'session left');
    await p.goto(BASE + '/app/reports'); await p.waitForURL(/\/login$/);
  });
  await step('qa: approve/reject/execute not offered', async () => {
    await login('qa', 'qa123'); await p.waitForURL(/\/app\//); // volta para a rota pedida antes do login
    const chip = await p.locator('.user-chip').innerText(); assert(/Dev\/QA/.test(chip), chip);
    await p.goto(BASE + '/app/migration/new'); await p.locator('label:has-text("Nome da migração") input').fill(name + ' (qa)');
    await btn(/Continuar/).click(); await btn(/Analisar migração/).click();
    await p.locator('h2', { hasText: 'Análise' }).waitFor({ timeout: 120000 });
    await btn(/Continuar/).click(); await btn(/Continuar/).click();
    await p.locator('[data-testid=role-restricted]').waitFor();
    const offered = await p.getByRole('button', { name: /Aprovar|Rejeitar|Executar/ }).count();
    assert(offered === 0, `${offered} restricted buttons`);
    const disabled = await p.locator('textarea:disabled').count(); await shot('14-qa-approval');
    await p.getByRole('link', { name: 'Ver migração' }).click(); await p.waitForURL(/\/app\/migrations\//);
    const hom = await p.getByRole('link', { name: 'Homologar no assistente' }).count(); assert(hom === 0, 'homologar offered to qa');
    const id = p.url().split('/').pop();
    const t = await token();
    const r = await p.evaluate(async ([id, t]) => { const res = await fetch(`/api/migrations/${id}/approve`, { method: 'POST', headers: { authorization: 'Bearer ' + t, 'content-type': 'application/json' }, body: '{}' }); return [res.status, (await res.json()).error]; }, [id, t]);
    assert(r[0] === 403, JSON.stringify(r)); await shot('15-qa-detail');
    return `0 restricted buttons, ${disabled} read-only decisions, API approve -> ${r[0]} ${r[1]}`;
  });

  console.log('\nexpected (not counted):', [...new Set(expected)].join(' | ') || 'none');
  console.log('console errors:', errors.length, JSON.stringify(errors));
  results.push([errors.length ? 'FAIL' : 'PASS', 'zero console errors', `${errors.length}`]);
  console.log('\nSUMMARY'); for (const r of results) console.log(r.join(' | '));
  await b.close();
  process.exit(results.some((r) => r[0] === 'FAIL') ? 1 : 0);
})().catch((e) => { console.error('E2E CRASH', e); process.exit(2); });
