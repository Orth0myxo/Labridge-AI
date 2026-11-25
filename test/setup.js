process.env.GEMINI_API_KEY = 'test-gemini-key';
process.env.SUPABASE_URL = 'http://127.0.0.1:9999';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.HMAC_SECRET_KEY = 'test-hmac-secret';
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.NODE_ENV = 'test';

const { installSupabaseMock } = await import('./mock-supabase.js');
installSupabaseMock();
