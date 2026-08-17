const http = require('node:http');

const agent = new http.Agent({
  keepAlive: true,
  maxSockets: Number(process.env.LOAD_CONCURRENCY ?? 64),
});

const queryAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 16,
});

function request(url, options = {}) {
  const body = options.body;
  const headers = { ...options.headers };

  if (typeof body === 'string' && headers['content-length'] === undefined) {
    headers['content-length'] = Buffer.byteLength(body);
  }

  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      agent: options.query ? queryAgent : agent,
      method: options.method ?? 'GET',
      headers,
    }, (res) => {
      const chunks = [];

      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const responseBody = Buffer.concat(chunks).toString('utf8');
        const status = res.statusCode ?? 0;

        resolve({
          status,
          ok: status >= 200 && status < 300,
          text: async () => responseBody,
          json: async () => JSON.parse(responseBody),
        });
      });
    });

    req.setTimeout(60_000, () => {
      req.destroy(new Error(`Request timed out: ${url}`));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function close() {
  agent.destroy();
  queryAgent.destroy();
}

module.exports = { close, request };
