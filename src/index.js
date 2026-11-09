// index.js

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import cors from 'cors';
import crypto from 'crypto';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { LabBridgeEngine } from './ai-core.js';

// 1. ENVIRONMENT VALIDATION

dotenv.config();

const requiredEnvVars = ['GEMINI_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'HMAC_SECRET_KEY', 'JWT_SECRET'];
const missingVars = requiredEnvVars.filter(v => !process.env[v]);

if (missingVars.length > 0) {
  console.error('❌ FATAL: Missing required environment variables:', missingVars.join(', '));
  process.exit(1);
}

// 2. EXPRESS SETUP

const app = express();
const PORT = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-hashes'", 'https://cdn.tailwindcss.com'],
      scriptSrcAttr: ["'unsafe-inline'", "'unsafe-hashes'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdn.tailwindcss.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
    },
  },
}));

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));

app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, '../public')));

// 3. SUPABASE (Service Role for server-side)

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 4. AI ENGINE

const engine = new LabBridgeEngine(
  process.env.GEMINI_API_KEY,
  process.env.OPENAI_API_KEY || null
);

// 5. RATE LIMITING

const processLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  message: { success: false, error: 'Too many login attempts. Try again in 5 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// 6. INPUT VALIDATION SCHEMAS
// FIX A1: value is optional when rawFinding is present for qualitative tests
const ProcessRequestSchema = z.object({
  patientId: z.string().max(50).optional(),
  patientName: z.string().min(1).max(100).trim(),
  patientAge: z.string().max(20).optional(),
  patientSex: z.string().max(20).optional(),
  clinician: z.string().max(100).optional(),
  testName: z.string().min(1).max(100).trim(),
  value: z.string().max(3000).trim().optional(),
  unit: z.string().max(50).optional(),
  refRange: z.string().max(100).trim().optional(),
  analyzer: z.string().max(100).optional(),
  sampleType: z.string().max(100).optional(),
  language: z.enum([
    'SIMPLIFIED PLAIN ENGLISH',
    'NIGERIAN/GHANAIAN PIDGIN',
    'YORUBA',
    'HAUSA',
    'IGBO'
  ]),
  scientistId: z.string().max(50).optional(),
  rawFinding: z.string().max(3000).optional(),
  department: z.string().max(50).optional()
}).refine((data) => {
  // Either value or rawFinding must be present
  const hasValue = data.value && data.value.trim().length > 0;
  const hasRaw = data.rawFinding && data.rawFinding.trim().length > 0;
  return hasValue || hasRaw;
}, {
  message: 'Either result value or observation finding must be provided.',
  path: ['value']
});

const LoginSchema = z.object({
  identifier: z.string().min(1).max(50).trim(),
  password: z.string().min(1).max(100)
});

// FIX B6: Human-friendly Zod error mapper
function formatZodErrors(error) {
  const fieldNames = {
    patientName: 'Patient name',
    testName: 'Test name',
    value: 'Result value',
    refRange: 'Reference range',
    language: 'Patient language',
    identifier: 'Staff ID',
    password: 'Password'
  };
  const messages = error.issues.map(issue => {
    const field = fieldNames[issue.path[0]] || issue.path[0];
    if (issue.message.includes('required')) return `${field} is required.`;
    if (issue.message.includes('at least')) return `${field} cannot be empty.`;
    if (issue.message.includes('Invalid enum')) return `${field} must be a valid option.`;
    return `${field}: ${issue.message}`;
  });
  return messages.join(' ');
}

// 7. JWT HELPERS

function signToken(payload) {
  const header = JSON.stringify({ alg: 'HS256', typ: 'JWT' });
  const body = JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + (24 * 60 * 60) });

  const encodedHeader = Buffer.from(header).toString('base64url');
  const encodedBody = Buffer.from(body).toString('base64url');
  const signingInput = `${encodedHeader}.${encodedBody}`;

  const signature = crypto
    .createHmac('sha256', process.env.JWT_SECRET)
    .update(signingInput)
    .digest('base64url');

  return `${signingInput}.${signature}`;
}

