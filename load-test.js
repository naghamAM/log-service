const { close, request } = require('./scripts/http-client');

const base = process.argv[2] ?? 'http://localhost:8080';
const requests = Number(process.argv[3] ?? 100);
const batchSize = Number(process.argv[4] ?? 100);
const queryEveryMs = Number(process.argv[5] ?? 1000);

function percentile(values, percentileValue) {
  if (!values.length) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  return Math.round(
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)],
  );
}

function makeBatch() {
  const timestamp = new Date().toISOString();

  return {
    logs: Array.from({ length: batchSize }, (_, i) => ({
      timestamp,
      level: i % 20 === 0 ? 'error' : 'info',
      service: `service-${i % 5}`,
      message: `request completed ${i}`,
      attributes: {
        region: 'eu-west',
        attempt: i % 3,
      },
    })),
  };
}

async function main() {
  // Prepare payload before starting the benchmark timer.
  const body = JSON.stringify(makeBatch());

  // Warm-up request.
  const warmup = await request(`${base}/logs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body,
  });

  if (!warmup.ok) {
    throw new Error(
      `Warm-up failed: ${warmup.status} ${await warmup.text()}`,
    );
  }

  // Consume the warm-up response body.
  await warmup.json();

  const aggregationLatencies = [];
  const querySince = new Date(
    Date.now() - 60 * 60_000,
  ).toISOString();
  const queryUntil = new Date(
    Date.now() + 60_000,
  ).toISOString();
  let aggregationTask;

  const measureAggregation = async () => {
    const queryStarted = performance.now();

    const response = await request(
      `${base}/logs/aggregate?since=${encodeURIComponent(querySince)}&until=${encodeURIComponent(queryUntil)}&bucket=1m&group_by=service`,
      { query: true },
    );

    if (!response.ok) {
      throw new Error(
        `Aggregation request failed: ${response.status} ${await response.text()}`,
      );
    }

    await response.json();
    aggregationLatencies.push(performance.now() - queryStarted);
  };

  const scheduleAggregation = () => {
    if (!aggregationTask) {
      aggregationTask = measureAggregation()
        .finally(() => {
          aggregationTask = undefined;
        });
    }

    return aggregationTask;
  };

  // Establish the dedicated query connection before ingestion saturates the
  // listener, then exclude this warm-up sample from the measured percentiles.
  await scheduleAggregation();
  aggregationLatencies.length = 0;

  const queryTimer = setInterval(() => {
    void scheduleAggregation().catch(console.error);
  }, queryEveryMs);

  const started = performance.now();
  let replies;
  let ingestionSeconds = 0;
  try {
    replies = await Promise.all(
      Array.from({ length: requests }, () =>
        request(`${base}/logs`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body,
        }),
      ),
    );
    ingestionSeconds = (performance.now() - started) / 1000;
  } finally {
    clearInterval(queryTimer);
    await aggregationTask;
    await scheduleAggregation();
  }

  const seconds = ingestionSeconds;

  let successfulRequests = 0;
  let failedRequests = 0;
  let accepted = 0;

  for (const response of replies) {
    if (!response.ok) {
      failedRequests += 1;
      console.error(
        `Request failed: ${response.status} ${await response.text()}`,
      );
      continue;
    }

    successfulRequests += 1;

    const result = await response.json();

    if (typeof result.accepted === 'number') {
      accepted += result.accepted;
    }
  }

  console.log({
    requests,
    batchSize,
    successfulRequests,
    failedRequests,
    accepted,
    seconds: seconds.toFixed(2),
    logsPerSecond: Math.round(accepted / seconds),
    aggregationRequests: aggregationLatencies.length,
    aggregationP50Ms: percentile(aggregationLatencies, 0.5),
    aggregationP95Ms: percentile(aggregationLatencies, 0.95),
  });
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
