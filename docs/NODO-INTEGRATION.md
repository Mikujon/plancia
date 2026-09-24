# Collegare Plancia a Nodo

Plancia è un **sistema interno con forma tutta nostra** (caso 1 di
`ADATTATORI`, come Matrix o il WFM): il contratto esiste già ed è collaudato,
quindi non serve un `domande/ops/` da mandare a nessuno.

## Il contratto

- File: [`server/contracts/ops.v1.ts`](../server/contracts/ops.v1.ts) — importa solo `zod`,
  si copia **così com'è** in Nodo come `src/contracts/ops.v1.ts`.
- Versione nel nome del metodo: `ops.v1.list_issues`, costante `OPS_CONTRACT_VERSION`.
- Cursore opaco (`next_cursor`), `observed_at` su ogni risposta, limiti in `OPS_LIMITS`
  (200 voci per pagina, 92 giorni di intervallo massimo).
- Errori: `OPS-400-INPUT`, `OPS-401-AUTH`, `OPS-404-NOT_FOUND`, `OPS-409-CONFLICT`,
  `OPS-500-INTERNAL`. Il corpo non contiene mai dati di persone né dettagli interni.
- Plancia valida ogni risposta contro lo schema prima di mandarla: una risposta fuori
  contratto non esce (diventa `OPS-500-INTERNAL`).
- Autenticazione: `Authorization: Bearer <token>`, token in `PLANCIA_API_TOKENS`.
- Manifesto senza token: `GET /api/ops/v1/manifest`.

| Metodo | HTTP | Per che cosa in Nodo |
|---|---|---|
| `ops.v1.list_campaigns` | `GET /api/ops/v1/campaigns` | campagne, clienti, team |
| `ops.v1.list_issues` | `GET /api/ops/v1/issues` | sincronizzazione incrementale con `updated_since` |
| `ops.v1.get_issue` | `GET /api/ops/v1/issues/:id` | catena dei responsabili + eventi, per il report end-to-end |
| `ops.v1.create_issue` | `POST /api/ops/v1/issues` | aprire un problema da Nodo (`external_ref` evita i doppioni: 409) |
| `ops.v1.list_staffing` | `GET /api/ops/v1/staffing` | organico in tempo reale e costo dei buchi |
| `ops.v1.cost_rollup` | `GET /api/ops/v1/cost-rollup` | margine e rischio per campagna |
| `ops.v1.list_handovers` | `GET /api/ops/v1/handovers` | passaggi di turno |

## Le sette parti in Nodo

```
node scripts/nuovo-connettore.mjs ops "Plancia — Ops"
```

| # | File in Nodo | Che cosa metterci |
|---|---|---|
| 1 | `src/contracts/ops.v1.ts` | **copia** di `server/contracts/ops.v1.ts` al posto del segnaposto `Elemento` |
| 2 | `src/ports/ops.ts` | un metodo per voce di `OPS_METHODS` |
| 3 | `src/adapters/ops/mock.ts` | deterministico, `now?: () => Date` come `MockMatrixAdapter` |
| 4 | `src/adapters/ops/http.ts` | `Bearer` da `OPS_TOKEN`, base da `OPS_BASE_URL`; solo lo stato HTTP esce, mai il corpo |
| 5 | `src/adapters/ops/traduzione.ts` | **passa la risposta così com'è**: Plancia parla già `ops.v1` |
| 6 | `tests/helpers/conformita-ops.ts` | parti da [`tests/conformita-ops.ts`](../tests/conformita-ops.ts): stesse prove, già scritte contro un `fetch` qualsiasi |
| 7 | `tests/ops-connettore.test.ts` | il kit sul finto e sull'HTTP (contro un Plancia avviato in locale) |

Poi i passi manuali (sezione 4 di `ADATTATORI`), solo quando c'è una schermata vera:

- **Permessi** da aggiungere all'elenco chiuso 9.4: `ops:issues:read`, `ops:issues:write`,
  `ops:staffing:read`, `ops:cost:read`, `ops:handovers:read`. Il perimetro per ruolo
  (TL piano, FM piani, CSDM cliente, COO tutto) lo applica il modulo di dominio di Nodo:
  il token di Plancia vede tutto, come ogni connettore.
- **Hub**: una voce in `STRUMENTI[]` per metodo.
- **Cablaggio**: `opsAdapter()` in `src/server/deps.ts`, HTTP se `OPS_BASE_URL` è impostata,
  finto altrimenti (copia `coralyAdapter()`).

## Provare il contratto contro un Plancia vero

```bash
pnpm dev
curl -H "Authorization: Bearer dev-nodo-token" "http://localhost:8787/api/ops/v1/issues?status=open&limit=5"
```

## Nell'altra direzione (dopo)

Plancia oggi ha il proprio finto WFM/RTA e un `ops_daily` di esempio per ricavi, costo del
lavoro e SLA. Quando Nodo espone Matrix (ore) e il WFM, Plancia li può leggere da Nodo
cambiando solo `server/adapters/wfm/traduzione.ts` e la sorgente di `ops_daily`.