function verifyToken(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid token format');

  const [encodedHeader, encodedBody, signature] = parts;
  const signingInput = `${encodedHeader}.${encodedBody}`;

  const expectedSig = crypto
    .createHmac('sha256', process.env.JWT_SECRET)
    .update(signingInput)
    .digest('base64url');

  if (signature !== expectedSig) throw new Error('Invalid signature');

  const payload = JSON.parse(Buffer.from(encodedBody, 'base64url').toString());

  if (payload.exp && payload.exp < Date.now() / 1000) {
    throw new Error('Token expired');
  }

  return payload;
}

// 8. AUTH MIDDLEWARE

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Authentication required.' });
  }

  const token = authHeader.replace('Bearer ', '');

  try {
    const decoded = verifyToken(token);
    req.userId = decoded.sub;
    req.userRole = decoded.role;
    req.userName = decoded.name;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Invalid or expired token.' });
  }
}

// 9. AUTH ROUTES

// POST /api/auth/login
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const parseResult = LoginSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      success: false,
      error: formatZodErrors(parseResult.error)
    });
  }

  const { identifier, password } = parseResult.data;

  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('staff_id', identifier)
      .single();

    if (error || !user) {
      return res.status(401).json({ success: false, error: 'Invalid staff ID or password.' });
    }

    if (user.password !== password) {
      return res.status(401).json({ success: false, error: 'Invalid staff ID or password.' });
    }

    await supabase
      .from('users')
      .update({ last_login: new Date().toISOString() })
      .eq('staff_id', user.staff_id);

    const token = signToken({
      sub: user.staff_id,
      role: user.role,
      name: user.name
    });

    console.log(`🔐 Login success: ${user.name} (${user.staff_id}) — Role: ${user.role}`);

    res.json({
      success: true,
      token,
      user: {
        id: user.staff_id,
        name: user.name,
        role: user.role,
        department: user.department
      }
    });

  } catch (err) {
    console.error('LOGIN_ERROR:', err);
    res.status(500).json({ success: false, error: 'Login failed. Please try again.' });
  }
});

// GET /api/auth/me
app.get('/api/auth/me', authenticate, async (req, res) => {
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('staff_id, name, role, department')
      .eq('staff_id', req.userId)
      .single();

    if (error || !user) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    res.json({
      success: true,
      user: {
        id: user.staff_id,
        name: user.name,
        role: user.role,
        department: user.department
      }
    });
  } catch (err) {
    console.error('ME_ERROR:', err);
    res.status(500).json({ success: false, error: 'Failed to fetch user.' });
  }
});

// POST /api/auth/logout
app.post('/api/auth/logout', authenticate, (req, res) => {
  console.log(`👋 Logout: ${req.userName} (${req.userId})`);
  res.json({ success: true, message: 'Signed out successfully.' });
});

// 10. DASHBOARD & SYSTEM ROUTES

app.get('/api/dashboard/stats', authenticate, async (req, res) => {
  try {
    const { count: patientsProcessed } = await supabase
      .from('patient_records')
      .select('*', { count: 'exact', head: true });

    const { count: pendingReview } = await supabase
      .from('patient_records')
      .select('*', { count: 'exact', head: true })
      .eq('was_blocked', true);

    const today = new Date().toISOString().split('T')[0];
    const { count: outbreakFlags } = await supabase
      .from('patient_records')
      .select('*', { count: 'exact', head: true })
      .eq('is_urgent', true)
      .gte('created_at', today);

    const { data: recentRecords } = await supabase
      .from('patient_records')
      .select('patient_name, test_name, test_value, unit, signed_by, created_at')
      .order('created_at', { ascending: false })
      .limit(5);

    const recentActivity = (recentRecords || []).map(r => ({
      summary: `${r.patient_name} — ${r.test_name}`,
      value: `${r.test_value} ${r.unit || ''}`.trim(),
      hash: crypto.createHash('sha256').update(`${r.patient_name}|${r.created_at}`).digest('hex').slice(0, 16)
    }));

    res.json({
      success: true,
      patientsProcessed: patientsProcessed || 0,
      pendingReview: pendingReview || 0,
      outbreakFlags: outbreakFlags || 0,
      recentActivity
    });

  } catch (err) {
    console.error('DASHBOARD_ERROR:', err);
    res.status(500).json({ success: false, error: 'Failed to load dashboard data.' });
  }
});

