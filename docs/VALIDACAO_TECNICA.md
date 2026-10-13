# Relatório de validação técnica — plataforma

Validado rodando a plataforma inteira do zero (`docker compose up --build`), com os 5 serviços
reais e bancos reais (MySQL 8, Oracle 23ai, PostgreSQL 16). O detalhe do DB Layer está em
`placeholder-db-layer/docs/VALIDACAO_TECNICA.md`.

## 1. Viabilidade técnica

**Viável e demonstrado.** O fluxo completo roda real e é verificado no CI:

| Etapa | Resultado com o banco de demonstração |
|---|---|
| Análise | 20 colunas: **15 resolvidas por regra** (DB Layer), 5 de julgamento |
| IA | `clientes.email` → **PROPOSE** `VARCHAR2(300 CHAR)`, com evidência real (2 de 10 acima de 200 bytes, máx. 226); `clientes.ativo` → **DEFER** (valores 0, 1 e 2) |
| Homologação | o DBA decide os 4 DEFER; sem decisão a aprovação é recusada (422) |
| Sandbox | DB Layer extrai 10/6/4 linhas; o Data Layer anonimiza (leakage, referential e linkage aprovados) |
| Validação | 5 verificações no SANDBOX do Oracle: linhas, truncamento, FKs, precisão/escala e nulos |
| Resultado | script de migração (ampliar `EMAIL`, aceitar NULL em `CRIADO_EM`, ressincronizar IDENTITY) e trilha de auditoria |

Prints: [`prints/`](prints/). Teste automatizado: `scripts/e2e.mjs` (CI: `.github/workflows/e2e.yml`).

## 2. Desafios de implementação (encontrados na integração)

| Desafio | Como apareceu | Solução |
|---|---|---|
| Contratos diferentes entre as partes | Cada parte supôs o formato da outra: o Core chamava `/ai/chat` e `/anonymize`; a IA expõe `/ai/analyze-conflict` e o Data Layer `/v1/anonymize` | O Core traduz para os contratos reais; o DB Layer aceita o formato do Core sem perder o seu; testes de contrato nos dois lados |
| Ninguém entregava linhas ao Data Layer | O Data Layer só recebe linhas; o Core mandava credenciais | O DB Layer (único com leitura na origem) extrai a amostra já no formato do Data Layer |
| A anonimização muda o dado | E-mails pseudonimizados mudam de tamanho; decimais são perturbados; datas eram mascaradas | O truncamento é medido na origem; decimais voltam à escala da origem; datas, ENUM e flags vão preservadas |
| Mock contradizendo o dado real | O mock da IA propunha `ativo` como booleano, mas o dado real tem o valor 2 | A IA real dá DEFER com a evidência do DB Layer; o e2e exige isso |
| Primeiro DDL no Oracle levava ~13 s | A primeira validação estourava o timeout do Core | Sandbox aquecido no boot do DB Layer |
| Erro sem explicação | Origem recusada aparecia como "HTTP 400" | O Core repassa o motivo dado pelo layer |
| Ambiente Windows | Scripts com sintaxe Unix (`FAIL=ai ...`) | Scripts em Node, que funcionam em qualquer sistema |

## 3. Riscos técnicos

| Risco | Impacto | Situação |
|---|---|---|
| Escrita na origem ou no destino | Crítico | ✅ origem com `GRANT SELECT` + guarda no adaptador; escrita só no schema SANDBOX; script não executado |
| SQL vindo da IA ou de texto livre | Crítico | ✅ a IA não envia SQL; identificadores validados contra o catálogo; tipo planejado reconstruído, nunca copiado |
| Dado pessoal chegando ao LLM | Alto | ✅ `sample-values` mascara colunas de alta cardinalidade |
| Sem autenticação (front e API) | Alto | ⏳ Fase 7. Mitigação: portas só em `127.0.0.1` |
| Credenciais da origem em texto no PostgreSQL do Core | Alto em produção | ⏳ Fase 7 (cofre de segredos) |
| Regras da IA calibradas para os conflitos de demonstração | Médio | ⚠️ conflito novo de julgamento vira DEFER (seguro); generalizar na Fase 7 |
| Contratos entre repositórios divergirem | Médio | ✅ testes de contrato + e2e no CI (push e diário) |
| AI Layer e front sem testes automatizados | Médio | ⚠️ cobertos só pelo e2e |

## 4. Gargalos de performance e arquitetura

1. **Validação serializada** (uma por vez por schema SANDBOX) → sandbox por migração.
2. **Leitura da tabela inteira** nos probes da análise → amostragem com limite de tempo.
3. **Catálogo relido a cada chamada** de tool → cache com expiração.
4. **Amostra de 1.000 linhas por PK** → amostragem estratificada.

Medido no ambiente local: análise da IA 30–60 ms por conflito; diff 17 ms; validação no sandbox
~0,6 s.

## 5. Ajustes na arquitetura

- O DB Layer passou a **extrair a amostra** para o Data Layer e a **validar no sandbox**; antes,
  o desenho previa só leitura e um `/plan/apply` que escreveria no destino.
- `/plan/apply` virou **geração de script**; aplicar é um passo do DBA.
- O Core passou a **traduzir** os contratos reais da IA e do Data Layer.
- Nasceu este repositório de **plataforma**, com o e2e no CI.
