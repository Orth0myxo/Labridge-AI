// ai-core.js

import { SystemInstructions } from './instructions.js';
import https from 'https';

const SENSITIVE_TESTS = [
  'VDRL',
  'HIV Rapid Test',
  'Hepatitis B Surface Antigen',
  'Hepatitis C Antibody',
  'Pregnancy Test (hCG)'
];

const SENSITIVE_TEST_PATTERNS = [
  /\bhiv\b/,
  /\bvdrl\b/,
  /\b(?:hepatitis\s*b|hep\s*b|hbsag)\b/,
  /\b(?:hepatitis\s*c|hep\s*c|hcv)\b/,
  /\b(?:pregnan(?:cy|t)|hcg)\b/,
  /\bretroviral\b/
];

export function normalizeTestName(testName) {
  return String(testName || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function isSensitiveTestName(testName) {
  const normalized = normalizeTestName(testName);
  if (!normalized) return false;
  return SENSITIVE_TESTS.some(name => normalizeTestName(name) === normalized)
    || SENSITIVE_TEST_PATTERNS.some(pattern => pattern.test(normalized));
}

function providerHttpError(provider, statusCode) {
  return new Error(`${provider} request failed with HTTP ${statusCode}`);
}

export function parseReferenceRange(refRange) {
  if (refRange === null || refRange === undefined) return null;
  const text = String(refRange)
    .trim()
    .replace(/\u2212/g, '-')
    .replace(/\u2264/g, '<=')
    .replace(/\u2265/g, '>=')
    .replace(/\s+/g, ' ');
  if (!text) return null;

  let match = text.match(/^(-?\d+(?:\.\d+)?)\s*[-\u2013\u2014]\s*(-?\d+(?:\.\d+)?)$/);
  if (match) {
    const low = Number.parseFloat(match[1]);
    const high = Number.parseFloat(match[2]);
    if (Number.isFinite(low) && Number.isFinite(high) && low <= high) {
      return { type: 'between', low, high };
    }
    return null;
  }

  match = text.match(/^(<=|<)\s*(-?\d+(?:\.\d+)?)$/);
  if (match) {
    return { type: 'upper', limit: Number.parseFloat(match[2]), inclusive: match[1] === '<=' };
  }

  match = text.match(/^(>=|>)\s*(-?\d+(?:\.\d+)?)$/);
  if (match) {
    return { type: 'lower', limit: Number.parseFloat(match[2]), inclusive: match[1] === '>=' };
  }

  match = text.match(/^(?:less than|below|under)\s*(-?\d+(?:\.\d+)?)$/i);
  if (match) return { type: 'upper', limit: Number.parseFloat(match[1]), inclusive: false };

  match = text.match(/^(?:up to|at most|no more than|not more than)\s*(-?\d+(?:\.\d+)?)$/i);
  if (match) return { type: 'upper', limit: Number.parseFloat(match[1]), inclusive: true };

  match = text.match(/^(?:greater than|above|over|more than)\s*(-?\d+(?:\.\d+)?)$/i);
  if (match) return { type: 'lower', limit: Number.parseFloat(match[1]), inclusive: false };

  match = text.match(/^(?:at least|no less than|not less than)\s*(-?\d+(?:\.\d+)?)$/i);
  if (match) return { type: 'lower', limit: Number.parseFloat(match[1]), inclusive: true };

  return null;
}

function isReferenceInRange(value, range) {
  if (!range || !Number.isFinite(value)) return false;
  if (range.type === 'between') return value >= range.low && value <= range.high;
  if (range.type === 'upper') return range.inclusive ? value <= range.limit : value < range.limit;
  if (range.type === 'lower') return range.inclusive ? value >= range.limit : value > range.limit;
  return false;
}

export function describeReferenceComparison(value, refRange) {
  const numValue = Number.parseFloat(String(value ?? '').trim());
  const range = parseReferenceRange(refRange);
  if (!range || !Number.isFinite(numValue)) {
    return 'Reference interval could not be interpreted automatically.';
  }

  if (isReferenceInRange(numValue, range)) {
    return `Result is within the reference interval (${refRange}).`;
  }

  if (range.type === 'between') {
    return numValue < range.low
      ? `Result is below the reference interval (${refRange}).`
      : `Result is above the reference interval (${refRange}).`;
  }

  if (range.type === 'upper') {
    return `Result is above the upper reference limit (${refRange}).`;
  }

  return `Result is below the lower reference limit (${refRange}).`;
}

// --- LANGUAGE TRANSLATION MAP (Reliable fallback when AI fails) ---
const TRANSLATION_MAP = {
  'SIMPLIFIED PLAIN ENGLISH': {
    ok: 'Your {test} is all right. Please share this with your doctor.',
    different: 'Your {test} shows a result different from the usual range. Please see your doctor.',
    discuss: 'Your test result needs to be discussed with your doctor. Please schedule an appointment as soon as you can.',
    vague: 'Your test shows findings that need review. Please see your doctor.'
  },
  'NIGERIAN/GHANAIAN PIDGIN': {
    ok: 'Your {test} dey all right. E good make you show your doctor.',
    different: 'Your {test} show result wey different from the normal one. E important make you see your doctor.',
    discuss: 'Your test result need make you and your doctor talk am. E important make you see your doctor quick quick.',
    vague: 'Your test show something wey need check. E important make you see your doctor.'
  },
  'YORUBA': {
    ok: '{test} yin dara. Jọwọ fi han dokita rẹ.',
    different: '{test} yin fi han pe o yàtọ̀. Jọwọ lọ wo dokita rẹ.',
    discuss: 'Abajade idanwo yin nilo ijiroro pẹlu dokita rẹ. Jọwọ ṣe ayẹyẹ kiakia.',
    vague: 'Idanwo yin fi han nkan ti o nilo ayẹwọ. Jọwọ lọ wo dokita rẹ.'
  },
  'HAUSA': {
    ok: '{test} ku ta yi kyau. Da fatan za ku gaya wa likitan ku.',
    different: '{test} ku ta nuna bambanci. Da fatan za ku ga likitan ku.',
    discuss: 'Jarrabawar ku tana buƙatar tattaunawa da likitan ku. Da fatan za ku yi wata ziyara nan da nan.',
    vague: 'Jarrabawar ku ta nuna abubuwa da suke buƙatar dubawa. Da fatan za ku ga likitan ku.'
  },
  'IGBO': {
    ok: '{test} gị dị mma. Biko kụziere dọkịta gị.',
    different: '{test} gị gosipụtara nsonaazụ dị iche. Biko gaa hụ dọkịta gị.',
    discuss: 'Nsonaazụ nlele gị chọrọ ịkparịta ụka na dọkịta gị. Biko mee nhazi ọmụmụ nke ọma.',
    vague: 'Nlele gị gosipụtara ihe ndị chọrọ nyocha. Biko gaa hụ dọkịta gị.'
  }
};

// --- VAMBO / MORENA TARGET LANGUAGE CODES (ISO 639-3) ---
const VAMBO_LANG_CODES = {
  'NIGERIAN/GHANAIAN PIDGIN': 'pcm',
  'YORUBA': 'yor',
  'HAUSA': 'hau',
  'IGBO': 'ibo'
};

function translateTemplate(templateKey, testName, language) {
  const langMap = TRANSLATION_MAP[language] || TRANSLATION_MAP['SIMPLIFIED PLAIN ENGLISH'];
  const template = langMap[templateKey] || langMap['vague'];
  // NEVER reveal test name to patient — use generic "test result" always
  return template.replace(/{test}/g, 'test result');
}

function getFriendlyTestName(testName) {
  const map = {
    'Packed Cell Volume (PCV)': 'blood level test',
    'Haemoglobin (Hb)': 'blood level test',
    'Total WBC Count': 'white blood cell count',
    'Platelet Count': 'platelet count',
    'ESR': 'inflammation test',
    'Reticulocyte Count': 'blood cell production test',
    'Bleeding Time': 'bleeding time test',
    'Prothrombin Time (PT)': 'blood clotting test',
    'APTT/PTTK': 'blood clotting test',
    'Fasting Blood Glucose': 'blood sugar test',
    'Random Blood Glucose': 'blood sugar test',
    'OGTT': 'sugar tolerance test',
    'Serum Urea': 'kidney function test',
    'Serum Creatinine': 'kidney function test',
    'Sodium (Na⁺)': 'sodium level test',
    'Potassium (K⁺)': 'potassium level test',
    'Chloride (Cl⁻)': 'chloride level test',
    'Uric Acid': 'uric acid test',
    'Total Bilirubin': 'liver function test',
    'Conjugated Bilirubin': 'liver function test',
    'AST (SGOT)': 'liver function test',
    'ALT (SGPT)': 'liver function test',
    'ALP': 'liver function test',
    'Total Protein': 'protein level test',
    'Albumin': 'protein level test',
    'Globulin': 'protein level test',
    'Total Cholesterol': 'cholesterol test',
    'HDL Cholesterol': 'good cholesterol test',
    'LDL Cholesterol': 'bad cholesterol test',
    'Triglycerides': 'fat level test',
    'CSF Sugar': 'spinal fluid sugar test',
    'CSF Protein': 'spinal fluid protein test',
    'Blood Group (ABO & Rh)': 'blood group test',
    'Rhesus Typing': 'blood type test',
    'Sickling Test': 'sickling test',
    'Hb Electrophoresis': 'haemoglobin pattern test',
    'Hb Solubility': 'haemoglobin solubility test',
    'Urine MCS (Culture)': 'urine sample test',
    'Stool MCS': 'stool sample test',
    'Gram Stain': 'sample bacteria test',
    'Widal Test': 'Widal test',
    'VDRL': 'test',
    'HIV Rapid Test': 'test',
    'Hepatitis B Surface Antigen': 'test',
    'Hepatitis C Antibody': 'test',
    'Pregnancy Test (hCG)': 'test',
    'Malaria Parasite Smear': 'malaria test',
    'Stool Ova & Parasites': 'stool parasite test',
    'Urine Dipstick': 'urine test',
    'Antimicrobial Sensitivity': 'bacteria treatment test',
    'Chlamydia Test': 'chlamydia test',
    'Mycology (KOH Prep)': 'fungal test',
    'Diagnostic Scan': 'diagnostic scan'
  };
  return map[testName] || testName.toLowerCase() + ' test';
}


export class LabBridgeEngine {
  constructor(geminiKey, openAiKey) {
    if (!geminiKey || geminiKey.trim() === '' || geminiKey.includes('your-') || geminiKey.includes('key-here')) {
      throw new Error('FATAL: Valid GEMINI_API_KEY must be provided.');
    }

    this.geminiKey = geminiKey;
    this.openAiKey = openAiKey;
    this.groqKey = process.env.GROQ_API_KEY || null;
    this.vamboKey = process.env.VAMBO_API_KEY || null;
    this.geminiEndpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent';
    this.groqEndpoint = 'https://api.groq.com/openai/v1/chat/completions';
  }

  // --- ENGINE 0: GROQ CALL (Primary for NUMERIC only) ---
  async callGroq(systemInstruction, userContent) {
    const payload = {
      model: 'openai/gpt-oss-120b',
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: userContent }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
      max_tokens: 1000
    };

    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.groq.com',
        path: '/openai/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.groqKey}`
        },
        timeout: 15000
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(data);
              const text = parsed.choices?.[0]?.message?.content;
              if (!text) throw new Error('Empty response from Groq.');
              resolve(text.trim());
            } catch (e) {
              reject(new Error('Failed to parse response from Groq: ' + e.message));
            }
          } else {
            reject(providerHttpError('Groq', res.statusCode));
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('CONNECT_TIMEOUT'));
      });
      req.on('error', (err) => reject(err));
      req.write(JSON.stringify(payload));
      req.end();
    });
  }

  // --- ENGINE 1: GEMINI CALL (Primary for QUALITATIVE) ---
  async callGemini(systemInstruction, userContent) {
    const mergedContent = `[SYSTEM INSTRUCTION]\n${systemInstruction}\n\n[USER INPUT]\n${userContent}`;

    const payload = {
      contents: [{ parts: [{ text: mergedContent }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 1000
      }
    };

    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(this.geminiEndpoint);
      const options = {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': this.geminiKey
        },
        timeout: 10000,
        agent: new https.Agent({
          keepAlive: true,
          minVersion: 'TLSv1.2'
        })
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(data);
              const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
              if (!text) throw new Error('Empty response from Gemini.');
              resolve(text.trim());
            } catch (e) {
              reject(new Error('Failed to parse response from Gemini: ' + e.message));
            }
          } else {
            reject(providerHttpError('Gemini', res.statusCode));
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('CONNECT_TIMEOUT'));
      });
      req.on('error', (err) => reject(err));
      req.write(JSON.stringify(payload));
      req.end();
    });
  }

  // --- ENGINE 2: OPENAI CALL ---
  async callOpenAI(systemInstruction, userContent) {
    const payload = {
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemInstruction },
        { role: 'user', content: userContent }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
      max_tokens: 1000
    };

    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.openAiKey}`
        },
        timeout: 10000
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(data);
              const text = parsed.choices?.[0]?.message?.content;
              if (!text) throw new Error('Empty response from OpenAI.');
              resolve(text.trim());
            } catch (e) {
              reject(new Error('Failed to parse response from OpenAI: ' + e.message));
            }
          } else {
            reject(providerHttpError('OpenAI', res.statusCode));
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('CONNECT_TIMEOUT'));
      });
      req.on('error', (err) => reject(err));
      req.write(JSON.stringify(payload));
      req.end();
    });
  }

  // --- ENGINE 3: VAMBO / MORENA TRANSLATION (best for African languages) ---
  async callVambo(text, targetCode, sourceCode = 'eng') {
    const payload = { text, source: sourceCode, target: targetCode };

    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.vambo.ai',
        path: '/v1/translate',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.vamboKey}`
        },
        timeout: 15000
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(data);
              const out = parsed.output || parsed.translation || parsed.text;
              if (!out) throw new Error('Empty response from Vambo.');
              resolve(out.trim());
            } catch (e) {
              reject(new Error('Failed to parse response from Vambo: ' + e.message));
            }
          } else {
            reject(providerHttpError('Vambo', res.statusCode));
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('CONNECT_TIMEOUT'));
      });
      req.on('error', (err) => reject(err));
      req.write(JSON.stringify(payload));
      req.end();
    });
  }

  // --- UNIFIED PATIENT-MESSAGE TRANSLATION ---
  // English template -> (Vambo/MORENA primary) -> Gemini -> OpenAI -> static template map
  async translateMessage(englishMessage, language) {
    if (!englishMessage) return null;

    if (language === 'SIMPLIFIED PLAIN ENGLISH') {
      return { text: englishMessage, provider: 'Template (English)' };
    }

    const targetCode = VAMBO_LANG_CODES[language];
    const isVamboKeyValid = this.vamboKey && this.vamboKey.trim() !== '' && !this.vamboKey.includes('your-') && !this.vamboKey.includes('key-here');

    // 1) Vambo / MORENA primary
    if (targetCode && isVamboKeyValid) {
      try {
        console.log('⚡ Vambo/MORENA translating patient message...');
        const out = await this.callVambo(englishMessage, targetCode);
        if (out) return { text: out, provider: 'Vambo / MORENA' };
      } catch (vamboError) {
        console.warn('⚠️ Vambo translation failed:', vamboError.message);
      }
    } else if (!targetCode) {
      console.warn(`⚠️ No Vambo language code for "${language}" — using AI fallback.`);
    }

    const inputPayload = JSON.stringify({
      message: englishMessage,
      targetLanguage: language,
      type: 'translation'
    });

    // 2) Gemini fallback
    if (this.geminiKey) {
      try {
        console.log('⚡ Gemini translating patient message (fallback)...');
        const raw = await this.callGemini(SystemInstructions.LAB_PROCESSOR, inputPayload);
        const parsed = JSON.parse(raw);
        if (parsed.translation) return { text: parsed.translation, provider: 'Gemini Flash Lite' };
      } catch (err) {
        console.warn('⚠️ Gemini translation fallback failed:', err.message);
      }
    }

    // 3) OpenAI fallback
    const isOpenAiKeyValid = this.openAiKey && this.openAiKey.trim() !== '' && !this.openAiKey.startsWith('your-') && !this.openAiKey.includes('key-here');
    if (isOpenAiKeyValid) {
      try {
        console.log('⚡ OpenAI translating patient message (fallback)...');
        const raw = await this.callOpenAI(SystemInstructions.LAB_PROCESSOR, inputPayload);
        const parsed = JSON.parse(raw);
        if (parsed.translation) return { text: parsed.translation, provider: 'OpenAI GPT-4o-mini' };
      } catch (err) {
        console.warn('⚠️ OpenAI translation fallback failed:', err.message);
      }
    }

    return null;
  }

  // --- SANITIZE USER INPUT ---
  sanitizeForPrompt(input, maxLen = 200) {
    if (typeof input !== 'string') return '';
    return input
      .replace(/```[\s\S]*?```/g, '[BLOCKED]')
      .replace(/`/g, '')
      .replace(/[\x00-\x1F\x7F]+/g, ' ')
      .replace(/\s+/g, ' ')
      .substring(0, maxLen)
      .trim();
  }

  // --- AI CLINICAL SIGNIFICANCE (reads raw finding, internal note for scientist) ---
  async generateClinicalSignificance(testName, rawFinding) {
    if (this.isSensitiveTest(testName)) return null;
    const safeFinding = this.sanitizeForPrompt(rawFinding, 3000);
    if (!safeFinding) return null;

    const inputPayload = JSON.stringify({
      test: this.sanitizeForPrompt(testName),
      finding: safeFinding
    });

    const attempts = [
      { provider: 'Gemini Flash Lite', fn: () => this.callGemini(SystemInstructions.CLINICAL_SIGNIFICANCE, inputPayload) }
    ];
    if (this.openAiKey) attempts.push({ provider: 'OpenAI GPT-4o-mini', fn: () => this.callOpenAI(SystemInstructions.CLINICAL_SIGNIFICANCE, inputPayload) });
    if (this.groqKey) attempts.push({ provider: 'openai/gpt-oss-120b', fn: () => this.callGroq(SystemInstructions.CLINICAL_SIGNIFICANCE, inputPayload) });

    for (const attempt of attempts) {
      try {
        const raw = await attempt.fn();
        const parsed = JSON.parse(raw);
        const sig = (parsed.clinicalSignificance || '').toString().trim();
        if (sig) {
          const words = sig.split(/\s+/).filter(Boolean);
          return words.slice(0, 25).join(' ');
        }
      } catch (err) {
        console.warn(`⚠️ Clinical significance via ${attempt.provider} failed: ${err.message}`);
      }
    }
    return null;
  }


  // --- QUALITATIVE TEST DETECTION ---
  isQualitativeTest(testName) {
    const qualitativeTests = [
      'Blood Group (ABO & Rh)', 'Rhesus Typing', 'Sickling Test',
      'Hb Electrophoresis', 'Hb Solubility', 'Urine MCS (Culture)',
      'Stool MCS', 'Gram Stain', 'Widal Test', 'VDRL',
      'HIV Rapid Test', 'Hepatitis B Surface Antigen', 'Hepatitis C Antibody',
      'Pregnancy Test (hCG)', 'Malaria Parasite Smear', 'Stool Ova & Parasites',
      'Urine Dipstick', 'Antimicrobial Sensitivity', 'Chlamydia Test',
      'Mycology (KOH Prep)', 'Diagnostic Scan'
    ];
    return qualitativeTests.includes(testName);
  }

  // --- SENSITIVE TESTS: Hide from patient report ---
  isSensitiveTest(testName) {
    return isSensitiveTestName(testName);
  }

  // --- QUALITATIVE TEMPLATE MAPPING ---
  // ALL qualitative tests use ONLY three variants (A/B/C)
  // No custom per-test templates — patient safety first
  getQualitativeTemplate(testName, rawFinding) {
    const lowerFinding = (rawFinding || '').toLowerCase().trim();

    // Determine variant based on finding
    let variant = 'vague'; // Default

    // Check for normal/negative/clear results
    const normalWords = ['negative', 'non-reactive', 'no growth', 'no organism', 'no parasites', 
                         'no ova', 'no fungal', 'no abnormal', 'sensitive to all', 'aa', 'clear',
                         'not seen', 'not found', 'nil', 'normal', 'within range'];
    const isNormal = normalWords.some(w => lowerFinding.includes(w));

    // Check for critical/high-stakes (only SS sickle cell for now)
    const isCritical = lowerFinding.includes('ss') && testName === 'Hb Electrophoresis';

    // Check for sensitive tests (always critical)
    const isSensitive = this.isSensitiveTest(testName);

    if (isSensitive || isCritical) {
      variant = 'discuss';
    } else if (isNormal) {
      variant = 'ok';
    } else {
      variant = 'different';
    }

    // Build the message using translation map
    const lang = 'SIMPLIFIED PLAIN ENGLISH'; // Default, will be overridden by caller
    const message = translateTemplate(variant, testName, lang);

    // Determine severity
    let severity = 'NORMAL';
    let isCriticalFlag = false;

    if (variant === 'discuss') {
      severity = 'CRITICAL';
      isCriticalFlag = true;
    } else if (variant === 'different') {
      severity = 'MODERATE';
    }

    return {
      english: message,
      severity: severity,
      isCritical: isCriticalFlag
    };
  }

  // --- SEVERITY GRADING FOR NUMERIC TESTS ---
  computeSeverity(value, refRange) {
    const numVal = Number.parseFloat(value);
    const range = parseReferenceRange(refRange);

    if (!range || !Number.isFinite(numVal)) {
      return { severity: 'UNKNOWN', direction: null, isCritical: false };
    }

    if (isReferenceInRange(numVal, range)) {
      return { severity: 'NORMAL', direction: null, isCritical: false };
    }

    let deviation;
    let direction;
    let scale;

    if (range.type === 'between') {
      const isHigh = numVal > range.high;
      direction = isHigh ? 'HIGH' : 'LOW';
      deviation = isHigh ? numVal - range.high : range.low - numVal;
      scale = range.high - range.low;
    } else if (range.type === 'upper') {
      direction = 'HIGH';
      deviation = numVal - range.limit;
      scale = Math.abs(range.limit) || 1;
    } else {
      direction = 'LOW';
      deviation = range.limit - numVal;
      scale = Math.abs(range.limit) || 1;
    }

    if (!Number.isFinite(scale) || scale <= 0) {
      return { severity: `MILD_${direction}`, direction, isCritical: false };
    }

    const relativeDev = deviation / scale;

    if (relativeDev < 0.3) {
      return { severity: `MILD_${direction}`, direction, isCritical: false };
    } else if (relativeDev < 1.0) {
      return { severity: `MODERATE_${direction}`, direction, isCritical: false };
    } else {
      return { severity: `CRITICAL_${direction}`, direction, isCritical: true };
    }
  }

  // --- BUILD PATIENT MESSAGE FROM SEVERITY ---
  buildPatientMessage(testName, severity, language) {
    const testFriendly = this.getFriendlyTestName(testName);

    const messages = {
      'NORMAL': `Your ${testFriendly} is within the healthy range. Please still share this with your doctor.`,
      'MILD_HIGH': `Your ${testFriendly} shows a slightly higher number than usual. Please discuss this with your doctor.`,
      'MILD_LOW': `Your ${testFriendly} shows a slightly lower number than usual. Please discuss this with your doctor.`,
      'MODERATE_HIGH': `Your ${testFriendly} shows a higher number than the usual range. Please see your doctor.`,
      'MODERATE_LOW': `Your ${testFriendly} shows a lower number than the usual range. Please see your doctor.`,
      'CRITICAL_HIGH': `Your ${testFriendly} shows a much higher number than the usual range. Please see your doctor immediately.`,
      'CRITICAL_LOW': `Your ${testFriendly} shows a much lower number than the usual range. Please see your doctor immediately.`,
      'UNKNOWN': `Your ${testFriendly} result has been received. Please see your doctor to discuss the findings.`
    };

    return messages[severity] || messages['UNKNOWN'];
  }

  getFriendlyTestName(testName) {
    const friendlyMap = {
      'Packed Cell Volume (PCV)': 'blood level test',
      'Haemoglobin (Hb)': 'blood level test',
      'Total WBC Count': 'white blood cell count',
      'Platelet Count': 'platelet count',
      'ESR': 'inflammation test',
      'Reticulocyte Count': 'blood cell production test',
      'Bleeding Time': 'bleeding time test',
      'Prothrombin Time (PT)': 'blood clotting test',
      'APTT/PTTK': 'blood clotting test',
      'Fasting Blood Glucose': 'blood sugar test',
      'Random Blood Glucose': 'blood sugar test',
      'OGTT': 'sugar tolerance test',
      'Serum Urea': 'kidney function test',
      'Serum Creatinine': 'kidney function test',
      'Sodium (Na⁺)': 'sodium level test',
      'Potassium (K⁺)': 'potassium level test',
      'Chloride (Cl⁻)': 'chloride level test',
      'Uric Acid': 'uric acid test',
      'Total Bilirubin': 'liver function test',
      'Conjugated Bilirubin': 'liver function test',
      'AST (SGOT)': 'liver function test',
      'ALT (SGPT)': 'liver function test',
      'ALP': 'liver function test',
      'Total Protein': 'protein level test',
      'Albumin': 'protein level test',
      'Globulin': 'protein level test',
      'Total Cholesterol': 'cholesterol test',
      'HDL Cholesterol': 'good cholesterol test',
      'LDL Cholesterol': 'bad cholesterol test',
      'Triglycerides': 'fat level test',
      'CSF Sugar': 'spinal fluid sugar test',
      'CSF Protein': 'spinal fluid protein test'
    };
    return friendlyMap[testName] || testName.toLowerCase() + ' test';
  }

  // --- BACKEND CONFIDENCE CALCULATOR ---
  calculateConfidence(value, refRange, testName, severity) {
    let score = 0.85;
    const reasons = [];

    const numVal = Number.parseFloat(value);
    const range = parseReferenceRange(refRange);

    if (Number.isFinite(numVal) && range) {
      score += 0.05;
      reasons.push('Numeric result with defined reference interval');

      if (range.type === 'between') {
        const center = (range.low + range.high) / 2;
        const scale = range.high - range.low;
        const relativeDev = Math.abs(numVal - center) / scale;

        if (relativeDev < 0.5) {
          score += 0.05;
          reasons.push('Result within calculable deviation bounds');
        } else if (relativeDev < 1.0) {
          score += 0.02;
          reasons.push('Moderate deviation from reference');
        } else {
          score -= 0.15;
          reasons.push('Extreme deviation - confidence reduced');
        }
      } else if (severity === 'NORMAL') {
        score += 0.05;
        reasons.push('Result within one-sided reference limit');
      } else {
        reasons.push('Result outside one-sided reference limit');
      }

      if (severity && severity.startsWith('CRITICAL')) {
        score -= 0.10;
        reasons.push('Critical severity — manual verification advised');
      }
    } else {
      reasons.push('Qualitative result — confidence moderate');
    }

    const knownTests = [
      'Packed Cell Volume (PCV)', 'Haemoglobin (Hb)', 'Total WBC Count', 'Platelet Count',
      'ESR', 'Reticulocyte Count', 'Bleeding Time', 'Prothrombin Time (PT)', 'APTT/PTTK',
      'Fasting Blood Glucose', 'Random Blood Glucose', 'OGTT', 'Serum Urea',
      'Serum Creatinine', 'Sodium (Na⁺)', 'Potassium (K⁺)', 'Chloride (Cl⁻)',
      'Uric Acid', 'Total Bilirubin', 'Conjugated Bilirubin', 'AST (SGOT)',
      'ALT (SGPT)', 'ALP', 'Total Protein', 'Albumin', 'Globulin',
      'Total Cholesterol', 'HDL Cholesterol', 'LDL Cholesterol', 'Triglycerides',
      'CSF Sugar', 'CSF Protein',
      'Blood Group (ABO & Rh)', 'Rhesus Typing', 'Sickling Test',
      'Hb Electrophoresis', 'Hb Solubility', 'Urine MCS (Culture)',
      'Stool MCS', 'Gram Stain', 'Widal Test', 'VDRL',
      'HIV Rapid Test', 'Hepatitis B Surface Antigen', 'Hepatitis C Antibody',
      'Pregnancy Test (hCG)', 'Malaria Parasite Smear', 'Stool Ova & Parasites',
      'Urine Dipstick', 'Antimicrobial Sensitivity', 'Chlamydia Test',
      'Mycology (KOH Prep)', 'Diagnostic Scan'
    ];

    if (knownTests.includes(testName)) {
      score += 0.03;
      reasons.push('Well-characterized test panel');
    }

    return {
      score: Math.max(0.30, Math.min(score, 0.98)),
      reasons: reasons.length ? reasons : ['Standard processing pipeline']
    };
  }

  // --- SYSTEM COORDINATOR ---
  async processResult(patientData, language) {
    const safeTestName = this.sanitizeForPrompt(patientData.testName);
    const safeValue = this.sanitizeForPrompt(patientData.value);
    const safeRefRange = this.sanitizeForPrompt(patientData.refRange);
    const safeLanguage = this.sanitizeForPrompt(language);
    const safeRawFinding = this.sanitizeForPrompt(patientData.rawFinding || '', 3000);

    const isQualitative = this.isQualitativeTest(safeTestName);

    // ==================== QUALITATIVE TEST PATH ====================
    if (isQualitative) {

      const template = this.getQualitativeTemplate(safeTestName, safeRawFinding || safeValue);
      const englishMessage = template.english;
      const severity = template.severity;
      const isCritical = template.isCritical;

      let usedProvider = 'Template + Vambo/MORENA';

      // Translate the fixed English template (Vambo/MORENA primary, AI fallback)
      const translationResult = await this.translateMessage(englishMessage, safeLanguage);
      let patientTranslation;

      if (translationResult) {
        patientTranslation = translationResult.text;
        usedProvider = `Template + ${translationResult.provider}`;
      } else {
        console.log('🔄 All translators failed — using template translation');
        let templateKey = 'vague';
        if (severity === 'NORMAL') templateKey = 'ok';
        else if (severity === 'MILD' || severity === 'MODERATE') templateKey = 'different';
        else if (severity === 'CRITICAL') templateKey = 'discuss';

        // For sensitive tests, always use "discuss"
        if (this.isSensitiveTest(safeTestName)) {
          templateKey = 'discuss';
        }

        patientTranslation = translateTemplate(templateKey, safeTestName, safeLanguage);
        usedProvider = 'Template Translation (AI offline)';
      }

      // Sanitize
      const sanitizeResult = (str) => {
        if (typeof str !== 'string') return '';
        return str.replace(/^[:\-\s*#\s\[\]A-Z_:]+/, '').trim();
      };

      patientTranslation = sanitizeResult(patientTranslation);
      if (patientTranslation.toLowerCase().startsWith('our')) {
        patientTranslation = patientTranslation.replace(/^our/i, 'Your');
      }

      if (!this.applyHardcodedGuardrails(patientTranslation)) {
        console.warn('🛡️ Guardrail hit on qualitative patient translation');
        return this.buildBlockedResult({
          observation: `${safeTestName}: ${safeRawFinding || safeValue}.`,
          referenceComparison: 'Result requires manual review.',
          provider: usedProvider
        });
      }

      const confidenceData = this.calculateConfidence(safeValue, safeRefRange, safeTestName, severity);

      // AI reads the raw finding and returns a very short clinical significance for the scientist
      const clinicalSignificance = this.isSensitiveTest(safeTestName)
        ? 'Sensitive result recorded. Discuss directly with the requesting clinician.'
        : (await this.generateClinicalSignificance(safeTestName, safeRawFinding || safeValue)
          || `Finding recorded for ${safeTestName}. Correlate clinically.`);

      console.log('\n📤 QUALITATIVE OUTPUT ────────────────────────────────────');
      console.log('   Provider:', usedProvider);
      console.log('─────────────────────────────────────────────────────────\n');

      return {
        observation: `${safeTestName}: ${safeRawFinding || safeValue}.`,
        referenceComparison: 'Qualitative test — no numeric reference range.',
        significance: clinicalSignificance,
        technicalNotes: `Test: ${safeTestName}. Finding: ${safeRawFinding || safeValue}. Language: ${safeLanguage}.`,
        patientSummary: patientTranslation,
        isCritical,
        severity,
        provider: usedProvider,
        blocked: false,
        confidence: confidenceData.score,
        confidenceReasons: confidenceData.reasons,
        qcVerified: true,
        rawFinding: safeRawFinding || safeValue
      };
    }

    // ==================== NUMERIC TEST PATH ====================
    const severityData = this.computeSeverity(safeValue, safeRefRange, safeTestName);
    const severity = severityData.severity;
    const isCritical = severityData.isCritical;
    const sensitiveTest = this.isSensitiveTest(safeTestName);

    const englishMessage = sensitiveTest
      ? translateTemplate('discuss', safeTestName, 'SIMPLIFIED PLAIN ENGLISH')
      : this.buildPatientMessage(safeTestName, severity, safeLanguage);

    if (sensitiveTest) {
      const translationResult = await this.translateMessage(englishMessage, safeLanguage);
      let patientTranslation = translationResult
        ? translationResult.text
        : translateTemplate('discuss', safeTestName, safeLanguage);
      patientTranslation = String(patientTranslation || '')
        .replace(/^[:\-\s*#\s\[\]A-Z_:]+/, '')
        .trim();

      if (!this.applyHardcodedGuardrails(patientTranslation)) {
        return this.buildBlockedResult({
          observation: `${safeTestName}: ${safeValue}. Reference: ${safeRefRange}.`,
          referenceComparison: 'Result requires manual review.',
          provider: translationResult ? `Template + ${translationResult.provider}` : 'Template Translation (AI offline)'
        });
      }

      const referenceComparison = describeReferenceComparison(safeValue, safeRefRange);
      const confidenceData = this.calculateConfidence(safeValue, safeRefRange, safeTestName, severity);
      console.log(`[ai] Sensitive numeric result processed locally provider=${translationResult?.provider || 'Template Translation (AI offline)'}`);

      return {
        observation: `${safeTestName}: ${safeValue}. Reference: ${safeRefRange}.`,
        referenceComparison,
        significance: 'Sensitive result recorded. Discuss directly with the requesting clinician.',
        technicalNotes: `Sensitive result. Language: ${safeLanguage}.`,
        patientSummary: patientTranslation,
        isCritical,
        severity,
        provider: translationResult ? `Template + ${translationResult.provider}` : 'Template Translation (AI offline)',
        blocked: false,
        confidence: confidenceData.score,
        confidenceReasons: confidenceData.reasons,
        qcVerified: true,
        rawFinding: null
      };
    }

    const inputPayload = JSON.stringify({
      test: safeTestName,
      value: safeValue,
      referenceRange: safeRefRange,
      targetLanguage: safeLanguage,
      severity: severity,
      type: 'numeric'
    });

    let rawResponse = '';
    let usedProvider = 'Gemini Flash Lite';

    // FIX C4: Less strict Groq key validation
    const isGroqKeyValid = this.groqKey && this.groqKey.trim() !== '' && !this.groqKey.includes('your-') && !this.groqKey.includes('key-here');
    const isOpenAiKeyValid = this.openAiKey && this.openAiKey.trim() !== '' && !this.openAiKey.startsWith('your-') && !this.openAiKey.includes('key-here');

    // GROQ PRIMARY for numeric (fastest)
    if (isGroqKeyValid) {
      const groqRetries = 2;
      let groqSuccess = false;

      for (let attempt = 1; attempt <= groqRetries; attempt++) {
        try {
          console.log(`⚡ Groq attempt ${attempt}/${groqRetries}`);
          rawResponse = await this.callGroq(SystemInstructions.LAB_PROCESSOR, inputPayload);
          usedProvider = 'openai/gpt-oss-120b';
          groqSuccess = true;
          break;
        } catch (groqError) {
          console.warn(`⚠️ Groq attempt ${attempt} failed: ${groqError.message}`);
          if (attempt < groqRetries) {
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
      }

      if (groqSuccess) {
        console.log('✅ Groq responded successfully');
      } else {
        console.log('🔄 Groq failed, trying Gemini...');
      }
    } else {
      console.log('ℹ️  No Groq key configured, skipping to Gemini...');
    }

    // GEMINI FALLBACK
    if (!rawResponse) {
      const geminiRetries = 3;
      let geminiSuccess = false;

      for (let attempt = 1; attempt <= geminiRetries; attempt++) {
        try {
          console.log(`⚡ Gemini attempt ${attempt}/${geminiRetries}`);
          rawResponse = await this.callGemini(SystemInstructions.LAB_PROCESSOR, inputPayload);
          usedProvider = 'Gemini Flash Lite';
          geminiSuccess = true;
          break;
        } catch (geminiError) {
          console.warn(`⚠️ Gemini attempt ${attempt} failed: ${geminiError.message}`);
          if (attempt < geminiRetries) {
            await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
          }
        }
      }

      // OPENAI FALLBACK
      if (!geminiSuccess) {
        if (!isOpenAiKeyValid) {
          throw new Error('All AI providers failed. No valid backup keys configured.');
        }

        console.log('🔄 FAILOVER -> OpenAI (GPT-4o-mini)...');
        const openaiRetries = 3;
        let openaiSuccess = false;

        for (let attempt = 1; attempt <= openaiRetries; attempt++) {
          try {
            console.log(`⚡ OpenAI attempt ${attempt}/${openaiRetries}`);
            rawResponse = await this.callOpenAI(SystemInstructions.LAB_PROCESSOR, inputPayload);
            usedProvider = 'OpenAI GPT-4o-mini';
            openaiSuccess = true;
            break;
          } catch (openaiError) {
            console.warn(`⚠️ OpenAI attempt ${attempt} failed: ${openaiError.message}`);
            if (attempt < openaiRetries) {
              await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
            }
          }
        }

        if (!openaiSuccess) {
          throw new Error('All AI providers (Groq, Gemini, OpenAI) failed after maximum retries.');
        }
      }
    }

    // PARSE AI RESPONSE (analysis only — patient translation is handled by Vambo/MORENA)
    let analysisText = 'LOW_ALERT: Processed';

    try {
      const payloadObj = JSON.parse(rawResponse);
      analysisText = payloadObj.analysis || 'LOW_ALERT: Auto-extracted';

      console.log('\n🤖 AGENT 1 (Scientist Review) ──────────────────────────');
      console.log('   Provider:', usedProvider);
    } catch (parseError) {
      console.error('[ai] Provider response parse failure');
      throw new Error('AI returned invalid format. Please retry.');
    }

    // SANITIZE OUTPUT
    const sanitizeResult = (str) => {
      if (typeof str !== 'string') return '';
      return str.replace(/^[:\-\s*#\s\[\]A-Z_:]+/, '').trim();
    };

    analysisText = sanitizeResult(analysisText);

    // Translate the canonical English patient message (Vambo/MORENA primary, AI fallback)
    const translationResult = await this.translateMessage(englishMessage, safeLanguage);
    let patientTranslation;

    if (translationResult) {
      patientTranslation = translationResult.text;
      console.log('\n💬 AGENT 3 (Patient Communicator) ───────────────────────');
      console.log('   Translator:', translationResult.provider);
      console.log('   Language:', safeLanguage);
    } else {
      let templateKey = 'vague';
      if (severity === 'NORMAL') templateKey = 'ok';
      else if (severity.startsWith('MILD') || severity.startsWith('MODERATE')) templateKey = 'different';
      else if (severity.startsWith('CRITICAL')) templateKey = 'discuss';
      patientTranslation = translateTemplate(templateKey, safeTestName, safeLanguage);
      console.log('\n💬 AGENT 3 (Patient Communicator) ───────────────────────');
    }

    patientTranslation = sanitizeResult(patientTranslation);

    if (patientTranslation.toLowerCase().startsWith('our')) {
      patientTranslation = patientTranslation.replace(/^our/i, 'Your');
      console.log('   ✏️  Fixed pronoun: "Our" → "Your"');
    }

    console.log('\n🛡️  AGENT 2 (Guardrail Auditor) ─────────────────────────');

    // SAFETY GUARDRAILS
    const isSafe = this.applyHardcodedGuardrails(patientTranslation);
    if (!isSafe) {
      console.warn('   ❌ BLOCKED: Guardrail hit on patient translation');
      console.log('   📝 Fallback: Professional nullification applied');
      console.log('\n📤 FINAL OUTPUT ──────────────────────────────────────────');
      console.log('   Status: BLOCKED');
      console.log('   Patient Summary: [Output blocked by safety filter]');
      console.log('   Confidence: 0%');
      console.log('─────────────────────────────────────────────────────────\n');
      return this.buildBlockedResult({
        observation: `${safeTestName}: ${safeValue}. Reference: ${safeRefRange}.`,
        referenceComparison: 'Result requires manual review.',
        provider: usedProvider
      });
    }
    console.log('   ✅ PASSED: No forbidden content detected');

    const observation = `${safeTestName}: ${safeValue}. Reference range: ${safeRefRange}.`;
    const referenceComparison = describeReferenceComparison(safeValue, safeRefRange);

    let significance = 'No significant deviation detected.';
    if (isCritical) {
      significance = 'Marked deviation from reference range. Clinical correlation advised.';
    } else if (severity.startsWith('MILD') || severity.startsWith('MODERATE')) {
      significance = 'Deviation from reference range noted. Monitor and follow up.';
    }

    const technicalNotes = `Test: ${safeTestName}. Value: ${safeValue}. Ref: ${safeRefRange}. Language: ${safeLanguage}.`;
    const confidenceData = this.calculateConfidence(safeValue, safeRefRange, safeTestName, severity);

    console.log('\n📊 BACKEND CONFIDENCE CALCULATOR ────────────────────────');

    console.log('\n📤 FINAL OUTPUT ──────────────────────────────────────────');
    console.log('   Status: APPROVED');
    console.log('   Confidence:', Math.round(confidenceData.score * 100) + '%');
    console.log('   QC Verified:', true);
    console.log('─────────────────────────────────────────────────────────\n');

    return {
      observation,
      referenceComparison,
      significance,
      technicalNotes,
      patientSummary: patientTranslation,
      isCritical,
      severity,
      provider: usedProvider,
      blocked: false,
      confidence: confidenceData.score,
      confidenceReasons: confidenceData.reasons,
      qcVerified: true
    };
  }

  // --- COMPREHENSIVE MEDICAL SAFETY GUARDRAILS ---
  buildBlockedResult({ observation, referenceComparison, provider }) {
    return {
      observation,
      referenceComparison: referenceComparison || 'Result requires manual review.',
      significance: 'Unable to assess — output blocked by safety filter.',
      technicalNotes: 'Guardrail triggered. Scientist review mandatory.',
      patientSummary: '[Output blocked by safety filter. Please consult your doctor for result interpretation.]',
      isCritical: false,
      severity: 'BLOCKED',
      provider,
      blocked: true,
      confidence: 0.0,
      confidenceReasons: ['Guardrail block — no confidence in blocked output'],
      qcVerified: false
    };
  }

  applyHardcodedGuardrails(text) {
    if (!text || typeof text !== 'string') return false;

    const lowerText = text.toLowerCase();

    const forbiddenDrugs = [
      'ciprofloxacin', 'amoxicillin', 'paracetamol', 'panadol', 'flagyl',
      'metronidazole', 'artemether', 'artesunate', 'chloroquine', 'ibuprofen',
      'aspirin', 'acetaminophen', 'antibiotic', 'antibiotics', 'vitamin',
      'supplement', 'prescription', 'medication', 'medicine', 'drug',
      'pharmacy', 'chemist'
    ];

    const forbiddenDiagnoses = [
      'diagnosed', 'diagnosis', 'you have malaria', 'you have typhoid',
      'you have diabetes', 'you have cancer', 'you have hiv', 'you have aids',
      'you have hepatitis', 'you have tuberculosis', 'you have tb',
      'you are diabetic', 'you are hypertensive', 'you are positive',
      'chronic', 'acute condition', 'severe case', 'mild case',
      'stage 1', 'stage 2', 'stage 3', 'stage 4', 'grade 1', 'grade 2',
      'infected with', 'suffering from', 'afflicted with'
    ];

    const forbiddenTreatmentPhrases = [
      'morning and night', 'on an empty stomach', 'with water', 'with milk',
      'complete the course'
    ];

    const forbiddenTreatmentPatterns = [
      /\b(?:take|use|drink|apply|inject|swallow|inhale)\b[^.!?]{0,60}\b(?:tablets?|capsules?|pills?|syrups?|injections?|doses?|dosage|mg|ml|mcg|medicines?|medications?|drugs?)\b/i,
      /\b\d+(?:\.\d+)?\s?(?:mg|ml|mcg|milligrams?|millilitres?)\b/i,
      /\b(?:once|twice|three times)\s+(?:daily|a day|per day)\b/i,
      /\b(?:before|after)\s+(?:food|meals?)\b/i,
      /\bfor\s+\d+\s+(?:days?|weeks?)\b/i
    ];

    const forbiddenEmergency = [
      'go to emergency', 'call ambulance', 'rush to hospital',
      'go immediately', 'do not wait', 'urgent attention', 'critical emergency'
    ];

    const allForbidden = [...forbiddenDrugs, ...forbiddenDiagnoses, ...forbiddenTreatmentPhrases, ...forbiddenEmergency];

    for (const term of allForbidden) {
      const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`\\b${escapedTerm}\\b`, 'i');
      if (regex.test(lowerText)) {
        return false;
      }
    }

    for (const pattern of forbiddenTreatmentPatterns) {
      if (pattern.test(lowerText)) {
        console.warn('🛡️ Guardrail hit: treatment instruction pattern');
        return false;
      }
    }

    return true;
  }
}