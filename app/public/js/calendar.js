import { apiPost, ensureAuth, formatDate, showToast } from './common.js';

if (!ensureAuth()) {
  // redirected
}

const monthInput = document.getElementById('monthInput');
const listEl = document.getElementById('calendarList');
const clearMonthBtn = document.getElementById('clearMonthBtn');
const clearAllBtn = document.getElementById('clearAllBtn');

monthInput.value = new Date().toISOString().slice(0, 7);
monthInput.addEventListener('change', () => loadMonth(true));

clearMonthBtn.addEventListener('click', () => clearCalendar('month'));
clearAllBtn.addEventListener('click', () => clearCalendar('all'));

listEl.addEventListener('click', onListClick);

loadMonth(false);

async function loadMonth(notify) {
  try {
    const data = await apiPost('/api/calendar', { month: monthInput.value });
    const dates = Object.keys(data.tasks || {}).sort();

    if (!dates.length) {
      listEl.innerHTML = '<p class="sub">해당 월에 저장된 일정이 없습니다.</p>';
      if (notify) showToast('해당 월에 일정이 없습니다.', 'info');
      return;
    }

    listEl.innerHTML = dates
      .map((date) => renderDateBlock(date, data.tasks[date] || []))
      .join('');

    if (notify) showToast('캘린더를 불러왔습니다.', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function renderDateBlock(date, tasks) {
  return `
    <div class="card" style="margin-bottom:10px;">
      <h3 class="title" style="font-size:15px;">${formatDate(date)} <span class="sub">(${date})</span></h3>
      ${tasks.map((task) => renderTask(date, task)).join('')}
    </div>
  `;
}

function renderTask(date, task) {
  const statusLabel = task.status === 'done' ? '완료' : task.status === 'missed' ? '미완료' : '진행중';
  return `
    <div class="task ${task.status === 'done' ? 'done' : ''}" data-task-id="${escapeHtml(task.id)}" data-date="${date}">
      <h4>${escapeHtml(task.title)}</h4>
      <p>${escapeHtml(task.pages)}p / ${task.minutes}분 / ${statusLabel}</p>
      <div class="row task-actions" style="margin-top:8px;">
        <button class="ghost" data-action="open-edit">수정</button>
        <button class="warn" data-action="delete">삭제</button>
      </div>
      <form class="edit-form hidden" data-role="editor" style="margin-top:10px;">
        <div class="editor-grid">
          <div class="field"><label>제목</label><input name="title" value="${escapeAttr(task.title)}" required /></div>
          <div class="field"><label>날짜</label><input type="date" name="date" value="${date}" required /></div>
          <div class="field"><label>페이지</label><input name="pages" value="${escapeAttr(task.pages)}" required /></div>
          <div class="field"><label>분</label><input type="number" min="1" name="minutes" value="${task.minutes}" required /></div>
          <div class="field"><label>상태</label>
            <select name="status">
              <option value="pending" ${task.status === 'pending' ? 'selected' : ''}>진행중</option>
              <option value="done" ${task.status === 'done' ? 'selected' : ''}>완료</option>
              <option value="missed" ${task.status === 'missed' ? 'selected' : ''}>미완료</option>
            </select>
          </div>
        </div>
        <div class="row">
          <button type="button" data-action="save-edit">저장</button>
          <button type="button" class="ghost" data-action="cancel-edit">취소</button>
        </div>
      </form>
    </div>
  `;
}

async function onListClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;

  const action = target.dataset.action;
  if (!action) return;

  const taskRoot = target.closest('.task');
  if (!(taskRoot instanceof HTMLElement)) return;

  const taskId = taskRoot.dataset.taskId;
  const fromDate = taskRoot.dataset.date;
  if (!taskId || !fromDate) return;

  const editor = taskRoot.querySelector('[data-role="editor"]');
  if (!(editor instanceof HTMLFormElement)) return;

  if (action === 'open-edit') {
    editor.classList.remove('hidden');
    target.disabled = true;
    return;
  }

  if (action === 'cancel-edit') {
    editor.classList.add('hidden');
    const openBtn = taskRoot.querySelector('button[data-action="open-edit"]');
    if (openBtn instanceof HTMLButtonElement) openBtn.disabled = false;
    return;
  }

  if (action === 'delete') {
    const ok = window.confirm('이 할 일을 삭제할까요?');
    if (!ok) return;
    target.disabled = true;
    try {
      await apiPost('/api/task/delete', { date: fromDate, taskId });
      showToast('일정을 삭제했습니다.', 'success');
      await loadMonth(false);
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      target.disabled = false;
    }
    return;
  }

  if (action === 'save-edit') {
    event.preventDefault();
    const formData = new FormData(editor);
    const patch = {
      title: String(formData.get('title') || ''),
      date: String(formData.get('date') || ''),
      pages: String(formData.get('pages') || ''),
      minutes: Number(formData.get('minutes') || 0),
      status: String(formData.get('status') || 'pending')
    };

    target.disabled = true;
    try {
      await apiPost('/api/task/update', { fromDate, taskId, patch });
      showToast('일정을 수정했습니다.', 'success');
      await loadMonth(false);
    } catch (error) {
      showToast(error.message, 'error');
    } finally {
      target.disabled = false;
    }
  }
}

async function clearCalendar(scope) {
  const isAll = scope === 'all';
  const ok = window.confirm(isAll ? '전체 일정을 모두 삭제할까요?' : `${monthInput.value} 일정을 모두 삭제할까요?`);
  if (!ok) return;

  const targetBtn = isAll ? clearAllBtn : clearMonthBtn;
  const original = targetBtn.textContent;
  targetBtn.disabled = true;
  targetBtn.textContent = '삭제중...';

  try {
    const data = await apiPost('/api/calendar/clear', {
      scope,
      month: monthInput.value
    });
    showToast(`${data.removed}개 일정을 삭제했습니다.`, 'success');
    await loadMonth(false);
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    targetBtn.disabled = false;
    targetBtn.textContent = original;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll('`', '&#96;');
}
