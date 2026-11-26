import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';

import { app, signToken, computeRecordSignature, RECORD_SIGNATURE_FIELDS } from '../src/index.js';
import { LabBridgeEngine, isSensitiveTestName } from '../src/ai-core.js';
import { resetState, state } from './mock-supabase.js';

let server;
let baseUrl;

function tokenFor(role, sub = 'USER-1') {
  return signToken({ sub, role, name: `${role} user` });
}

function auth(role, sub) {
  return { Authorization: `Bearer ${tokenFor(role, sub)}` };
}

async function request(path, { role, sub, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (role) Object.assign(headers, auth(role, sub));

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

function baseRecord(overrides = {}) {
  return {
    id: 'record-1',
    patient_name: 'Ada Obi',
    test_name: 'Packed Cell Volume (PCV)',
    test_value: '30',
    unit: '%',
    ref_range: '36-46',
    translation: 'Your blood level test shows a lower number than the usual range. Please see your doctor.',
    signed_by: 'MLS-1',
    created_at: new Date().toISOString(),
    is_urgent: false,
    ai_provider: 'LabBridge Engine',
    was_blocked: false,
    patient_age: '30',
    patient_sex: 'F',
    department: 'Hematology',
    analyzer: 'Sysmex',
    sample_type: 'EDTA Blood',
    language: 'SIMPLIFIED PLAIN ENGLISH',
    raw_finding: null,
    ...overrides
  };
}

function signedRecord(overrides = {}) {
  const record = baseRecord(overrides);
  record.signature = overrides.signature || computeRecordSignature(record, 'SIGNED');
  return record;
}

function draftRecord(overrides = {}) {
  const record = baseRecord({
    id: 'draft-1',
    ai_provider: 'openai/gpt-oss-120b',
    ...overrides
  });
  record.signature = overrides.signature || computeRecordSignature(record, 'DRAFT');
  return record;
}

const signOffPayload = {
  patientId: 'ADA-OBI',
  patientName: 'Ada Obi',
  patientAge: '30',
  patientSex: 'F',
  clinician: 'Dr Bello',
  testName: 'Packed Cell Volume (PCV)',
  value: '30',
  unit: '%',
  refRange: '36-46',
  analyzer: 'Sysmex',
  sampleType: 'EDTA Blood',
  language: 'SIMPLIFIED PLAIN ENGLISH',
  department: 'Hematology',
  patientSummary: 'Tampered patient summary',
  scientistDraft: 'Tampered draft',
  scientistId: 'ADMIN-1'
};

test.before(async () => {
  server = app.listen(0);
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
});

test('C1 enforces role-based access on every protected route group', async () => {
  resetState();

  const cases = [
    ['/api/admin/settings', 'mls', 403],
    ['/api/admin/settings', 'clinician', 403],
    ['/api/admin/settings', 'surveillance', 403],
    ['/api/admin/settings', 'admin', 200],
    ['/api/system/health', 'mls', 403],
    ['/api/system/health', 'admin', 200],
    ['/api/system/qc-status', 'clinician', 403],
    ['/api/system/qc-status', 'mls', 200],
    ['/api/system/qc-status', 'admin', 200],
    ['/api/reference-ranges?test=ESR', 'clinician', 403],
    ['/api/reference-ranges?test=ESR', 'mls', 200],
    ['/api/dashboard/stats', 'mls', 200],
    ['/api/dashboard/stats', 'clinician', 200],
    ['/api/dashboard/stats', 'surveillance', 200],
    ['/api/dashboard/stats', 'admin', 200],
    ['/api/admin/logs', 'clinician', 403],
    ['/api/admin/logs', 'admin', 200],
    ['/api/records', 'mls', 403],
    ['/api/records', 'clinician', 200],
    ['/api/records', 'admin', 200],
    ['/api/records/ADA-OBI', 'mls', 403],
    ['/api/records/ADA-OBI', 'clinician', 404],
    ['/api/records/ADA-OBI', 'admin', 404],
    ['/api/surveillance/wards', 'mls', 403],
    ['/api/surveillance/wards', 'clinician', 403],
    ['/api/surveillance/wards', 'surveillance', 200],
    ['/api/surveillance/wards', 'admin', 200],
    ['/api/surveillance/wards/ICU', 'clinician', 403],
    ['/api/surveillance/wards/ICU', 'surveillance', 200],
    ['/api/surveillance/settings', 'clinician', 403],
    ['/api/surveillance/settings', 'surveillance', 200],
    ['/api/records', 'clinician', 403, 'POST'],
    ['/api/records', 'mls', 400, 'POST'],
    ['/api/records', 'admin', 400, 'POST'],
    ['/api/process', 'clinician', 403, 'POST'],
    ['/api/process', 'mls', 400, 'POST'],
    ['/api/process', 'admin', 400, 'POST']
  ];

  for (const [path, role, expected, method = 'GET'] of cases) {
    const result = await request(path, { role, method, body: method === 'POST' ? {} : undefined });
    assert.equal(result.status, expected, `${method} ${path} as ${role}`);
  }

  const unauthenticated = await request('/api/admin/settings');
  assert.equal(unauthenticated.status, 401);

  const normalizedRole = await request('/api/admin/settings', {
    role: ' ADMIN ',
    method: 'GET'
  });
  assert.equal(normalizedRole.status, 200);
});

test('C2 masks sensitive tests and results in list, detail and dashboard responses', async () => {
  for (const name of ['HIV', 'HIV Test', 'HIV Rapid Test (screening)', 'Hep B', 'HBsAg', 'HCV', 'Pregnancy', 'Beta hCG']) {
    assert.equal(isSensitiveTestName(name), true, name);
  }
  for (const name of ['Hepatitis A Antibody', 'Blood Group (ABO & Rh)', 'Packed Cell Volume (PCV)']) {
    assert.equal(isSensitiveTestName(name), false, name);
  }

  resetState({
    patient_records: [
      signedRecord({
        patient_name: 'Ada Obi',
        test_name: 'HIV',
        test_value: 'Reactive',
        unit: '—',
        ref_range: 'Non-reactive / Reactive',
        translation: 'Your test result needs to be discussed with your doctor.'
      }),
      signedRecord({
        patient_name: 'Bola Ade',
        test_name: 'Packed Cell Volume (PCV)',
        test_value: '40',
        unit: '%',
        ref_range: '36-46'
      })
    ]
  });

  const list = await request('/api/records', { role: 'clinician' });
  assert.equal(list.status, 200);
  const hiv = list.data.records.find(record => record.patientName === 'Ada Obi');
  const pcv = list.data.records.find(record => record.patientName === 'Bola Ade');

  assert.equal(hiv.testName, 'Confidential test');
  assert.equal(hiv.value, 'Result withheld');
  assert.equal(hiv.refRange, '—');
  assert.equal(hiv.unit, '—');
  assert.equal(pcv.testName, 'Packed Cell Volume (PCV)');
  assert.equal(pcv.value, '40');

  const detail = await request('/api/records/ADA-OBI', { role: 'clinician' });
  assert.equal(detail.status, 200);
  assert.equal(detail.data.record.testName, 'Confidential test');
  assert.equal(detail.data.record.value, 'Result withheld');
  assert.equal(detail.data.record.refRange, '—');

  const dashboard = await request('/api/dashboard/stats', { role: 'clinician' });
  assert.equal(dashboard.status, 200);
  const hivActivity = dashboard.data.recentActivity.find(item => item.summary.includes('Ada Obi'));
  assert.match(hivActivity.summary, /Confidential test/);
  assert.match(hivActivity.value, /Result withheld/);

  const surveillance = await request('/api/dashboard/stats', { role: 'surveillance' });
  assert.equal(surveillance.status, 200);
  assert.deepEqual(surveillance.data.recentActivity, []);
});

test('C2 masks sensitive results in the sign-off response used by the patient report', async () => {
  resetState({
    patient_records: [
      draftRecord({
        test_name: 'HIV Rapid Test',
        test_value: 'Reactive',
        ref_range: 'Non-reactive / Reactive',
        translation: 'Your test result needs to be discussed with your doctor.'
      })
    ]
  });

  const result = await request('/api/records', {
    role: 'mls',
    sub: 'MLS-1',
    method: 'POST',
    body: {
      ...signOffPayload,
      testName: 'HIV Rapid Test',
      value: 'Reactive',
      unit: '—',
      refRange: 'Non-reactive / Reactive'
    }
  });

  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.record.testName, 'Confidential test');
  assert.equal(result.data.record.value, 'Result withheld');
  assert.equal(result.data.record.refRange, '—');
  assert.equal(result.data.record.unit, '—');

  const signed = state.patient_records.find(record => record.ai_provider === 'LabBridge Engine');
  assert.equal(signed.test_name, 'HIV Rapid Test');
  assert.equal(signed.test_value, 'Reactive');
});

test('C3 guardrails match whole words and apply to qualitative translations', async () => {
  const engine = new LabBridgeEngine('test-gemini-key', null);

  assert.equal(engine.applyHardcodedGuardrails('mistake'), true);
  assert.equal(engine.applyHardcodedGuardrails('Your test result is within the healthy range.'), true);
  assert.equal(engine.applyHardcodedGuardrails('Please take a moment to read this.'), true);
  assert.equal(engine.applyHardcodedGuardrails('Use the left arm for the sample.'), true);
  assert.equal(engine.applyHardcodedGuardrails('Drink plenty of water today.'), true);
  assert.equal(engine.applyHardcodedGuardrails('Take two tablets of paracetamol twice daily.'), false);
  assert.equal(engine.applyHardcodedGuardrails('Take one tablet daily.'), false);
  assert.equal(engine.applyHardcodedGuardrails('Complete the course.'), false);
  assert.equal(engine.applyHardcodedGuardrails('You are positive for hepatitis.'), false);

  engine.translateMessage = async () => ({
    text: 'Take ciprofloxacin 500mg twice daily.',
    provider: 'Test translator'
  });
  engine.generateClinicalSignificance = async () => 'Test significance';

  const blocked = await engine.processResult({
    testName: 'HIV Rapid Test',
    value: 'Reactive',
    refRange: 'Non-reactive / Reactive',
    rawFinding: 'Reactive'
  }, 'SIMPLIFIED PLAIN ENGLISH');

  assert.equal(blocked.blocked, true);
  assert.equal(blocked.severity, 'BLOCKED');
  assert.equal(blocked.qcVerified, false);
  assert.match(blocked.patientSummary, /Output blocked by safety filter/);

  engine.translateMessage = async () => ({
    text: 'Your test result needs to be discussed with your doctor. Please schedule an appointment as soon as you can.',
    provider: 'Test translator'
  });

  const safe = await engine.processResult({
    testName: 'HIV Rapid Test',
    value: 'Reactive',
    refRange: 'Non-reactive / Reactive',
    rawFinding: 'Reactive'
  }, 'SIMPLIFIED PLAIN ENGLISH');

  assert.equal(safe.blocked, false);
});

test('C4/C5 signs only the authenticated user matching draft and hashes the reviewed content', async () => {
  const draft = draftRecord({ is_urgent: true });
  resetState({ patient_records: [draft] });

  const result = await request('/api/records', {
    role: 'mls',
    sub: 'MLS-1',
    method: 'POST',
    body: signOffPayload
  });

  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.record.scientistId, 'MLS-1');
  assert.equal(result.data.record.patientSummary, draft.translation);
  assert.notEqual(result.data.record.patientSummary, signOffPayload.patientSummary);

  const signed = state.patient_records.find(record => record.ai_provider === 'LabBridge Engine');
  assert.equal(signed.signed_by, 'MLS-1');
  assert.equal(signed.translation, draft.translation);
  assert.equal(signed.is_urgent, true);
  assert.equal(state.audit_logs.at(-1).user_id, 'MLS-1');
  assert.equal(result.data.record.hash, computeRecordSignature(signed, 'SIGNED'));

  for (const field of RECORD_SIGNATURE_FIELDS) {
    const tampered = { ...signed, [field]: `${signed[field] ?? ''}-tampered` };
    assert.notEqual(
      computeRecordSignature(tampered, 'SIGNED'),
      signed.signature,
      `signature must cover ${field}`
    );
  }

  const list = await request('/api/records', { role: 'clinician' });
  assert.equal(list.status, 200);
  assert.equal(list.data.records.length, 1);
  assert.equal(list.data.records[0].patientName, 'Ada Obi');
});

