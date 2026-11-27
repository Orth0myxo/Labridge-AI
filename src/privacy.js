const REDACTED = '[REDACTED]';
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+/gi;
const PHONE_PATTERN = /(?<![\w+])(?:\+\d[\d ()-]{7,}\d|\(?\d{3,4}\)?[\s.-]\d{3}[\s.-]\d{4})(?![\w])/g;
const ADDRESS_PATTERN = /\b\d{1,5}\s+[A-Za-z0-9 .'-]{2,40}\b(?:street|st|road|rd|avenue|ave|lane|ln|close|crescent|drive|dr|way|court|ct)\.?\b/gi;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactContactInfo(text) {
  return String(text ?? '')
    .replace(EMAIL_PATTERN, REDACTED)
    .replace(URL_PATTERN, REDACTED)
    .replace(PHONE_PATTERN, REDACTED)
    .replace(ADDRESS_PATTERN, REDACTED);
}

function identifierVariants(identifier) {
  if (typeof identifier !== 'string') return [];
  const trimmed = identifier.trim().replace(/\s+/g, ' ');
  if (!trimmed) return [];

  const variants = new Set([trimmed]);
  const commaParts = trimmed.split(/\s*,\s*/);
  if (commaParts.length === 2) {
    variants.add(`${commaParts[1]} ${commaParts[0]}`);
  }

  const compact = trimmed.replace(/[^A-Za-z0-9]/g, '');
  if (compact.length >= 4) variants.add(compact);

  for (const token of trimmed.split(/[\s,]+/)) {
    if (token.length >= 3) variants.add(token);
  }

  return [...variants].filter(Boolean).sort((a, b) => b.length - a.length);
}

export function redactIdentifiers(text, identifiers = []) {
  if (text === null || text === undefined) return '';
  let output = redactContactInfo(text);

  for (const identifier of identifiers) {
    for (const variant of identifierVariants(identifier)) {
      const escaped = escapeRegExp(variant);
      const pattern = new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'gi');
      output = output.replace(pattern, REDACTED);
    }
  }

  return output;
}

export function buildDeidentifiedClinicalData(patientData, identifiers = []) {
  return {
    testName: redactContactInfo(patientData.testName),
    value: redactIdentifiers(patientData.value, identifiers),
    refRange: redactIdentifiers(patientData.refRange, identifiers),
    rawFinding: redactIdentifiers(patientData.rawFinding, identifiers)
  };
}

export function safeErrorCode(error) {
  if (!error || typeof error !== 'object') return 'UNKNOWN';
  if (typeof error.code === 'string' && error.code) return error.code;
  if (typeof error.statusCode === 'number') return `HTTP_${error.statusCode}`;
  if (typeof error.status === 'number') return `HTTP_${error.status}`;
  if (typeof error.name === 'string' && error.name !== 'Error') return error.name;
  return 'UNKNOWN';
}
