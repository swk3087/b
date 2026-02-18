import { apiPost, ensureAuth, showToast } from './common.js';

if (!ensureAuth()) {
  // redirected
}

const form = document.getElementById('settingsForm');
const bufferSlider = document.getElementById('bufferSlider');
const bufferPercent = document.getElementById('bufferPercent');
const offDayChecks = Array.from(document.querySelectorAll('input[name="offDay"]'));
const dayHourInputs = Array.from(document.querySelectorAll('input[data-day-hour]'));

init();
wireNotificationButtons();
wireBufferControls();

async function init() {
  try {
    const data = await apiPost('/api/settings/get');
    const s = data.settings || {};

    form.style.value = s.style || 'steady';
    form.pressure.value = s.pressure || 'normal';
    form.restPattern.value = s.restPattern || '50/10';
    setBufferRatioValue(s.bufferRatio ?? 0.2);

    const offDays = new Set((s.offDays || []).map((v) => Number(v)));
    offDayChecks.forEach((input) => {
      input.checked = offDays.has(Number(input.value));
    });

    const weekdayHours = s.weekdayHours || {};
    dayHourInputs.forEach((input) => {
      const day = String(input.dataset.dayHour);
      input.value = Number(weekdayHours[day] ?? 0);
    });
  } catch (error) {
    showToast(error.message, 'error');
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const settings = {
      style: form.style.value,
      pressure: form.pressure.value,
      restPattern: form.restPattern.value,
      bufferRatio: normalizeBufferRatio(Number(form.bufferRatio.value)),
      offDays: offDayChecks
        .filter((input) => input.checked)
        .map((input) => Number(input.value))
        .filter((v) => Number.isInteger(v) && v >= 0 && v <= 6),
      weekdayHours: toWeekdayHours()
    };

    await apiPost('/api/settings/update', { settings });
    showToast('설정이 저장되었습니다.', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
});

function wireBufferControls() {
  bufferSlider.addEventListener('input', () => {
    setBufferRatioValue(Number(bufferSlider.value));
  });

  form.bufferRatio.addEventListener('input', () => {
    setBufferRatioValue(Number(form.bufferRatio.value));
  });
}

function normalizeBufferRatio(value) {
  if (!Number.isFinite(value)) return 0.2;
  return Math.min(0.4, Math.max(0.1, value));
}

function setBufferRatioValue(value) {
  const normalized = normalizeBufferRatio(value);
  form.bufferRatio.value = normalized.toFixed(2);
  bufferSlider.value = normalized.toFixed(2);
  bufferPercent.textContent = `${Math.round(normalized * 100)}%`;
}

function toWeekdayHours() {
  const payload = {};
  dayHourInputs.forEach((input) => {
    const key = String(input.dataset.dayHour);
    const value = Number(input.value);
    payload[key] = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  });
  return payload;
}

function wireNotificationButtons() {
  const stateEl = document.getElementById('notifState');
  const permBtn = document.getElementById('notifPermBtn');
  const subBtn = document.getElementById('pushSubBtn');
  const testBtn = document.getElementById('testNotifBtn');
  let vapidPublicKey = '';
  let pushServerEnabled = false;
  let subBusy = false;
  let testBusy = false;

  initPushConfig();

  permBtn.addEventListener('click', async () => {
    if (typeof Notification === 'undefined') {
      showToast('이 브라우저는 알림 기능을 지원하지 않습니다.', 'error');
      return;
    }
    const perm = await Notification.requestPermission();
    stateEl.textContent = `현재 알림 권한: ${perm} | Push 서버: ${pushServerEnabled ? '활성' : '비활성'}`;
    showToast(`알림 권한: ${perm}`, perm === 'granted' ? 'success' : 'warn');
  });

  subBtn.addEventListener('click', async () => {
    if (subBusy) return;
    subBusy = true;
    const old = subBtn.textContent;
    subBtn.disabled = true;
    subBtn.textContent = '구독중...';
    try {
      await ensureSubscriptionSaved(false);
      showToast('Push 구독이 저장되었습니다.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      subBusy = false;
      subBtn.disabled = false;
      subBtn.textContent = old;
    }
  });

  testBtn.addEventListener('click', async () => {
    if (testBusy) return;
    testBusy = true;
    const old = testBtn.textContent;
    testBtn.disabled = true;
    testBtn.textContent = '발송중...';
    try {
      await ensureSubscriptionSaved(false);
      const result = await apiPost('/api/push/test', {});
      showToast(`푸시 발송 완료: 성공 ${result.sent}, 실패 ${result.failed}`, result.failed ? 'warn' : 'success');
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      testBusy = false;
      testBtn.disabled = false;
      testBtn.textContent = old;
    }
  });

  async function ensureSubscriptionSaved(notifySaved = true) {
    if (!pushServerEnabled) throw new Error('서버 web-push 설정이 비어있습니다.');
    if (!vapidPublicKey) throw new Error('VAPID 공개키가 없습니다. 서버 설정을 확인하세요.');
    if (!('serviceWorker' in navigator)) throw new Error('이 브라우저는 Service Worker를 지원하지 않습니다.');
    if (typeof Notification === 'undefined') throw new Error('이 브라우저는 알림 기능을 지원하지 않습니다.');
    if (Notification.permission !== 'granted') throw new Error('알림 권한을 먼저 허용하세요.');

    const subscription = await getOrCreateSubscription();
    if (!subscription?.endpoint) throw new Error('브라우저 Push 구독 생성에 실패했습니다.');
    await apiPost('/api/push/subscribe', { subscription: subscription.toJSON() });
    if (notifySaved) {
      showToast('브라우저 구독을 서버에 저장했습니다.', 'info', 1400);
    }
  }

  async function getOrCreateSubscription() {
    const registerPromise = navigator.serviceWorker.register('/sw.js');
    const reg = await withTimeout(registerPromise, 6000, 'Service Worker 등록이 지연되고 있습니다.');
    const readyReg = await withTimeout(
      navigator.serviceWorker.ready,
      8000,
      'Service Worker 준비가 지연되고 있습니다. 새로고침 후 다시 시도하세요.'
    );
    const activeReg = readyReg || reg;

    let subscription = await activeReg.pushManager.getSubscription();
    if (!subscription) {
      subscription = await activeReg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
      });
    }
    return subscription;
  }

  async function withTimeout(promise, timeoutMs, message) {
    let timer = null;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
        })
      ]);
    } finally {
      if (timer) window.clearTimeout(timer);
    }
  }

  async function initPushConfig() {
    try {
      const cfg = await fetch('/api/config').then((r) => r.json());
      pushServerEnabled = Boolean(cfg?.push?.enabled);
      vapidPublicKey = String(cfg?.push?.vapidPublicKey || '');
      const perm = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
      stateEl.textContent = `현재 알림 권한: ${perm} | Push 서버: ${pushServerEnabled ? '활성' : '비활성'}`;
    } catch {
      const perm = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
      stateEl.textContent = `현재 알림 권한: ${perm} | Push 서버 상태 확인 실패`;
      showToast('Push 서버 상태 확인에 실패했습니다.', 'error');
    }
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
