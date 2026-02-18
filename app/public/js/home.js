import { apiPost, ensureAuth, formatDate, showToast } from './common.js';

if (ensureAuth()) {
  loadHome();
}
let rebalancing = false;

async function loadHome() {
  try {
    const data = await apiPost('/api/home');
    renderHome(data);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function taskView(task, date) {
  const statusText = task.status === 'done' ? '완료' : task.status === 'missed' ? '미완료' : '진행중';
  return `
    <div class="task ${task.status === 'done' ? 'done' : ''}">
      <h4>${task.title}</h4>
      <p>${formatDate(date)} | ${task.pages}p | ${task.minutes}분 | 상태: ${statusText}</p>
      <div class="row" style="margin-top:8px;">
        <button data-action="done" data-date="${date}" data-id="${task.id}" class="ghost">완료</button>
        <button data-action="missed" data-date="${date}" data-id="${task.id}" class="ghost">미완료</button>
      </div>
    </div>
  `;
}

function renderHome(data) {
  const ddayBadge = document.getElementById('ddayBadge');
  if (data.dday?.title) {
    ddayBadge.textContent = `${data.dday.title} ${formatDdayLabel(data.dday.daysLeft)}`;
  } else {
    ddayBadge.textContent = '대표 D-Day 없음';
  }

  document.getElementById('quote').textContent = data.quote;
  if (data.quoteSource === 'openai') {
    showToast('응원 문구를 AI로 생성했습니다.', 'info', 1200);
  }
  document.getElementById('kpiToday').textContent = String(data.todayTasks.length);
  document.getElementById('kpiBacklog').textContent = String(data.backlogCount);

  const ai = data.quota.ai;
  const aiLimit = ai.limit === 'unlimited' ? '무제한' : ai.limit;
  const rebalanceLimit = data.quota.rebalance.limit === 'unlimited' ? '무제한' : data.quota.rebalance.limit;
  document.getElementById('kpiAi').textContent = `${ai.used}/${aiLimit}`;
  document.getElementById('quotaText').textContent = `재분배 ${data.quota.rebalance.used}/${rebalanceLimit} | 기준 월 ${data.quota.month}`;

  const wrap = document.getElementById('todayTasks');
  if (!data.todayTasks.length) {
    wrap.innerHTML = '<p class="sub">오늘 할 일이 없습니다. 플래너에서 새 계획을 만드세요.</p>';
  } else {
    wrap.innerHTML = data.todayTasks.map((t) => taskView(t, data.today)).join('');
  }
}

function formatDdayLabel(daysLeft) {
  if (typeof daysLeft !== 'number' || !Number.isFinite(daysLeft)) return 'D-Day -';
  if (daysLeft === 0) return 'D-Day';
  if (daysLeft > 0) return `D-${daysLeft}`;
  return `D+${Math.abs(daysLeft)}`;
}

document.addEventListener('click', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;

  if (target.id === 'rebalanceBtn') {
    if (rebalancing) return;
    const original = target.textContent;
    rebalancing = true;
    target.disabled = true;
    target.textContent = '재분배중...';
    try {
      await apiPost('/api/plan/rebalance', {});
      await loadHome();
      showToast('재분배를 완료했습니다.', 'success');
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      rebalancing = false;
      target.disabled = false;
      target.textContent = original;
    }
  }

  const action = target.dataset.action;
  if (!action) return;

  try {
    target.disabled = true;
    target.textContent = '처리중...';
    await apiPost('/api/task/status', {
      date: target.dataset.date,
      taskId: target.dataset.id,
      status: action
    });
    await loadHome();
    if (action === 'done') showToast('완료 처리되었습니다.', 'success');
    if (action === 'missed') showToast('미완료 처리되었습니다.', 'warn');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    target.disabled = false;
  }
});