app.get('/api/system/health', authenticate, async (req, res) => {
  let dbStatus = 'online';
  try {
    const { error } = await supabase
      .from('patient_records')
      .select('*', { count: 'exact', head: true });
    if (error) dbStatus = 'degraded';
  } catch (err) {
    dbStatus = 'offline';
  }

  const services = [
    { name: 'Backend API', status: 'online' },
    { name: 'AI Engine (Gemini)', status: process.env.GEMINI_API_KEY ? 'online' : 'offline' },
    { name: 'Supabase Database', status: dbStatus },
    { name: 'HMAC Signatures', status: process.env.HMAC_SECRET_KEY ? 'online' : 'offline' },
    { name: 'Rate Limiter', status: 'online' },
    { name: 'JWT Authentication', status: process.env.JWT_SECRET ? 'online' : 'offline' }
  ];

  res.json({ success: true, services });
});

app.get('/api/system/qc-status', authenticate, async (req, res) => {
  res.json({
    success: true,
    dailyQcPassed: null,
    syncSecure: null,
    lastQcRun: null
  });
});

// === REFERENCE RANGES ===
const DEFAULT_REFERENCE_RANGES = {
  'Packed Cell Volume (PCV)': { unit: '%', refRange: '36-46', sampleType: 'EDTA Blood' },
  'Haemoglobin (Hb)': { unit: 'g/dL', refRange: '12-16', sampleType: 'EDTA Blood' },
  'Total WBC Count': { unit: '×10⁹/L', refRange: '4.0-11.0', sampleType: 'EDTA Blood' },
  'Platelet Count': { unit: '×10⁹/L', refRange: '150-400', sampleType: 'EDTA Blood' },
  'ESR': { unit: 'mm/hr', refRange: '0-20', sampleType: 'EDTA Blood' },
  'Reticulocyte Count': { unit: '%', refRange: '0.5-2.5', sampleType: 'EDTA Blood' },
  'Bleeding Time': { unit: 'minutes', refRange: '2-7', sampleType: 'Capillary Blood' },
  'Prothrombin Time (PT)': { unit: 'seconds', refRange: '11-14', sampleType: 'Citrate Plasma' },
  'APTT/PTTK': { unit: 'seconds', refRange: '25-35', sampleType: 'Citrate Plasma' },
  'Fasting Blood Glucose': { unit: 'mmol/L', refRange: '3.9-6.1', sampleType: 'Plasma (Fasting)' },
  'Random Blood Glucose': { unit: 'mmol/L', refRange: '3.9-11.1', sampleType: 'Plasma' },
  'OGTT': { unit: 'mmol/L', refRange: '<7.8', sampleType: 'Plasma (2hr post-glucose)' },
  'Serum Urea': { unit: 'mmol/L', refRange: '2.5-7.1', sampleType: 'Serum' },
  'Serum Creatinine': { unit: 'µmol/L', refRange: '62-106', sampleType: 'Serum' },
  'Sodium (Na⁺)': { unit: 'mmol/L', refRange: '135-145', sampleType: 'Serum' },
  'Potassium (K⁺)': { unit: 'mmol/L', refRange: '3.5-5.0', sampleType: 'Serum' },
  'Chloride (Cl⁻)': { unit: 'mmol/L', refRange: '95-105', sampleType: 'Serum' },
  'Uric Acid': { unit: 'µmol/L', refRange: '210-420', sampleType: 'Serum' },
  'Total Bilirubin': { unit: 'µmol/L', refRange: '3-21', sampleType: 'Serum' },
  'Conjugated Bilirubin': { unit: 'µmol/L', refRange: '0-5', sampleType: 'Serum' },
  'AST (SGOT)': { unit: 'U/L', refRange: '10-40', sampleType: 'Serum' },
  'ALT (SGPT)': { unit: 'U/L', refRange: '7-56', sampleType: 'Serum' },
  'ALP': { unit: 'U/L', refRange: '44-147', sampleType: 'Serum' },
  'Total Protein': { unit: 'g/L', refRange: '60-80', sampleType: 'Serum' },
  'Albumin': { unit: 'g/L', refRange: '35-50', sampleType: 'Serum' },
  'Globulin': { unit: 'g/L', refRange: '20-35', sampleType: 'Serum' },
  'Total Cholesterol': { unit: 'mmol/L', refRange: '<5.2', sampleType: 'Serum' },
  'HDL Cholesterol': { unit: 'mmol/L', refRange: '>1.0', sampleType: 'Serum' },
  'LDL Cholesterol': { unit: 'mmol/L', refRange: '<3.4', sampleType: 'Serum' },
  'Triglycerides': { unit: 'mmol/L', refRange: '<1.7', sampleType: 'Serum' },
  'CSF Sugar': { unit: 'mmol/L', refRange: '2.5-4.4', sampleType: 'CSF' },
  'CSF Protein': { unit: 'g/L', refRange: '0.15-0.45', sampleType: 'CSF' },
  'Blood Group (ABO & Rh)': { unit: '—', refRange: 'A/B/AB/O + Rh', sampleType: 'EDTA Blood' },
  'Rhesus Typing': { unit: '—', refRange: 'Positive/Negative', sampleType: 'EDTA Blood' },
  'Sickling Test': { unit: '—', refRange: 'Positive/Negative', sampleType: 'EDTA Blood' },
  'Hb Electrophoresis': { unit: '—', refRange: 'AA/AS/SS/AC', sampleType: 'EDTA Blood' },
  'Hb Solubility': { unit: '—', refRange: 'Positive/Negative', sampleType: 'EDTA Blood' },
  'Urine MCS (Culture)': { unit: '—', refRange: 'No growth / Organism', sampleType: 'Clean Catch Urine' },
  'Stool MCS': { unit: '—', refRange: 'No growth / Organism', sampleType: 'Stool' },
  'Gram Stain': { unit: '—', refRange: 'Organism / No organism', sampleType: 'Swab / Fluid' },
  'Widal Test': { unit: '—', refRange: 'Negative / Positive (titre)', sampleType: 'Serum' },
  'VDRL': { unit: '—', refRange: 'Non-reactive / Reactive', sampleType: 'Serum' },
  'HIV Rapid Test': { unit: '—', refRange: 'Non-reactive / Reactive', sampleType: 'Serum / Whole Blood' },
  'Hepatitis B Surface Antigen': { unit: '—', refRange: 'Negative / Positive', sampleType: 'Serum' },
  'Hepatitis C Antibody': { unit: '—', refRange: 'Negative / Positive', sampleType: 'Serum' },
  'Pregnancy Test (hCG)': { unit: '—', refRange: 'Negative / Positive', sampleType: 'Urine / Serum' },
  'Malaria Parasite Smear': { unit: '—', refRange: 'Negative / + / ++ / +++', sampleType: 'Thin/Thick Smear' },
  'Stool Ova & Parasites': { unit: '—', refRange: 'No ova/parasites / Present', sampleType: 'Stool' },
  'Urine Dipstick': { unit: '—', refRange: 'Negative / Trace / + / ++ / +++', sampleType: 'Random Urine' },
  'Antimicrobial Sensitivity': { unit: '—', refRange: 'Sensitive / Resistant', sampleType: 'Culture Isolate' },
  'Chlamydia Test': { unit: '—', refRange: 'Negative / Positive', sampleType: 'Urine / Swab' },
  'Mycology (KOH Prep)': { unit: '—', refRange: 'No fungal elements / Fungal elements seen', sampleType: 'Skin/Nail/Hair Scraping' },
  'Diagnostic Scan': { unit: '—', refRange: 'Negative / Positive', sampleType: 'Culture/Swab' }
};

