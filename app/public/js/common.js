const AUTH_KEY = 'planrise_auth';
const PENDING_TOAST_KEY = 'planrise_pending_toast';
const TOAST_STACK_ID = 'toastStack';

export function getAuth() {
  try {
    return JSON.parse(localStorage.getItem(AUTH_KEY) || '{}');
  } catch {
    return {};
  }
}

export function setAuth(auth) {
  localStorage.setItem(AUTH_KEY, JSON.stringify(auth));
}

export function clearAuth() {
  localStorage.removeItem(AUTH_KEY);
}

function createToastStack() {
  let stack = document.getElementById(TOAST_STACK_ID);
  if (stack) return stack;
  stack = document.createElement('div');
  stack.id = TOAST_STACK_ID;
  stack.className = 'toast-stack';
  stack.setAttribute('aria-live', 'polite');
  stack.setAttribute('aria-atomic', 'true');
  document.body.appendChild(stack);
  return stack;
}

export function showToast(message, type = 'info', durationMs = 2200) {
  if (!message) return;
  const stack = createToastStack();
  const item = document.createElement('div');
  item.className = `toast toast-${type}`;
  item.textContent = String(message);
  stack.appendChild(item);

  const remove = () => {
    item.classList.add('toast-hide');
    window.setTimeout(() => item.remove(), 180);
  };
  window.setTimeout(remove, Math.max(900, durationMs));
}

function savePendingToast(message, type = 'info') {
  sessionStorage.setItem(PENDING_TOAST_KEY, JSON.stringify({ message, type }));
}

export function queueToast(message, type = 'info') {
  savePendingToast(message, type);
}

function consumePendingToast() {
  const raw = sessionStorage.getItem(PENDING_TOAST_KEY);
  if (!raw) return;
  sessionStorage.removeItem(PENDING_TOAST_KEY);
  try {
    const parsed = JSON.parse(raw);
    showToast(parsed.message, parsed.type || 'info');
  } catch {
    // ignore invalid pending payload
  }
}

function authHeaders(auth) {
  return { 'Content-Type': 'application/json' };
}

function authPayload(payload, auth) {
  return { ...payload, user: auth.user, password: auth.password };
}

export async function apiPost(url, payload = {}, opts = {}) {
  const auth = getAuth();
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(auth),
    body: JSON.stringify(opts.skipAuth ? payload : authPayload(payload, auth))
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !opts.allow401) {
      savePendingToast('로그인이 필요합니다.', 'warn');
      location.href = '/login';
      return;
    }
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

export function ensureAuth() {
  const auth = getAuth();
  if (!auth.user || !auth.password) {
    savePendingToast('로그인이 필요합니다.', 'warn');
    location.href = '/login';
    return false;
  }
  return true;
}

export function formatDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleDateString('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    weekday: 'short'
  });
}

let deferredPrompt = null;

function wireInstallButton() {
  const installBtn = document.getElementById('installBtn');
  if (!installBtn) return;

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
    installBtn.classList.remove('hidden');
  });

  installBtn.addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    if (choice?.outcome === 'accepted') {
      showToast('앱 설치를 진행합니다.', 'success');
    }
    deferredPrompt = null;
    installBtn.classList.add('hidden');
  });
}

function markActiveNav() {
  const path = location.pathname;
  document.querySelectorAll('nav a, .mobile-bar a').forEach((a) => {
    if (a.getAttribute('href') === path) {
      a.classList.add('active');
    }
  });
}

async function registerPwa() {
  if ('serviceWorker' in navigator) {
    await navigator.serviceWorker.register('/sw.js');
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  consumePendingToast();
  wireInstallButton();
  markActiveNav();
  try {
    await registerPwa();
  } catch {
    // ignore PWA registration failure and keep app usable
  }

  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      clearAuth();
      savePendingToast('로그아웃되었습니다.', 'info');
      location.href = '/login';
    });
  }
});
