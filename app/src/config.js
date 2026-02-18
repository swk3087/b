import fs from 'fs';
import path from 'path';

const ROOT_KEYS = path.resolve(process.cwd(), '..', 'keys.json');
const APP_KEYS = path.resolve(process.cwd(), 'keys.json');

function loadKeys() {
  const candidateFiles = [ROOT_KEYS, APP_KEYS];
  for (const file of candidateFiles) {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  }
  return {};
}

export const keys = loadKeys();

export const appConfig = {
  port: Number(process.env.PORT || 3000),
  baseUrl: keys?.app?.baseUrl || 'http://localhost:3000',
  domain: keys?.app?.domain || 'app.planriseai.kro.kr',
  dataDir: path.resolve(process.cwd(), 'data'),
  logDir: path.resolve(process.cwd(), 'logs'),
  logRetentionDays: Number(keys?.app?.logRetentionDays || 365),
  logQueryDefaultDays: Number(keys?.app?.logQueryDefaultDays || 30),
  logQueryMaxDays: Number(keys?.app?.logQueryMaxDays || 365),
  logQueryDefaultLimit: Number(keys?.app?.logQueryDefaultLimit || 500),
  logQueryMaxLimit: Number(keys?.app?.logQueryMaxLimit || 5000)
};

export function hasOpenAIConfig() {
  return Boolean(keys?.openai?.apiKey);
}

export function firebaseClientConfig() {
  return keys?.firebase || {};
}

export function firebaseAdminConfig() {
  return keys?.firebaseAdmin || {};
}

export function webPushConfig() {
  return keys?.webPush || {};
}

export function hasWebPushConfig() {
  const cfg = webPushConfig();
  return Boolean(cfg.publicKey && cfg.privateKey && cfg.subject);
}