app.get('/api/reference-ranges', authenticate, async (req, res) => {
  const testName = req.query.test;
  if (!testName) {
    return res.status(400).json({ success: false, error: 'Test name required.' });
  }
  const range = DEFAULT_REFERENCE_RANGES[testName];
  if (!range) {
    return res.status(404).json({ success: false, error: 'Reference range not found for this test.' });
  }
  res.json({ success: true, ...range });
});

// 11. RECORDS ROUTES

// FIX A4: Use r.unit from database instead of hardcoded '%'
app.get('/api/records', authenticate, async (req, res) => {
  try {
    const { data: records, error } = await supabase
      .from('patient_records')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;

    res.json({
      success: true,
      records: (records || []).map(r => ({
        patientId: r.patient_name?.replace(/\s+/g, '-').toUpperCase() || 'UNKNOWN',
        patientName: r.patient_name,
        testName: r.test_name,
        value: r.test_value,
        unit: r.unit || '—',
        refRange: r.ref_range,
        clinician: r.signed_by,
        createdAt: r.created_at,
        hash: r.signature?.slice(0, 16) || '—'
      }))
    });

  } catch (err) {
    console.error('RECORDS_ERROR:', err);
    res.status(500).json({ success: false, error: 'Failed to load records.' });
  }
});

