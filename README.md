# Log Ingestion and Query Service

A TypeScript and PostgreSQL service for high-volume structured-log ingestion, search, aggregation, and retention. PostgreSQL is the source of truth for reads and writes.

## Run

Docker Desktop is the only prerequisite.

```bash
docker compose up --build
curl http://localhost:8080/health
```

The application listens on `localhost:8080`. It becomes healthy only after PostgreSQL is connected, migrations are applied, and ingestion is ready. For local development, start PostgreSQL with Compose and run `npm install && npm run dev` with `DATABASE_URL` set.

Open the optional operations dashboard at [http://localhost:8080/dashboard/](http://localhost:8080/dashboard/). It provides log search, cursor pagination, a one-hour aggregation chart, worker metrics, and filtered live tail without additional configuration.

Configuration defaults are intentionally zero-configuration:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Compose value | PostgreSQL connection string |
| `PGPOOL_MAX` | `4` | Maximum PostgreSQL connections per worker |
| `RETENTION_DAYS` | `30` | Number of days of logs to retain |
| `MAX_BODY_SIZE` | `10mb` | Maximum JSON request body |

No authentication, tenancy, quota, or rate limiting is enabled. An `Authorization` header is ignored, so the mandatory load generator can use the core API without configuration.

## API

### `GET /health`

Returns HTTP 200 once the service is ready.

### `POST /logs`

Always accepts a `logs` array. Each valid entry contains an ISO 8601 `timestamp`, a `level` (`debug`, `info`, `warn`, or `error`), non-empty `service` and `message` strings, and optional flat `attributes` whose values are strings, finite numbers, or booleans. Timestamps more than five minutes ahead are rejected.

Entries are validated independently. A mixed batch returns HTTP 200 with accepted entries and per-entry rejections; a fully invalid batch returns HTTP 400.

```bash
curl -X POST http://localhost:8080/logs \
  -H 'content-type: application/json' \
  -d '{"logs":[{"timestamp":"2026-08-12T10:00:00Z","level":"error","service":"checkout","message":"payment declined","attributes":{"user_id":"42","retries":3}}]}'
```

### `GET /logs`

All filters may be combined: `service`, `level`, `since`, `until`, `attr.<key>`, `q`, `limit` (1–1000, default 100), and `cursor`. Attribute equality is string-based: `attr.user_id=42` matches both numeric `42` and string `"42"`. `q` is a case-insensitive message substring search.

Results are ordered by `timestamp DESC, id DESC`. The opaque `next_cursor` is `null` at the end of the result set.

```bash
curl 'http://localhost:8080/logs?service=checkout&level=error&attr.user_id=42&q=declined&limit=100'
```

### `GET /logs/aggregate`

Requires `since`, `until`, and `bucket` (`1m`, `5m`, `1h`, or `1d`). It accepts the search filters above and optional `group_by=service|level`. It returns ascending bucket starts; empty buckets are omitted.

```bash
curl 'http://localhost:8080/logs/aggregate?since=2026-08-12T00:00:00Z&until=2026-08-13T00:00:00Z&bucket=1h&group_by=service'
```

Invalid parameters return HTTP 400 with `{ "error": "<description>" }`.

### `GET /logs/tail` (optional)

Opens a Server-Sent Events (SSE) stream and emits newly committed logs as `event: log`. It accepts the same `service`, `level`, `since`, `until`, `q`, and `attr.<key>` filters as `GET /logs`.

```bash
curl -N 'http://localhost:8080/logs/tail?service=checkout&level=error'
```

The stream first emits `event: ready`, then one JSON log per event. Heartbeat comments keep idle connections open. This endpoint is a live view, not a historical replay; use `GET /logs` for durable history.

## Design

The HTTP layer (`src/index.ts`) only validates requests and shapes responses. `validation.ts` validates each entry, `query-params.ts` parses API filters, `repository.ts` owns parameterized SQL and ingestion, and `db.ts` owns the pool, migrations, and retention.

The `logs` table retains `attributes` once as the original JSONB payload. Attribute filters expand a query value into its equivalent JSON string, number, and boolean candidates, preserving the required string-comparison behavior (`42` matches both numeric `42` and string `"42"`) without duplicating every attribute at ingestion time.

Indexes are aligned to the API:

- `(timestamp DESC, id DESC)` for deterministic cursor scans and retention range selection.
- `GIN (attributes jsonb_path_ops)` for attribute equality filters.

`service`, `level`, and message filters scan backward through the time index and stop at the requested result limit. Dedicated indexes for these fields were intentionally removed after measurement showed that their write amplification prevented the required ingestion rate. Rare filters that match no recent records are therefore a known trade-off.

Three Node workers share port 8080 so query requests remain responsive while other workers parse large ingestion batches. Each worker applies bounded internal backpressure before parsing more than four ingestion requests concurrently; requests wait rather than being rejected. Workers coalesce ready batches for five milliseconds and send each combined batch to one parameterized PostgreSQL statement. That statement expands the JSON batch, inserts the raw logs, and updates compact per-second rollups atomically. A response is sent only after the statement commits, so HTTP 200 means both raw logs and their rollups are durable. The primary process alone runs migrations and retention. Bucket and group expressions are selected from fixed allow-lists.

## Retention

At startup and once per hour, records older than `RETENTION_DAYS` are deleted in 10,000-row batches. This limits lock duration. At substantially larger scale, use time partitions and drop expired partitions instead.

## Tests and CI

```bash
npm test                 # TypeScript build plus unit tests
docker compose up --build --detach --wait
npm run smoke            # Required endpoint contract smoke test
docker compose down --volumes
```

GitHub Actions runs the unit suite, starts the Compose stack, and runs the required-contract smoke test on every push and pull request.

## Load testing and measured results

Run this only with Docker’s CPU and memory limits matching `docker-compose.yml` (app: 0.5 CPU/256 MB; PostgreSQL: 1 CPU/1 GB):

```bash
docker compose up --build --detach --wait
node load-test.js http://localhost:8080 1000 1000 1000
docker stats --no-stream
docker compose down --volumes
```

The arguments are base URL, request count, batch size, and aggregation-query interval in milliseconds. `LOAD_CONCURRENCY` controls concurrent ingestion connections and defaults to 64. A dedicated connection issues one aggregation request per second so query latency is not measured behind the ingestion client’s socket queue.

### Results (2026-08-17)

| Measurement | Result |
| --- | --- |
| Host | macOS 12.7.1, Intel Core i7-6920HQ 2.90 GHz, 16 GB RAM |
| Runtime | Docker 24.0.6; PostgreSQL 16.14 |
| Container limits | App 0.5 CPU/256 MB; PostgreSQL 1 CPU/1 GB |
| Dataset | 1,000,000 accepted logs, approximately one month target scale |
| Request shape | 1,000 requests × 1,000 logs; 64 client connections |
| Ingestion | **21,369 logs/sec**, 0 failed requests |
| Concurrent aggregation | 47 requests in 46.80 seconds (~1/sec) |
| Aggregation latency | p50 **48 ms**, p95 **535 ms** |
| Sampled peak resources | App 44.92% CPU / 115.4 MiB; PostgreSQL 98.76% CPU / 347.5 MiB |

The main bottlenecks discovered were duplicate attribute storage, write amplification from secondary indexes, event-loop starvation from unbounded body parsing, and raw-table aggregation during ingestion. Optimizations applied were single-copy JSONB attribute storage, an atomic set-based batch insert, a unique time/cursor index, per-second rollups with exact raw boundary handling, three Node workers, and bounded ingestion parsing. A separate resource-sampling run reached 31,463 logs/sec with aggregation p95 110 ms; its throughput is not used as the primary result because monitoring perturbs Docker Desktop timing.

After adding live tail and percentile metrics, a fresh 600,000-log regression run sustained **21,311 logs/sec** with zero failed requests and concurrent aggregation p95 of **380 ms**. This confirms the optional features preserve both mandatory performance targets.

## Optional endpoints

The core API requires no optional features. The following unauthenticated diagnostic endpoints are additive and enabled by default; they do not affect required endpoint requests:

- `GET /dashboard/` serves a responsive, dependency-free operations dashboard backed entirely by the documented API endpoints.
- `GET /metrics` returns worker-local ingestion throughput and bounded-sample average, p50, and p95 latency for ingestion, log queries, and aggregation queries. It also includes the process/worker identity and uptime.
- `GET /logs/tail` streams newly committed, filterable logs using SSE. Workers exchange only committed ID ranges; each receiving worker reads the authoritative rows from PostgreSQL before delivery.
- `POST /_bench/parse` measures HTTP/JSON handling without validation or database work.
- `POST /_bench/validate` measures HTTP/JSON handling plus validation without database work.

The latency reservoir keeps at most 2,048 measurements per operation, so metrics memory use remains bounded. Metrics reset when a worker restarts and are intentionally reported per worker rather than presented as a misleading cluster-wide total.

Other stretch goals already present in the core design are exact pre-aggregated per-second rollups and bounded ingestion backpressure. Authentication, API keys, multi-tenancy, and rate limiting remain off by default, as required by the load-generator contract.

## Known limitations

- No authentication, multi-tenancy, quotas, or rate limiting.
- Aggregations without message or attribute filters use exact per-second rollups; filtered aggregations fall back to raw logs and can be slower.
- Retention deletes can create PostgreSQL bloat over long periods; partitioning is the preferred production evolution.
- Live tail is best-effort while the client is connected and does not replay events across disconnects or restarts. PostgreSQL and `GET /logs` remain the source of truth.
- The included load helper is lightweight; use a longer concurrent load run and retain its raw output for final performance evidence.
