import { apiPost, ensureAuth, showToast } from './common.js';

if (!ensureAuth()) {
  // redirected
}

const form = document.getElementById('ddayForm');
const listEl = document.getElementById('ddayList');

form.targetDate.value = new Date().toISOString().slice(0, 10);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const fd = new FormData(form);

  try {
    await apiPost('/api/dday/create', {
      title: String(fd.get('title') || '').trim(),
      targetDate: String(fd.get('targetDate') || ''),
      makePrimary: fd.get('makePrimary') === 'on'
    });
    showToast('D-Day를 추가했습니다.', 'success');
    form.title.value = '';
    form.makePrimary.checked = false;
    await loadDdays();
  } catch (error) {
    showToast(error.message, 'error');
  }
});

listEl.addEventListener('click', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;
  const action = target.dataset.action;
  const id = target.dataset.id;
  if (!action || !id) return;

  if (action === 'primary') {
    try {
      await apiPost('/api/dday/set-primary', { id });
      showToast('대표 D-Day를 변경했습니다.', 'success');
      await loadDdays();
    } catch (error) {
      showToast(error.message, 'error');
    }
    return;
  }

  if (action === 'delete') {
    const ok = window.confirm('이 D-Day를 삭제할까요?');
    if (!ok) return;
    try {
      await apiPost('/api/dday/delete', { id });
      showToast('D-Day를 삭제했습니다.', 'success');
      await loadDdays();
    } catch (error) {
      showToast(error.message, 'error');
    }
    return;
  }

  if (action === 'edit') {
    const row = target.closest('[data-dday-row]');
    if (!(row instanceof HTMLElement)) return;
    const titleInput = row.querySelector('input[name="title"]');
    const dateInput = row.querySelector('input[name="targetDate"]');
    if (!(titleInput instanceof HTMLInputElement) || !(dateInput instanceof HTMLInputElement)) return;

    try {
      await apiPost('/api/dday/update', {
        id,
        patch: {
          title: titleInput.value,
          targetDate: dateInput.value
        }
      });
      showToast('D-Day를 수정했습니다.', 'success');
      await loadDdays();
    } catch (error) {
      showToast(error.message, 'error');
    }
  }
});

loadDdays();

async function loadDdays() {
  try {
    const data = await apiPost('/api/dday/list', {});
    const items = data.items || [];
    if (!items.length) {
      listEl.innerHTML = '<p class="sub">등록된 D-Day가 없습니다.</p>';
      return;
    }

    listEl.innerHTML = items
      .map((item) => {
        const dLabel = formatDays(item.daysLeft);
        return `
          <div class="task" data-dday-row>
            <div class="row" style="justify-content:space-between; align-items:flex-start;">
              <div>
                <strong>${escapeHtml(item.title)}</strong>
                <p class="sub" style="margin-top:4px;">${item.targetDate} | ${dLabel}</p>
              </div>
              ${item.isPrimary ? '<span class="badge">대표</span>' : ''}
            </div>
            <div class="editor-grid" style="margin-top:8px;">
              <div class="field"><label>제목</label><input name="title" value="${escapeAttr(item.title)}" /></div>
              <div class="field"><label>날짜</label><input type="date" name="targetDate" value="${item.targetDate}" /></div>
            </div>
            <div class="row">
              <button data-action="edit" data-id="${item.id}">수정</button>
              <button data-action="primary" data-id="${item.id}" class="ghost">대표로 설정</button>
              <button data-action="delete" data-id="${item.id}" class="warn">삭제</button>
            </div>
          </div>
        `;
      })
      .join('');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function formatDays(daysLeft) {
  if (!Number.isFinite(daysLeft)) return 'D-Day -';
  if (daysLeft === 0) return 'D-Day';
  if (daysLeft > 0) return `D-${daysLeft}`;
  return `D+${Math.abs(daysLeft)}`;
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
