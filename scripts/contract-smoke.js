const { close, request: httpRequest } = require('./http-client');
const http = require('node:http');
const https = require('node:https');

const base = process.env.SERVICE_URL ?? 'http://localhost:8080';

async function request(path, options) {
  return httpRequest(`${base}${path}`, options);
}

async function expectStatus(response, status) {
  if (response.status !== status) {
    throw new Error(
      `Expected HTTP ${status}, received ${response.status}: ${await response.text()}`,
    );
  }
}

function verifyLiveTail(service) {
  return new Promise((resolve, reject) => {
    const url = new URL(`/logs/tail?service=${encodeURIComponent(service)}`, base);
    const client = url.protocol === 'https:' ? https : http;
    let buffer = '';
    let posted = false;
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      request.destroy();
      error ? reject(error) : resolve();
    };

    const timeout = setTimeout(
      () => finish(new Error('Timed out waiting for a live-tail log')),
      8_000,
    );

    const request = client.get(url, (response) => {
      if (response.statusCode !== 200) {
        finish(new Error(`Live tail returned HTTP ${response.statusCode}`));
        return;
      }

      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        buffer += chunk;
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';

        for (const frame of frames) {
          if (frame.startsWith('event: ready') && !posted) {
            posted = true;
            void requestLog(service).catch(finish);
          }

          if (frame.startsWith('event: log')) {
            const data = frame.split('\n').find((line) => line.startsWith('data: '));
            const log = data ? JSON.parse(data.slice(6)) : undefined;
            if (log?.service === service && log.message === 'live tail check') {
              finish();
            }
          }
        }
      });
      response.on('error', finish);
    });

    request.on('error', (error) => {
      if (!settled) finish(error);
    });
  });
}

async function requestLog(service) {
  const response = await request('/logs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      logs: [{
        timestamp: new Date().toISOString(),
        level: 'info',
        service,
        message: 'live tail check',
      }],
    }),
  });
  await expectStatus(response, 200);
}

async function main() {
  await expectStatus(await request('/health'), 200);

  const dashboard = await request('/dashboard/');
  await expectStatus(dashboard, 200);
  if (!(await dashboard.text()).includes('Pulseboard')) {
    throw new Error('Dashboard HTML was not served');
  }

  const timestamp = new Date().toISOString();
  const service = `contract-smoke-${process.pid}-${Date.now()}`;
  const ingestion = await request('/logs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      logs: [
        {
          timestamp,
          level: 'error',
          service,
          message: 'payment declined',
          attributes: { user_id: 42, active: true },
        },
        {
          timestamp,
          level: 'error',
          service,
          message: 'payment declined again',
          attributes: { user_id: '42', active: true },
        },
        { timestamp, level: 'critical', service, message: 'invalid' },
      ],
    }),
  });
  await expectStatus(ingestion, 200);
  const ingestionBody = await ingestion.json();
  if (ingestionBody.accepted !== 2 || ingestionBody.rejected?.[0]?.index !== 2) {
    throw new Error(`Unexpected ingestion response: ${JSON.stringify(ingestionBody)}`);
  }

  const logs = await request(`/logs?service=${encodeURIComponent(service)}&attr.user_id=42&q=DECLINED`);
  await expectStatus(logs, 200);
  const logsBody = await logs.json();
  if (logsBody.logs?.length !== 2) {
    throw new Error(`Unexpected query response: ${JSON.stringify(logsBody)}`);
  }

  const aggregate = await request(
    `/logs/aggregate?since=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}&until=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}&bucket=1m&group_by=service`,
  );
  await expectStatus(aggregate, 200);
  const aggregateBody = await aggregate.json();
  if (!aggregateBody.buckets?.some((bucket) => bucket.group === service && bucket.count === 2)) {
    throw new Error(`Unexpected aggregate response: ${JSON.stringify(aggregateBody)}`);
  }

  const invalidQuery = await request('/logs?limit=0');
  await expectStatus(invalidQuery, 400);

  const paginationService = `${service}-pagination`;
  const pagination = await request('/logs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      logs: ['first', 'second', 'third'].map((message) => ({
        timestamp,
        level: 'info',
        service: paginationService,
        message,
      })),
    }),
  });
  await expectStatus(pagination, 200);

  const firstPage = await request(
    `/logs?service=${encodeURIComponent(paginationService)}&limit=2`,
  );
  const firstPageBody = await firstPage.json();
  if (firstPageBody.logs?.length !== 2 || !firstPageBody.next_cursor) {
    throw new Error(`Unexpected first cursor page: ${JSON.stringify(firstPageBody)}`);
  }

  const secondPage = await request(
    `/logs?service=${encodeURIComponent(paginationService)}&limit=2&cursor=${encodeURIComponent(firstPageBody.next_cursor)}`,
  );
  const secondPageBody = await secondPage.json();
  const ids = new Set([
    ...firstPageBody.logs.map((log) => log.id),
    ...secondPageBody.logs.map((log) => log.id),
  ]);
  if (secondPageBody.logs?.length !== 1 || secondPageBody.next_cursor !== null || ids.size !== 3) {
    throw new Error(`Unexpected second cursor page: ${JSON.stringify(secondPageBody)}`);
  }

  const malformed = await request('/logs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  });
  await expectStatus(malformed, 400);

  await verifyLiveTail(`${service}-tail`);

  const metrics = await request('/metrics');
  await expectStatus(metrics, 200);
  const metricsBody = await metrics.json();
  if (
    typeof metricsBody.ingestionLogsPerSecond !== 'number' ||
    typeof metricsBody.ingestionDurationMs?.p95 !== 'number' ||
    typeof metricsBody.queryDurationMs?.logs?.p50 !== 'number'
  ) {
    throw new Error(`Unexpected metrics response: ${JSON.stringify(metricsBody)}`);
  }

  console.log('Required API contract and optional dashboard/live-tail/metrics smoke test passed.');
}

const keepAlive = setInterval(() => {}, 1000);

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    close();
    clearInterval(keepAlive);
  });
