import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

import { appConfig } from './src/config.js';
import { seedTestUser, resolveUserFromRequest, hashPassword } from './src/auth.js';
import {
  ensureUser,
  getDataBundle,
  savePlans,
  saveCalendar,
  updateProfile,
  consumeQuota,
  getQuotaSummary,
  getUserByEmail,
  savePushSubscription,
  getPushSubscriptions,
  removePushSubscriptionsByEndpoints,
  savePlanDraft,
  getPlanDraft,
  clearPlanDraft,
  getDdayState,
  saveDdayState,
  addAutoDdayFromPlan
} from './src/storage.js';
import { generateCheerMessageWithAI, generatePlanWithAI } from './src/openai.js';
import { planToCalendarPlan, rebalanceFromToday, evaluatePlanFeasibility } from './src/planner.js';
import { pushEnabled, pushPublicKey, sendPushToSubscriptions } from './src/push.js';
import { appendLog, queryLogs, sanitizeLogData } from './src/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use('/public', express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) {
    next();
    return;
  }

  const startedAt = Date.now();
  const hintedUser = String(req.body?.user || req.body?.email || req.query?.user || req.query?.email || '')
    .toLowerCase()
    .trim();
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const requestMeta = sanitizeLogData({
    query: req.query || {},
    body: req.body || {}
  });

  res.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    void appendLog({
      level,
      type: 'api',
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs,
      ip,
      user: hintedUser || null,
      request: requestMeta
    });
  });

  next();
});

await seedTestUser();

function page(file) {
  return (_req, res) => res.sendFile(path.join(__dirname, 'public', file));
}

app.get('/', page('index.html'));
app.get('/login', page('login.html'));
app.get('/planner', page('planner.html'));
app.get('/calendar', page('calendar.html'));
app.get('/dday', page('dday.html'));
app.get('/settings', page('settings.html'));
app.get('/account', page('account.html'));
app.get('/sw.js', page('sw.js'));

app.get('/api/config', (_req, res) => {
  res.json({
    app: { domain: appConfig.domain, baseUrl: appConfig.baseUrl },
    authMode: 'local',
    push: {
      enabled: pushEnabled(),
      vapidPublicKey: pushPublicKey()
    }
  });
});

async function authFromReq(req, res) {
  const info = await resolveUserFromRequest(req);
  if (!info) {
    res.status(401).json({ error: '인증 실패: user/password가 필요합니다.' });
    return null;
  }
  await ensureUser({ email: info.email });
  return info.email;
}

function isDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function daysLeftFrom(todayKey, targetDate) {
  if (!isDateKey(todayKey) || !isDateKey(targetDate)) return null;
  const start = new Date(`${todayKey}T00:00:00Z`).getTime();
  const end = new Date(`${targetDate}T00:00:00Z`).getTime();
  return Math.round((end - start) / 86400000);
}

