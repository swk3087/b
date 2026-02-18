import { apiPost, ensureAuth, showToast } from './common.js';

if (ensureAuth()) {
  load();
}

async function load() {
  try {
    const data = await apiPost('/api/account/get');
    document.getElementById('accountEmail').textContent = `이메일: ${data.email}`;
    const aiLimit = data.quota.ai.limit === 'unlimited' ? '무제한' : data.quota.ai.limit;
    const reLimit = data.quota.rebalance.limit === 'unlimited' ? '무제한' : data.quota.rebalance.limit;
    document.getElementById('quotaInfo').textContent = `현재 요금제: ${displayTier(data.planTier)} | AI ${data.quota.ai.used}/${aiLimit} | 재분배 ${data.quota.rebalance.used}/${reLimit}`;
    highlightCurrentTier(data.planTier);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

document.querySelectorAll('.tierBtn').forEach((btn) => {
  btn.addEventListener('click', async () => {
    try {
      await apiPost('/api/account/plan', { planTier: btn.dataset.tier });
      await load();
      showToast('요금제가 변경되었습니다.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    }
  });
});

function highlightCurrentTier(tier) {
  document.querySelectorAll('[data-tier-card]').forEach((card) => {
    const active = card.getAttribute('data-tier-card') === tier;
    card.classList.toggle('active-tier', active);
    const btn = card.querySelector('.tierBtn');
    if (btn instanceof HTMLButtonElement) {
      btn.textContent = active ? '현재 요금제' : '이 요금제 선택';
      btn.disabled = active;
    }
  });
}

function displayTier(tier) {
  if (tier === 'pro_monthly') return '월간';
  if (tier === 'pro_yearly') return '연간';
  return '무료';
}