test('C4 rejects drafts that were not signed by the server and prevents concurrent sign-off', async () => {
  const invalidDraft = draftRecord();
  invalidDraft.signature = 'not-a-valid-server-signature';
  resetState({ patient_records: [invalidDraft] });

  let result = await request('/api/records', {
    role: 'mls',
    sub: 'MLS-1',
    method: 'POST',
    body: signOffPayload
  });
  assert.equal(result.status, 409);
  assert.match(result.data.error, /could not be verified/);

  resetState({ patient_records: [draftRecord()] });

  const [first, second] = await Promise.all([
    request('/api/records', {
      role: 'mls',
      sub: 'MLS-1',
      method: 'POST',
      body: signOffPayload
    }),
    request('/api/records', {
      role: 'mls',
      sub: 'MLS-1',
      method: 'POST',
      body: signOffPayload
    })
  ]);

  assert.deepEqual([first.status, second.status].sort(), [200, 409]);
  assert.equal(
    state.patient_records.filter(record => record.ai_provider === 'LabBridge Engine').length,
    1
  );
});

test('C4 rejects blocked drafts, unsafe drafts, missing drafts and duplicate sign-off', async () => {
  resetState({
    patient_records: [
      draftRecord({
        was_blocked: true,
        translation: '[Output blocked by safety filter. Please consult your doctor for result interpretation.]'
      })
    ]
  });

  let result = await request('/api/records', {
    role: 'mls',
    sub: 'MLS-1',
    method: 'POST',
    body: signOffPayload
  });
  assert.equal(result.status, 409);
  assert.match(result.data.error, /Blocked results/);
  assert.equal(state.patient_records.filter(record => record.ai_provider === 'LabBridge Engine').length, 0);

  resetState({
    patient_records: [
      draftRecord({ translation: 'Take two tablets of paracetamol twice daily.' })
    ]
  });

  result = await request('/api/records', {
    role: 'mls',
    sub: 'MLS-1',
    method: 'POST',
    body: signOffPayload
  });
  assert.equal(result.status, 409);
  assert.match(result.data.error, /guardrail/);

  resetState({ patient_records: [] });

  result = await request('/api/records', {
    role: 'mls',
    sub: 'MLS-1',
    method: 'POST',
    body: signOffPayload
  });
  assert.equal(result.status, 409);
  assert.match(result.data.error, /No matching unsigned draft/);

  resetState({ patient_records: [signedRecord()] });

  result = await request('/api/records', {
    role: 'mls',
    sub: 'MLS-1',
    method: 'POST',
    body: signOffPayload
  });
  assert.equal(result.status, 409);
  assert.match(result.data.error, /already been signed/);
});
