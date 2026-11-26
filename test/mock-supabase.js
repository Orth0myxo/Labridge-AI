export const state = {
  users: [],
  patient_records: [],
  audit_logs: [],
  requests: []
};

let restoreFetch = null;
let nextId = 1;

export function resetState(seed = {}) {
  state.users = structuredClone(seed.users || []);
  state.patient_records = structuredClone(seed.patient_records || []);
  state.audit_logs = structuredClone(seed.audit_logs || []);
  state.requests = [];
  nextId = 1;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function jsonBody(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

function matches(row, params) {
  const ignored = new Set(['select', 'order', 'limit', 'columns', 'on_conflict', 'offset']);

  for (const [key, raw] of params) {
    if (ignored.has(key)) continue;

    const dot = raw.indexOf('.');
    const op = dot === -1 ? 'eq' : raw.slice(0, dot);
    const expected = dot === -1 ? raw : raw.slice(dot + 1);
    const actual = row[key];

    if (op === 'eq' && String(actual ?? '') !== expected) return false;
    if (op === 'neq' && String(actual ?? '') === expected) return false;
    if (op === 'gte' && !(String(actual ?? '') >= expected)) return false;
    if (op === 'lte' && !(String(actual ?? '') <= expected)) return false;
    if (op === 'is') {
      if (expected === 'null' && actual !== null && actual !== undefined) return false;
      if (expected === 'true' && actual !== true) return false;
      if (expected === 'false' && actual !== false) return false;
    }
    if (op === 'ilike') {
      const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = escaped.replace(/%/g, '.*').replace(/_/g, '.');
      if (!new RegExp(`^${pattern}$`, 'i').test(String(actual ?? ''))) return false;
    }
    if (op === 'in') {
      const values = expected.replace(/^\(/, '').replace(/\)$/, '').split(',');
      if (!values.includes(String(actual ?? ''))) return false;
    }
  }

  return true;
}

function sortedRows(rows, params) {
  const order = params.get('order');
  if (!order) return rows;

  const [column, direction] = order.split('.');
  const multiplier = direction === 'desc' ? -1 : 1;

  return [...rows].sort((a, b) => {
    const left = String(a[column] ?? '');
    const right = String(b[column] ?? '');
    return left.localeCompare(right) * multiplier;
  });
}

export function installSupabaseMock() {
  if (restoreFetch) return restoreFetch;

  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);

    if (!url.pathname.startsWith('/rest/v1/')) {
      return originalFetch(input, init);
    }

    const method = String(init.method || 'GET').toUpperCase();
    const headers = new Headers(init.headers || {});
    const accept = headers.get('accept') || '';
    const table = url.pathname.replace('/rest/v1/', '');
    const body = typeof init.body === 'string' && init.body ? JSON.parse(init.body) : null;

    state.requests.push({ method, url: url.toString(), body: clone(body) });

    if (!Object.prototype.hasOwnProperty.call(state, table)) {
      state[table] = [];
    }

    const rows = state[table];

    if (method === 'GET' || method === 'HEAD') {
      const filtered = sortedRows(rows.filter(row => matches(row, url.searchParams)), url.searchParams);
      const limit = Number(url.searchParams.get('limit') || filtered.length);
      const selected = filtered.slice(0, limit);

      if (method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-range': `0-${Math.max(selected.length - 1, 0)}/${filtered.length}`
          }
        });
      }

      if (accept.includes('application/vnd.pgrst.object+json')) {
        if (selected.length !== 1) {
          return jsonBody({
            code: 'PGRST116',
            details: 'The result contains 0 rows',
            hint: null,
            message: 'Cannot coerce the result to a single JSON object'
          }, 406);
        }
        return jsonBody(selected[0]);
      }

      return jsonBody(selected);
    }

    if (method === 'POST') {
      const inserted = (Array.isArray(body) ? body : [body]).map(item => ({
        id: item.id || `${table}-${nextId++}`,
        ...item
      }));
      rows.push(...inserted);

      if (accept.includes('application/vnd.pgrst.object+json')) {
        return jsonBody(inserted[0], 201);
      }
      if (accept.includes('application/json') && !accept.includes('*/*')) {
        return jsonBody(inserted, 201);
      }
      return new Response(null, { status: 201 });
    }

    if (method === 'PATCH') {
      const filtered = rows.filter(row => matches(row, url.searchParams));
      for (const row of filtered) Object.assign(row, body || {});

      const prefer = headers.get('prefer') || '';
      if (prefer.includes('return=representation')) {
        if (accept.includes('application/vnd.pgrst.object+json')) {
          return jsonBody(filtered[0] || null, filtered.length ? 200 : 406);
        }
        return jsonBody(filtered);
      }

      return new Response(null, { status: 204 });
    }

    return jsonBody({ message: `Unsupported method: ${method}` }, 405);
  };

  restoreFetch = () => {
    globalThis.fetch = originalFetch;
    restoreFetch = null;
  };

  return restoreFetch;
}