// FIX A4: Use r.unit from database
app.get('/api/records/:patientId', authenticate, async (req, res) => {
  const { patientId } = req.params;

  try {
    const searchName = patientId.replace(/-/g, ' ');

    const { data: record, error } = await supabase
      .from('patient_records')
      .select('*')
      .ilike('patient_name', `%${searchName}%`)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error || !record) {
      return res.status(404).json({ success: false, error: 'Record not found.' });
    }

    res.json({
      success: true,
      record: {
        patientId: record.patient_name?.replace(/\s+/g, '-').toUpperCase() || 'UNKNOWN',
        patientName: record.patient_name,
        patientAge: record.patient_age || '—',
        patientSex: record.patient_sex || '—',
        clinician: record.signed_by,
        testName: record.test_name,
        value: record.test_value,
        unit: record.unit || '—',
        refRange: record.ref_range,
        analyzer: record.analyzer || '—',
        language: record.language || 'SIMPLIFIED PLAIN ENGLISH',
        patientSummary: record.translation,
        scientistDraft: record.translation,
        scientistId: record.signed_by,
        createdAt: record.created_at,
        hash: record.signature,
        aiVersion: record.ai_provider,
        facilityName: process.env.FACILITY_NAME || 'Medical Laboratory'
      }
    });

  } catch (err) {
    console.error('RECORD_DETAIL_ERROR:', err);
    res.status(500).json({ success: false, error: 'Failed to load record.' });
  }
});

// 12. SURVEILLANCE ROUTES

app.get('/api/surveillance/wards', authenticate, async (req, res) => {
  res.json({ success: true, wards: [] });
});

app.get('/api/surveillance/wards/:name', authenticate, async (req, res) => {
  res.json({ success: true, conditions: [] });
});

app.get('/api/surveillance/settings', authenticate, (req, res) => {
  res.json({ success: true, epidemicLimit: null, anonymizationFilter: null, wardCoverage: null });
});

