const AUTH_KEY = 'planrise_auth';
const PENDING_TOAST_KEY = 'planrise_pending_toast';
const TOAST_STACK_ID = 'toastStack';
const THEME_KEY = 'planrise_theme';

function normalizeTheme(theme) {
  return theme === 'dark' ? 'dark' : 'light';
}

function readTheme() {
  try {
    return normalizeTheme(localStorage.getItem(THEME_KEY) || 'light');
  } catch {
    return 'light';
  }
}

function writeTheme(theme) {
  try {
    localStorage.setItem(THEME_KEY, normalizeTheme(theme));
  } catch {
    // ignore storage errors
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', normalizeTheme(theme));
}

function currentTheme() {
  return normalizeTheme(document.documentElement.getAttribute('data-theme') || 'light');
}

function updateThemeToggleLabel(button, theme) {
  button.textContent = theme === 'dark' ? '화이트 모드' : '블랙 모드';
}

function injectThemeToggle() {
  const topbar = document.querySelector('header .topbar');
  if (!topbar) return;

  let button = document.getElementById('themeToggleBtn');
  if (!button) {
    button = document.createElement('button');
    button.id = 'themeToggleBtn';
    button.type = 'button';
    button.className = 'ghost theme-toggle';
    button.setAttribute('aria-label', '블랙/화이트 모드 전환');

    const installWrap = topbar.querySelector('.install-wrap');
    if (installWrap) {
      installWrap.prepend(button);
    } else {
      button.style.marginLeft = 'auto';
      topbar.appendChild(button);
    }
  }

  updateThemeToggleLabel(button, currentTheme());
  button.addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    writeTheme(next);
    updateThemeToggleLabel(button, next);
    showToast(next === 'dark' ? '블랙 모드로 변경되었습니다.' : '화이트 모드로 변경되었습니다.', 'info', 1200);
  });
}

applyTheme(readTheme());

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

function applyLayoutFlags() {
  if (document.querySelector('header nav')) {
    document.body.classList.add('has-side-nav');
  } else {
    document.body.classList.remove('has-side-nav');
  }
}

async function registerPwa() {
  if ('serviceWorker' in navigator) {
    await navigator.serviceWorker.register('/sw.js');
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  applyTheme(readTheme());
  consumePendingToast();
  injectThemeToggle();
  applyLayoutFlags();
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
