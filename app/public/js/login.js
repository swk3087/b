import { queueToast, setAuth, showToast } from './common.js';

const authModeEl = document.getElementById('authMode');
const loginForm = document.getElementById('loginForm');
const signupForm = document.getElementById('signupForm');

authModeEl.textContent = '로컬 인증 사용 중';

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const fd = new FormData(loginForm);
  const email = String(fd.get('email'));
  const password = String(fd.get('password'));

  try {
    const res = await fetch('/api/auth/local-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: email, password })
    });

    if (!res.ok) throw new Error('로그인 실패');
    setAuth({ user: email, password });
    queueToast('로그인되었습니다.', 'success');
    location.href = '/';
  } catch (error) {
    showToast(error.message, 'error');
  }
});

signupForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const fd = new FormData(signupForm);
  const email = String(fd.get('email'));
  const password = String(fd.get('password'));
  const consent = {
    privacy: fd.get('privacy') === 'on',
    terms: fd.get('terms') === 'on'
  };

  try {
    const res = await fetch('/api/auth/local-signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, consent })
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || '회원가입 실패');
    }

    showToast('회원가입 완료. 로그인하세요.', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
});
