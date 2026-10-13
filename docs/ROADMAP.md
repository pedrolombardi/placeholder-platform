# Roadmap — até o MVP final (Fase 7)

## Já implementado

| Parte | Entregue |
|---|---|
| Plataforma | `docker compose up` com todos os serviços e o front; e2e no CI (push e diário) |
| Front-end | Assistente de migração real (análise → homologação → execução → resultado), Projetos e Auditoria reais; demais telas como protótipo navegável |
| Backend Core | Máquina de estados, homologação com decisão humana obrigatória para DEFER, auditoria, retries e timeouts, tradução dos contratos reais |
| DB Layer | Catálogos, diff classificado (mecânico × julgamento), tools de evidência com LGPD, extração da amostra, validação no SANDBOX, script de migração |
| AI Layer | PROPOSE/DEFER com evidência real das tools do DB Layer; chat com Gemini/OpenAI |
| Data Layer | Anonimização estatisticamente fiel (distribuição, FKs, anomalias) com relatório de conformidade |

## Fase 7 — prioridades

| Prio | Entrega | Parte |
|---|---|---|
| P1 | **Autenticação e perfis** (login real, RBAC: DBA × dev/QA) e autenticação entre serviços | Front, Core |
| P1 | **Credenciais por migração** (conectar no banco informado na tela) guardadas em cofre de segredos | Core, DB Layer |
| P1 | **Execução assistida do script** no destino, com carga dos dados e verificação pós-carga | DB Layer, Core |
| P1 | **IA generalizada**: escolher tools e regras pelo `rules` do diff; modelo com saída estruturada | AI Layer |
| P1 | **Um sandbox por migração** (validações em paralelo) | DB Layer |
| P2 | Amostragem estratificada e com limite de tempo; cache de catálogo | DB Layer |
| P2 | Testes automatizados e CI na AI Layer, no Core e no front | AI Layer, Core, Front |
| P2 | Dashboard e relatórios com dados reais; sandbox disponível para dev/QA | Front, Data Layer |
| P3 | Adaptador PostgreSQL (origem e destino) | DB Layer |
| P3 | Observabilidade: logs estruturados e métricas por etapa | Todos |
