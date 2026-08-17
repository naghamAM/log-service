const state = { cursor: null, source: null, logs: [] };
const elements = Object.fromEntries(
  ['healthText', 'clock', 'rate', 'ingestionP95', 'queryP95', 'accepted', 'workerLabel', 'filters', 'tailButton', 'tailLabel', 'logRows', 'logsEmpty', 'resultCount', 'nextButton', 'notice', 'volumeChart', 'chartEmpty']
    .map((id) => [id, document.getElementById(id)]),
);

const number = new Intl.NumberFormat();
const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function setNotice(message = '') {
  elements.notice.textContent = message;
  elements.notice.classList.toggle('hidden', !message);
}

function query(cursor) {
  const data = new FormData(elements.filters);
  const params = new URLSearchParams({ limit: '100' });
  for (const name of ['service', 'level', 'q']) {
    if (data.get(name)?.trim()) params.set(name, data.get(name).trim());
  }
  const key = data.get('attrKey')?.trim();
  const value = data.get('attrValue')?.trim();
  if (key && value) params.set(`attr.${key}`, value);
  if (cursor) params.set('cursor', cursor);
  return params;
}

function cell(value, className = '') {
  const node = document.createElement('td');
  node.className = className;
  node.textContent = value;
  return node;
}

function row(log) {
  const tr = document.createElement('tr');
  tr.dataset.id = log.id;
  tr.append(cell(new Date(log.timestamp).toLocaleString(), 'time'));
  const levelCell = document.createElement('td');
  const badge = document.createElement('span');
  badge.className = `level level-${log.level}`;
  badge.textContent = log.level;
  levelCell.append(badge);
  tr.append(levelCell, cell(log.service), cell(log.message), cell(JSON.stringify(log.attributes ?? {}), 'attrs'));
  return tr;
}

function renderLogs(logs, prepend = false) {
  if (!prepend) elements.logRows.replaceChildren();
  for (const log of logs) {
    if (elements.logRows.querySelector(`[data-id="${CSS.escape(log.id)}"]`)) continue;
    const tr = row(log);
    prepend ? elements.logRows.prepend(tr) : elements.logRows.append(tr);
  }
  elements.logsEmpty.classList.toggle('hidden', elements.logRows.children.length > 0);
  elements.resultCount.textContent = `${elements.logRows.children.length} displayed`;
}

async function loadLogs(cursor = null) {
  setNotice();
  try {
    const response = await fetch(`/logs?${query(cursor)}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? 'Could not load logs');
    renderLogs(body.logs);
    state.cursor = body.next_cursor;
    elements.nextButton.disabled = !state.cursor;
  } catch (error) {
    setNotice(error.message);
  }
}

function stopTail() {
  state.source?.close();
  state.source = null;
  elements.tailButton.classList.remove('active');
  elements.tailLabel.textContent = 'Start live tail';
}

function toggleTail() {
  if (state.source) return stopTail();
  const params = query();
  params.delete('limit');
  const source = new EventSource(`/logs/tail?${params}`);
  state.source = source;
  elements.tailButton.classList.add('active');
  elements.tailLabel.textContent = 'Live tail on';
  source.addEventListener('log', (event) => renderLogs([JSON.parse(event.data)], true));
  source.onerror = () => {
    elements.tailLabel.textContent = 'Reconnecting…';
  };
  source.addEventListener('ready', () => {
    elements.tailLabel.textContent = 'Live tail on';
  });
}

async function loadMetrics() {
  try {
    const [healthResponse, metricsResponse] = await Promise.all([fetch('/health'), fetch('/metrics')]);
    const metrics = await metricsResponse.json();
    elements.healthText.textContent = healthResponse.ok ? 'Service healthy' : 'Service starting';
    elements.rate.textContent = number.format(metrics.ingestionLogsPerSecond ?? 0);
    elements.ingestionP95.textContent = `${number.format(metrics.ingestionDurationMs?.p95 ?? 0)} ms`;
    elements.queryP95.textContent = `${number.format(metrics.queryDurationMs?.logs?.p95 ?? 0)} ms`;
    elements.accepted.textContent = number.format(metrics.acceptedLogs ?? 0);
    elements.workerLabel.textContent = `worker ${metrics.workerId ?? '—'} · PID ${metrics.processId}`;
  } catch {
    elements.healthText.textContent = 'Service unavailable';
  }
}

function drawChart(buckets) {
  const canvas = elements.volumeChart;
  const bounds = canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, bounds.width * scale);
  canvas.height = Math.max(1, bounds.height * scale);
  const context = canvas.getContext('2d');
  context.scale(scale, scale);
  context.clearRect(0, 0, bounds.width, bounds.height);
  elements.chartEmpty.classList.toggle('hidden', buckets.length > 0);
  if (!buckets.length) return;

  const groups = new Map();
  for (const bucket of buckets) {
    const key = new Date(bucket.start).getTime();
    const item = groups.get(key) ?? { debug: 0, info: 0, warn: 0, error: 0 };
    item[bucket.group ?? 'info'] += bucket.count;
    groups.set(key, item);
  }
  const points = [...groups.entries()].sort((a, b) => a[0] - b[0]);
  const totals = points.map(([, levels]) => Object.values(levels).reduce((sum, value) => sum + value, 0));
  const max = Math.max(...totals, 1);
  const colors = { info: '#65a7ff', warn: '#f2a65a', error: '#f06b78', debug: '#a98bff' };
  const width = bounds.width / points.length;

  context.strokeStyle = '#292d35';
  context.lineWidth = 1;
  for (let index = 0; index < 4; index += 1) {
    const y = 10 + ((bounds.height - 30) / 3) * index;
    context.beginPath(); context.moveTo(0, y); context.lineTo(bounds.width, y); context.stroke();
  }
  points.forEach(([, levels], index) => {
    let bottom = bounds.height - 12;
    for (const level of ['debug', 'info', 'warn', 'error']) {
      const height = (levels[level] / max) * (bounds.height - 30);
      context.fillStyle = colors[level];
      context.fillRect(index * width + 1, bottom - height, Math.max(2, width - 2), height);
      bottom -= height;
    }
  });
}

async function loadChart() {
  const until = new Date();
  const since = new Date(until.getTime() - 60 * 60 * 1000);
  const params = new URLSearchParams({ since: since.toISOString(), until: until.toISOString(), bucket: '1m', group_by: 'level' });
  try {
    const response = await fetch(`/logs/aggregate?${params}`);
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    state.buckets = body.buckets;
    drawChart(state.buckets);
  } catch (error) {
    setNotice(error.message);
  }
}

elements.filters.addEventListener('submit', (event) => { event.preventDefault(); stopTail(); void loadLogs(); });
elements.nextButton.addEventListener('click', () => void loadLogs(state.cursor));
elements.tailButton.addEventListener('click', toggleTail);
window.addEventListener('resize', () => drawChart(state.buckets ?? []));
setInterval(() => { elements.clock.textContent = time.format(new Date()); }, 1_000);
setInterval(loadMetrics, 3_000);
setInterval(loadChart, 15_000);
elements.clock.textContent = time.format(new Date());
void Promise.all([loadLogs(), loadMetrics(), loadChart()]);
