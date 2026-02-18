import fs from 'fs/promises';
import path from 'path';
import { appConfig } from './config.js';

function sanitizeEmail(email) {
  return String(email).toLowerCase().replace(/[^a-z0-9._-]/g, '_');
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readJson(filePath, fallback) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, data) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function userDir(email) {
  return path.join(appConfig.dataDir, sanitizeEmail(email));
}

function fileOf(email, name) {
  return path.join(userDir(email), `${name}.json`);
}

function newMonthQuota() {
  return { month: new Date().toISOString().slice(0, 7), aiPlanUsed: 0, rebalanceUsed: 0 };
}

function quotaByTier(planTier) {
  if (planTier === 'pro_monthly') return { ai: 6, rebalance: 10 };
  if (planTier === 'pro_yearly') return { ai: Infinity, rebalance: Infinity };
  return { ai: 2, rebalance: 2 };
}

function newDdayState() {
  return { items: [], primaryId: null };
}

export async function ensureUser(input) {
  const email = input.email.toLowerCase();
  const profilePath = fileOf(email, 'profile');
  const profile = await readJson(profilePath, null);
  if (profile) return profile;

  const created = {
    email,
    passwordHash: input.passwordHash || '',
    planTier: input.planTier || 'free',
    consent: input.consent || { privacy: false, terms: false },
    settings: {
      style: 'steady',
      pressure: 'normal',
      restPattern: '50/10',
      offDays: [0],
      weekdayHours: {
        0: 0,
        1: 150,
        2: 150,
        3: 150,
        4: 150,
        5: 180,
        6: 180
      },
      bufferRatio: 0.2,
      pressureMode: true
    },
    quotas: newMonthQuota(),
    createdAt: new Date().toISOString()
  };

  await writeJson(profilePath, created);
  await writeJson(fileOf(email, 'plans'), { plans: [] });
  await writeJson(fileOf(email, 'calendar'), { tasks: {} });
  await writeJson(fileOf(email, 'ddays'), newDdayState());
  await writeJson(fileOf(email, 'subscriptions'), { push: [] });
  return created;
}

export async function getUserByEmail(email) {
  const profilePath = fileOf(email, 'profile');
  return readJson(profilePath, null);
}

export async function updateProfile(email, patch) {
  const profile = await ensureUser({ email });
  const merged = {
    ...profile,
    ...patch,
    settings: { ...profile.settings, ...(patch.settings || {}) },
    consent: { ...profile.consent, ...(patch.consent || {}) }
  };
  await writeJson(fileOf(email, 'profile'), merged);
  return merged;
}

export async function getDataBundle(email) {
  await ensureUser({ email });
  const [profile, plans, calendar] = await Promise.all([
    readJson(fileOf(email, 'profile'), null),
    readJson(fileOf(email, 'plans'), { plans: [] }),
    readJson(fileOf(email, 'calendar'), { tasks: {} })
  ]);
  return { profile, plans, calendar };
}

export async function savePlans(email, plans) {
  await writeJson(fileOf(email, 'plans'), plans);
}

export async function saveCalendar(email, calendar) {
  await writeJson(fileOf(email, 'calendar'), calendar);
}

export async function getDdayState(email) {
  await ensureUser({ email });
  const state = await readJson(fileOf(email, 'ddays'), newDdayState());
  state.items = Array.isArray(state.items) ? state.items : [];
  state.primaryId = state.primaryId || null;
  return state;
}

export async function saveDdayState(email, state) {
  const payload = {
    items: Array.isArray(state?.items) ? state.items : [],
    primaryId: state?.primaryId || null
  };
  await writeJson(fileOf(email, 'ddays'), payload);
  return payload;
}