// 13. ADMIN ROUTES

app.get('/api/admin/settings', authenticate, (req, res) => {
  res.json({ success: true, strictDiagnosisLock: true, openaiFallback: !!process.env.OPENAI_API_KEY });
});

app.get('/api/admin/logs', authenticate, async (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  try {
    const { data: logs, error } = await supabase
      .from('audit_logs')
      .select('*')
      .order('timestamp', { ascending: false })
      .limit(limit);

    if (error) throw error;

    res.json({
      success: true,
      logs: (logs || []).map(l => ({
        timestamp: l.timestamp,
        level: 'info',
        message: `${l.action}: ${l.target_patient} by ${l.user_id}`
      }))
    });
  } catch (err) {
    console.error('ADMIN_LOGS_ERROR:', err);
    res.json({ success: true, logs: [] });
  }
});

// 14. POST /api/records (Sign-off & Save)

app.post('/api/records', authenticate, async (req, res) => {
  const {
    patientId, patientName, patientAge, patientSex, clinician,
    testName, value, unit, refRange, analyzer, sampleType, language,
    patientSummary, scientistDraft, scientistId, department
  } = req.body;

  const timestamp = new Date().toISOString();
  const payloadString = `${patientName}|${testName}|${value}|${timestamp}|${scientistId}`;
  const signature = crypto
    .createHmac('sha256', process.env.HMAC_SECRET_KEY)
    .update(payloadString)
    .digest('hex');

  try {
    // FIX A5 + C2 + C3: Include unit, department, age, sex
    const { data: record, error: dbError } = await supabase
      .from('patient_records')
      .insert([{
        patient_name: patientName,
        test_name: testName,
        test_value: value,
        unit: unit || '—',
        ref_range: refRange,
        translation: patientSummary,
        signature: signature,
        signed_by: scientistId,
        created_at: timestamp,
        is_urgent: false,
        ai_provider: 'LabBridge Engine',
        was_blocked: false,
        patient_age: patientAge,
        patient_sex: patientSex,
        department: department || 'General',
        analyzer: analyzer,
        sample_type: sampleType,
        language: language
      }])
      .select()
      .single();

    if (dbError) {
      console.error('❌ Record Save Error:', dbError.message);
      return res.status(500).json({ success: false, error: 'Failed to save record.' });
    }

    await supabase
      .from('audit_logs')
      .insert([{
        user_id: scientistId,
        action: 'SCIENTIST_SIGN_OFF',
        target_patient: patientName,
        timestamp: timestamp,
        details: { testName, value, signature: signature.slice(0, 16) }
      }]);

    console.log(`✅ Record signed off by ${scientistId} for ${patientName}`);

    // FIX B8: Use FACILITY_NAME env var, remove software branding
    res.json({
      success: true,
      record: {
        patientId: patientId || patientName?.replace(/\s+/g, '-').toUpperCase(),
        patientName,
        patientAge: patientAge || '—',
        patientSex: patientSex || '—',
        clinician: clinician || '—',
        testName,
        value,
        unit: unit || '—',
        refRange,
        analyzer: analyzer || '—',
        language: language || 'SIMPLIFIED PLAIN ENGLISH',
        patientSummary,
        scientistDraft,
        scientistId,
        createdAt: timestamp,
        hash: signature,
        aiVersion: null,
        facilityName: process.env.FACILITY_NAME || 'Medical Laboratory'
      }
    });

  } catch (err) {
    console.error('SIGN_OFF_ERROR:', err);
    res.status(500).json({ success: false, error: 'Sign-off failed.' });
  }
});

// 15. MAIN AI PROCESSING ROUTE