app.post('/api/auth/local-signup', async (req, res) => {
  try {
    const { email, password, consent } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email/password required' });
    if (!consent?.privacy || !consent?.terms) return res.status(400).json({ error: '약관 동의 필요' });

    const existing = await getUserByEmail(email);
    if (existing) return res.status(409).json({ error: '이미 존재하는 계정' });

    const profile = await ensureUser({
      email,
      passwordHash: hashPassword(password),
      consent,
      planTier: 'free'
    });

    res.json({ ok: true, profile: { email: profile.email } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/local-login', async (req, res) => {
  const user = await resolveUserFromRequest(req);
  if (!user) return res.status(401).json({ error: '로그인 실패' });
  return res.json({ ok: true, user: user.email, authType: user.via });
});

app.post('/api/home', async (req, res) => {
  try {
    const email = await authFromReq(req, res);
    if (!email) return;

    const { profile, calendar } = await getDataBundle(email);
    const today = new Date().toISOString().slice(0, 10);
    const ddayState = await getDdayState(email);
    const primary = ddayState.items.find((item) => item.id === ddayState.primaryId) || null;
    const dday = primary
      ? {
          id: primary.id,
          title: primary.title,
          targetDate: primary.targetDate,
          daysLeft: daysLeftFrom(today, primary.targetDate)
        }
      : null;

    const todayTasks = calendar.tasks?.[today] || [];
    const backlogCount = Object.entries(calendar.tasks || {})
      .filter(([date]) => date < today)
      .reduce((acc, [, tasks]) => acc + tasks.filter((t) => t.status !== 'done').length, 0);

    const cheer = await generateCheerMessageWithAI({
      today,
      todayTaskCount: todayTasks.length,
      backlogCount
    });
    if (cheer.source === 'fallback') {
      void appendLog({
        level: 'warn',
        type: 'openai',
        feature: 'home_cheer',
        user: email,
        detail: cheer.detail || {}
      });
    }

    res.json({
      today,
      dday,
      todayTasks,
      backlogCount,
      quota: getQuotaSummary(profile),
      quote: cheer.message,
      quoteSource: cheer.source,
      quoteSourceDetail: cheer.detail || null
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/calendar', async (req, res) => {
  try {
    const email = await authFromReq(req, res);
    if (!email) return;

    const month = req.body.month || new Date().toISOString().slice(0, 7);
    const { calendar } = await getDataBundle(email);
    const tasks = Object.fromEntries(
      Object.entries(calendar.tasks || {}).filter(([date]) => date.startsWith(month))
    );

    res.json({ month, tasks });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/plan/generate', async (req, res) => {
  try {
    const email = await authFromReq(req, res);
    if (!email) return;

    const { profile } = await getDataBundle(email);

    const input = {
      taskType: req.body.taskType,
      subject: req.body.subject,
      bookName: req.body.bookName,
      startPage: req.body.startPage,
      totalPages: req.body.totalPages,
      minutesPerPage: req.body.minutesPerPage,
      dueDate: req.body.dueDate,
      startDate: req.body.startDate,
      pressureMode: req.body.pressureMode,
      notes: req.body.notes
    };

    const feasibility = evaluatePlanFeasibility(input, profile);
    if (!feasibility.feasible) {
      return res.status(400).json({
        error: feasibility.message || '현재 설정/마감일로는 불가능한 요청입니다.',
        reason: feasibility.reason,
        feasibility
      });
    }

    const quotaCheck = await consumeQuota(email, 'ai');
    if (!quotaCheck.ok) {
      return res.status(402).json({
        error: '월간 AI 플랜 생성 횟수 초과',
        quota: quotaCheck
      });
    }

    const { plan, source, detail } = await generatePlanWithAI(input, profile);
    if (source === 'fallback') {
      void appendLog({
        level: 'warn',
        type: 'openai',
        feature: 'plan_generate',
        user: email,
        detail: detail || {}
      });
    }
    const previewId = `preview_${Date.now()}`;
    await savePlanDraft(email, { id: previewId, source, plan });
    res.json({ ok: true, source, sourceDetail: detail || null, previewId, plan, quota: quotaCheck.current });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/plan/commit', async (req, res) => {
  try {
    const email = await authFromReq(req, res);
    if (!email) return;

    const requestedId = String(req.body?.previewId || '');
    if (!requestedId) return res.status(400).json({ error: 'previewId required' });

    const draft = await getPlanDraft(email);
    if (!draft || draft.id !== requestedId) {
      return res.status(404).json({ error: '저장 가능한 미리보기 플랜이 없습니다. 다시 생성하세요.' });
    }

    const { plans, calendar } = await getDataBundle(email);
    const planWithId = { ...draft.plan, source: draft.source, id: `plan_${Date.now()}` };
    plans.plans.push(planWithId);
    const newCalendar = planToCalendarPlan(draft.plan, calendar);

    await savePlans(email, plans);
    await saveCalendar(email, newCalendar);
    await addAutoDdayFromPlan(email, planWithId);
    await clearPlanDraft(email);

    res.json({ ok: true, plan: planWithId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/dday/list', async (req, res) => {
  try {
    const email = await authFromReq(req, res);
    if (!email) return;
    const state = await getDdayState(email);
    const today = new Date().toISOString().slice(0, 10);
    const items = [...state.items]
      .sort((a, b) => String(a.targetDate || '').localeCompare(String(b.targetDate || '')))
      .map((item) => ({
        ...item,
        isPrimary: item.id === state.primaryId,
        daysLeft: daysLeftFrom(today, item.targetDate)
      }));

    res.json({ ok: true, primaryId: state.primaryId, items });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/dday/create', async (req, res) => {
  try {
    const email = await authFromReq(req, res);
    if (!email) return;
    const title = String(req.body?.title || '').trim();
    const targetDate = String(req.body?.targetDate || '');
    const makePrimary = Boolean(req.body?.makePrimary);
    if (!title) return res.status(400).json({ error: 'title required' });
    if (!isDateKey(targetDate)) return res.status(400).json({ error: 'targetDate must be YYYY-MM-DD' });

    const state = await getDdayState(email);
    const item = {
      id: `dday_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      title,
      targetDate,
      sourcePlanId: null,
      createdAt: new Date().toISOString()
    };
    state.items.push(item);
    if (makePrimary || !state.primaryId) state.primaryId = item.id;
    await saveDdayState(email, state);
    res.json({ ok: true, item: { ...item, isPrimary: state.primaryId === item.id } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/dday/update', async (req, res) => {
  try {
    const email = await authFromReq(req, res);
    if (!email) return;
    const id = String(req.body?.id || '');
    const patch = req.body?.patch || {};
    if (!id) return res.status(400).json({ error: 'id required' });

    const state = await getDdayState(email);
    const idx = state.items.findIndex((item) => item.id === id);
    if (idx === -1) return res.status(404).json({ error: 'dday not found' });

    const current = state.items[idx];
    const next = { ...current };
    if (typeof patch.title === 'string') {
      const title = patch.title.trim();
      if (!title) return res.status(400).json({ error: 'title required' });
      next.title = title;
    }
    if (patch.targetDate !== undefined) {
      const targetDate = String(patch.targetDate || '');
      if (!isDateKey(targetDate)) return res.status(400).json({ error: 'targetDate must be YYYY-MM-DD' });
      next.targetDate = targetDate;
    }
    state.items[idx] = next;
    if (patch.makePrimary === true) state.primaryId = id;
    await saveDdayState(email, state);

    res.json({ ok: true, item: { ...next, isPrimary: state.primaryId === id } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/dday/delete', async (req, res) => {
  try {
    const email = await authFromReq(req, res);
    if (!email) return;
    const id = String(req.body?.id || '');
    if (!id) return res.status(400).json({ error: 'id required' });

    const state = await getDdayState(email);
    const before = state.items.length;
    state.items = state.items.filter((item) => item.id !== id);
    if (state.items.length === before) return res.status(404).json({ error: 'dday not found' });

    if (state.primaryId === id) {
      state.primaryId = state.items[0]?.id || null;
    }
    await saveDdayState(email, state);
    res.json({ ok: true, primaryId: state.primaryId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/dday/set-primary', async (req, res) => {
  try {
    const email = await authFromReq(req, res);
    if (!email) return;
    const id = String(req.body?.id || '');
    if (!id) return res.status(400).json({ error: 'id required' });

    const state = await getDdayState(email);
    const exists = state.items.some((item) => item.id === id);
    if (!exists) return res.status(404).json({ error: 'dday not found' });

    state.primaryId = id;
    await saveDdayState(email, state);
    res.json({ ok: true, primaryId: id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/plan/rebalance', async (req, res) => {
  try {
    const email = await authFromReq(req, res);
    if (!email) return;

    const quotaCheck = await consumeQuota(email, 'rebalance');
    if (!quotaCheck.ok) {
      return res.status(402).json({ error: '월간 재분배 횟수 초과', quota: quotaCheck });
    }

    const { profile, calendar } = await getDataBundle(email);
    const today = new Date().toISOString().slice(0, 10);
    const updated = rebalanceFromToday(profile, calendar, today);
    await saveCalendar(email, updated);

    res.json({ ok: true, today, tasks: updated.tasks?.[today] || [], quota: quotaCheck.current });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/task/status', async (req, res) => {
  try {
    const email = await authFromReq(req, res);
    if (!email) return;

    const { date, taskId, status } = req.body;
    if (!date || !taskId || !status) return res.status(400).json({ error: 'date/taskId/status required' });
    const allowedStatus = new Set(['done', 'pending', 'missed']);
    if (!allowedStatus.has(status)) return res.status(400).json({ error: 'invalid status' });

    const { calendar } = await getDataBundle(email);
    const list = calendar.tasks?.[date] || [];
    let found = false;
    const next = list.map((t) => {
      if (t.id !== taskId) return t;
      found = true;
      return { ...t, status };
    });
    if (!found) return res.status(404).json({ error: 'task not found on selected date' });
    calendar.tasks[date] = next;
    await saveCalendar(email, calendar);

    res.json({ ok: true, tasks: next });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/task/update', async (req, res) => {
  try {
    const email = await authFromReq(req, res);
    if (!email) return;

    const { fromDate, taskId, patch } = req.body;
    if (!fromDate || !taskId || !patch) {
      return res.status(400).json({ error: 'fromDate/taskId/patch required' });
    }

    const { calendar } = await getDataBundle(email);
    const sourceList = calendar.tasks?.[fromDate] || [];
    const idx = sourceList.findIndex((t) => t.id === taskId);
    if (idx === -1) return res.status(404).json({ error: 'task not found on selected date' });

    const rawTask = sourceList[idx];
    const allowedStatus = new Set(['done', 'pending', 'missed']);
    const toDate = String(patch.date || fromDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(toDate)) return res.status(400).json({ error: 'invalid target date' });

    const nextTask = {
      ...rawTask,
      title: typeof patch.title === 'string' ? patch.title.trim() || rawTask.title : rawTask.title,
      pages: typeof patch.pages === 'string' ? patch.pages.trim() || rawTask.pages : rawTask.pages,
      minutes: Number.isFinite(Number(patch.minutes)) ? Math.max(1, Math.floor(Number(patch.minutes))) : rawTask.minutes,
      status: allowedStatus.has(String(patch.status)) ? String(patch.status) : rawTask.status
    };

    sourceList.splice(idx, 1);
    if (!sourceList.length) delete calendar.tasks[fromDate];
    else calendar.tasks[fromDate] = sourceList;

    calendar.tasks[toDate] = calendar.tasks[toDate] || [];
    calendar.tasks[toDate].push(nextTask);
    await saveCalendar(email, calendar);

    res.json({ ok: true, date: toDate, task: nextTask });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/task/delete', async (req, res) => {
  try {
    const email = await authFromReq(req, res);
    if (!email) return;

    const { date, taskId } = req.body;
    if (!date || !taskId) return res.status(400).json({ error: 'date/taskId required' });

    const { calendar } = await getDataBundle(email);
    const list = calendar.tasks?.[date] || [];
    const filtered = list.filter((t) => t.id !== taskId);
    if (filtered.length === list.length) return res.status(404).json({ error: 'task not found on selected date' });

    if (!filtered.length) delete calendar.tasks[date];
    else calendar.tasks[date] = filtered;
    await saveCalendar(email, calendar);

    res.json({ ok: true, deleted: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/calendar/clear', async (req, res) => {
  try {
    const email = await authFromReq(req, res);
    if (!email) return;

    const scope = req.body?.scope === 'all' ? 'all' : 'month';
    const month = String(req.body?.month || new Date().toISOString().slice(0, 7));

    const { calendar } = await getDataBundle(email);
    const tasks = calendar.tasks || {};
    let removed = 0;

    if (scope === 'all') {
      removed = Object.values(tasks).reduce((acc, list) => acc + list.length, 0);
      calendar.tasks = {};
    } else {
      const keep = {};
      for (const [date, list] of Object.entries(tasks)) {
        if (date.startsWith(month)) {
          removed += list.length;
        } else {
          keep[date] = list;
        }
      }
      calendar.tasks = keep;
    }

    await saveCalendar(email, calendar);
    res.json({ ok: true, scope, month, removed });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/settings/get', async (req, res) => {
  try {
    const email = await authFromReq(req, res);
    if (!email) return;
    const { profile } = await getDataBundle(email);
    res.json({ settings: profile.settings, consent: profile.consent, planTier: profile.planTier });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/settings/update', async (req, res) => {
  try {
    const email = await authFromReq(req, res);
    if (!email) return;

    const { settings } = req.body;
    const updated = await updateProfile(email, { settings });
    res.json({ ok: true, settings: updated.settings });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/logs', async (req, res) => {
  try {
    const email = await authFromReq(req, res);
    if (!email) return;

    const types =
      typeof req.body?.types === 'string'
        ? req.body.types.split(',').map((v) => v.trim()).filter(Boolean)
        : Array.isArray(req.body?.types)
          ? req.body.types
          : undefined;

    const isAdmin = email === 'a@b.c';
    const scope = req.body?.scope === 'all' && isAdmin ? 'all' : 'mine';
    const result = await queryLogs({
      user: scope === 'all' ? '' : email,
      days: req.body?.days,
      limit: req.body?.limit,
      from: req.body?.from,
      to: req.body?.to,
      types
    });

    res.json({
      ok: true,
      scope,
      ...result
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/account/get', async (req, res) => {
  try {
    const email = await authFromReq(req, res);
    if (!email) return;

    const { profile } = await getDataBundle(email);
    res.json({
      email: profile.email,
      planTier: profile.planTier,
      quota: getQuotaSummary(profile),
      authMode: 'local',
      pushEnabled: pushEnabled()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/account/plan', async (req, res) => {
  try {
    const email = await authFromReq(req, res);
    if (!email) return;

    const { planTier } = req.body;
    const valid = ['free', 'pro_monthly', 'pro_yearly'];
    if (!valid.includes(planTier)) return res.status(400).json({ error: 'invalid tier' });

    const updated = await updateProfile(email, { planTier });
    res.json({ ok: true, planTier: updated.planTier });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/push/subscribe', async (req, res) => {
  try {
    const email = await authFromReq(req, res);
    if (!email) return;
    if (!pushEnabled()) return res.status(503).json({ error: 'web-push VAPID 설정이 필요합니다.' });

    const { subscription } = req.body;
    if (!subscription?.endpoint) return res.status(400).json({ error: 'subscription endpoint required' });
    const saved = await savePushSubscription(email, subscription);
    res.json({ ok: true, count: saved.push.length, endpoint: subscription.endpoint });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/push/test', async (req, res) => {
  try {
    const email = await authFromReq(req, res);
    if (!email) return;
    if (!pushEnabled()) return res.status(503).json({ error: 'web-push VAPID 설정이 필요합니다.' });

    const subscriptions = await getPushSubscriptions(email);
    if (!subscriptions.length) {
      return res.status(400).json({ error: '저장된 push subscription이 없습니다. 먼저 구독하세요.' });
    }

    const payload = {
      title: req.body?.title || 'PlanRiseAI',
      body: req.body?.body || '테스트 푸시: 오늘 할 일을 시작하세요.',
      url: req.body?.url || '/'
    };

    const result = await sendPushToSubscriptions(subscriptions, payload);
    await removePushSubscriptionsByEndpoints(email, result.invalidEndpoints);

    res.json({
      ok: true,
      sent: result.sent,
      failed: result.failed,
      removedInvalid: result.invalidEndpoints.length
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(appConfig.port, () => {
  console.log(`PlanRiseAI app listening on ${appConfig.baseUrl}`);
  void appendLog({
    level: 'info',
    type: 'system',
    event: 'startup',
    message: `server listening on ${appConfig.baseUrl}`
  });
});