function toDdayId() {
  return `dday_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function addAutoDdayFromPlan(email, plan) {
  const targetDate = String(plan?.dueDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) return null;

  const state = await getDdayState(email);
  const sourcePlanId = String(plan?.id || '');
  if (sourcePlanId) {
    const exists = state.items.find((item) => item.sourcePlanId === sourcePlanId);
    if (exists) return state;
  }

  const title = `${plan?.subject || ''} ${plan?.planName || '플랜'}`.trim() || '플랜 D-Day';
  const item = {
    id: toDdayId(),
    title,
    targetDate,
    sourcePlanId: sourcePlanId || null,
    createdAt: new Date().toISOString()
  };
  state.items.push(item);
  if (!state.primaryId) state.primaryId = item.id;
  return saveDdayState(email, state);
}

export async function savePlanDraft(email, draft) {
  const now = new Date().toISOString();
  const payload = {
    id: draft.id,
    source: draft.source || 'fallback',
    plan: draft.plan,
    createdAt: now,
    expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
  };
  await writeJson(fileOf(email, 'plan_draft'), payload);
  return payload;
}

export async function getPlanDraft(email) {
  const draft = await readJson(fileOf(email, 'plan_draft'), null);
  if (!draft) return null;
  if (!draft.expiresAt || new Date(draft.expiresAt) < new Date()) {
    await clearPlanDraft(email);
    return null;
  }
  return draft;
}

export async function clearPlanDraft(email) {
  try {
    await fs.unlink(fileOf(email, 'plan_draft'));
  } catch {
    // ignore if not exists
  }
}

export async function resetQuotaIfNewMonth(email) {
  const profile = await ensureUser({ email });
  const currentMonth = new Date().toISOString().slice(0, 7);
  if (profile.quotas?.month !== currentMonth) {
    profile.quotas = newMonthQuota();
    await writeJson(fileOf(email, 'profile'), profile);
  }
  return profile;
}

export async function consumeQuota(email, type) {
  const profile = await resetQuotaIfNewMonth(email);
  const limits = quotaByTier(profile.planTier);
  const current = profile.quotas || newMonthQuota();

  if (type === 'ai') {
    if (Number.isFinite(limits.ai) && current.aiPlanUsed >= limits.ai) {
      return { ok: false, limits, current };
    }
    current.aiPlanUsed += 1;
  }

  if (type === 'rebalance') {
    if (Number.isFinite(limits.rebalance) && current.rebalanceUsed >= limits.rebalance) {
      return { ok: false, limits, current };
    }
    current.rebalanceUsed += 1;
  }

  profile.quotas = current;
  await writeJson(fileOf(email, 'profile'), profile);
  return { ok: true, limits, current };
}

export function getQuotaSummary(profile) {
  const limits = quotaByTier(profile.planTier);
  const q = profile.quotas || newMonthQuota();
  return {
    month: q.month,
    ai: {
      used: q.aiPlanUsed,
      limit: Number.isFinite(limits.ai) ? limits.ai : 'unlimited'
    },
    rebalance: {
      used: q.rebalanceUsed,
      limit: Number.isFinite(limits.rebalance) ? limits.rebalance : 'unlimited'
    }
  };
}

export async function savePushSubscription(email, subscription) {
  const payload = await readJson(fileOf(email, 'subscriptions'), { push: [] });
  payload.push = payload.push || [];
  const endpoint = subscription?.endpoint;
  if (!endpoint) return payload;
  const now = new Date().toISOString();

  const filtered = payload.push.filter((item) => item.endpoint !== endpoint);
  filtered.push({ ...subscription, endpoint, savedAt: now, updatedAt: now });
  payload.push = filtered;

  await writeJson(fileOf(email, 'subscriptions'), payload);
  return payload;
}

export async function getPushSubscriptions(email) {
  const payload = await readJson(fileOf(email, 'subscriptions'), { push: [] });
  return payload.push || [];
}

export async function removePushSubscriptionsByEndpoints(email, endpoints) {
  const removeSet = new Set((endpoints || []).filter(Boolean));
  if (!removeSet.size) return;
  const payload = await readJson(fileOf(email, 'subscriptions'), { push: [] });
  payload.push = (payload.push || []).filter((item) => !removeSet.has(item.endpoint));
  await writeJson(fileOf(email, 'subscriptions'), payload);
}