app.post('/api/process', authenticate, processLimiter, async (req, res) => {
  const parseResult = ProcessRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      success: false,
      error: formatZodErrors(parseResult.error)
    });
  }

  const { patientName, testName, value, refRange, language, rawFinding, department } = parseResult.data;
  const scientistId = req.userId;

  try {
    const patientData = { testName, value, refRange, rawFinding };
    const timestamp = new Date().toISOString();

    const resultObj = await engine.processResult(patientData, language);
    const translation = resultObj.patientSummary;
    const isCritical = resultObj.isCritical;
    const severity = resultObj.severity;
    const provider = resultObj.provider || 'Unknown';
    const wasBlocked = resultObj.blocked || false;

    const draftPayload = `${patientName}|${testName}|${value}|${resultObj.observation}|${timestamp}`;
    const draftHash = crypto
      .createHmac('sha256', process.env.HMAC_SECRET_KEY)
      .update(draftPayload)
      .digest('hex');

    // FIX A5 + C2 + C3: Include unit, department, demographics
    const { error: dbError } = await supabase
      .from('patient_records')
      .insert([{
        patient_name: patientName,
        test_name: testName,
        test_value: value,
        unit: parseResult.data.unit || '—',
        ref_range: refRange,
        translation: translation,
        signature: draftHash,
        signed_by: scientistId,
        created_at: timestamp,
        is_urgent: isCritical,
        ai_provider: provider,
        was_blocked: wasBlocked,
        patient_age: parseResult.data.patientAge,
        patient_sex: parseResult.data.patientSex,
        department: department || 'General',
        analyzer: parseResult.data.analyzer,
        sample_type: parseResult.data.sampleType,
        language: language,
        raw_finding: rawFinding
      }]);

    if (dbError) {
      console.error('❌ Supabase Save Error:', dbError.message);
    } else {
      console.log(`\x1b[32m💾 Saved signed record for Patient: ${patientName} by ${scientistId}\x1b[0m`);
    }

    const { error: auditError } = await supabase
      .from('audit_logs')
      .insert([{
        user_id: scientistId,
        action: wasBlocked ? 'VERIFY_AND_SIGN_REPORT_BLOCKED' : 'VERIFY_AND_SIGN_REPORT',
        target_patient: patientName,
        timestamp: timestamp,
        details: { provider, wasBlocked, isCritical, severity }
      }]);

    if (auditError) {
      console.error('⚠️ Audit Log Failed:', auditError.message);
    } else {
      console.log('\x1b[32m📋 Audit log saved\x1b[0m');
    }

    res.json({
      success: true,
      observation: resultObj.observation,
      referenceComparison: resultObj.referenceComparison,
      significance: resultObj.significance,
      technicalNotes: resultObj.technicalNotes,
      patientSummary: resultObj.patientSummary,
      draftHash: draftHash,
      confidence: resultObj.confidence,
      confidenceReasons: resultObj.confidenceReasons,
      qcVerified: resultObj.qcVerified,
      translation,
      signature: draftHash,
      timestamp,
      isCritical,
      severity,
      provider,
      wasBlocked,
      rawFinding: resultObj.rawFinding || null
    });

  } catch (error) {
    console.error('PROCESS_ERROR:', error);
    res.status(500).json({
      success: false,
      error: 'An error occurred while processing your request. Please try again or contact support.'
    });
  }
});

// 16. HEALTH CHECK (public)

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 17. START SERVER

app.listen(PORT, () => {
  console.log(`\n🚀 LabBridge API running at: http://localhost:${PORT}`);
  console.log(`🔒 Security: Helmet enabled, Rate limiting active, JWT required`);
  console.log(`🔐 Auth: /api/auth/login, /api/auth/me, /api/auth/logout`);
  console.log(`📊 Dashboard: /api/dashboard/stats, /api/system/health`);
  console.log(`🧪 Reference: /api/reference-ranges`);
  console.log(`📋 Records: /api/records`);
  console.log(`🌍 Surveillance: /api/surveillance/wards`);
  console.log(`⚙️ Admin: /api/admin/settings, /api/admin/logs`);
});