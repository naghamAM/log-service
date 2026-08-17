const { close, request } = require('./scripts/http-client');

const base = process.argv[2] ?? 'http://localhost:8080';
const requests = Number(process.argv[3] ?? 100);
const batchSize = Number(process.argv[4] ?? 100);

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
  const warmup = await request(`${base}/_bench/validate`, {
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

  const started = performance.now();

  const replies = await Promise.all(
    Array.from({ length: requests }, () =>
      request(`${base}/_bench/validate`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body,
      }),
    ),
  );

  const seconds = (performance.now() - started) / 1000;

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
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(close);
