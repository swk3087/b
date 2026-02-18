import { apiPost, ensureAuth, formatDate, showToast } from './common.js';

if (!ensureAuth()) {
  // redirected
}

const form = document.getElementById('planForm');
const preview = document.getElementById('planPreview');
const submitBtn = form.querySelector('button[type="submit"]');
let currentPreviewId = '';
let busy = false;

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy) return;
  const fd = new FormData(form);

  const payload = {
    taskType: fd.get('taskType'),
    subject: fd.get('subject'),
    bookName: fd.get('bookName'),
    startPage: Number(fd.get('startPage')),
    totalPages: Number(fd.get('totalPages')),
    minutesPerPage: Number(fd.get('minutesPerPage')),
    dueDate: fd.get('dueDate'),
    startDate: new Date().toISOString().slice(0, 10),
    notes: fd.get('notes'),
    pressureMode: fd.get('pressureMode') === 'on'
  };

  setBusy(true, '생성중...');
  preview.innerHTML = '<p class="sub">AI가 플랜을 생성중입니다. 잠시만 기다려주세요...</p>';

  try {
    const data = await apiPost('/api/plan/generate', payload);
    currentPreviewId = data.previewId || '';
    renderPreview(data.plan, data.source, data.sourceDetail);
    if (data.source === 'fallback') {
      showToast(`fallback: ${formatSourceDetail(data.sourceDetail)}`, 'warn', 3200);
    } else {
      showToast('플랜 미리보기가 생성되었습니다.', 'success');
    }
  } catch (error) {
    preview.innerHTML = `<p class="notice">${error.message}</p>`;
    showToast(error.message, 'error');
  } finally {
    setBusy(false, '플랜 생성');
  }
});

preview.addEventListener('click', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;
  if (busy) return;

  if (target.dataset.action === 'discard') {
    currentPreviewId = '';
    preview.innerHTML = '<p class="sub">생성된 미리보기를 취소했습니다. 필요하면 다시 생성하세요.</p>';
    showToast('미리보기를 취소했습니다.', 'info');
    return;
  }

  if (target.dataset.action === 'save') {
    if (!currentPreviewId) return;
    const ok = window.confirm('이 플랜을 캘린더에 저장할까요?');
    if (!ok) {
      showToast('저장을 취소했습니다.', 'info');
      return;
    }

    setBusy(true, '저장중...');
    try {
      await apiPost('/api/plan/commit', { previewId: currentPreviewId });
      preview.innerHTML = '<p class="badge">저장 완료</p><p class="sub" style="margin-top:8px;">플랜이 캘린더에 반영되었습니다.</p>';
      currentPreviewId = '';
      showToast('플랜이 저장되었습니다.', 'success');
    } catch (error) {
      preview.innerHTML = `<p class="notice">${error.message}</p>`;
      showToast(error.message, 'error');
    } finally {
      setBusy(false, '플랜 생성');
    }
  }
});

function renderPreview(plan, source, sourceDetail) {
  const schedule = plan?.schedule || [];
  const detailText = source === 'fallback' ? formatSourceDetail(sourceDetail) : 'OpenAI 생성 성공';
  preview.innerHTML = `
    <p class="badge">생성 소스: ${source}</p>
    <p class="sub" style="margin-top:6px;">원인: ${detailText}</p>
    <p class="sub" style="margin-top:8px;">미리보기입니다. 저장 버튼을 눌러야 실제 캘린더에 반영됩니다.</p>
    <div class="row" style="margin:10px 0 12px;">
      <button data-action="save">이대로 저장</button>
      <button data-action="discard" class="ghost">취소</button>
    </div>
    ${schedule
      .slice(0, 12)
      .map(
        (it) => `<div class="task"><h4>${formatDate(it.date)}</h4><p>${it.pageFrom}-${it.pageTo}p / ${it.minutes}분</p></div>`
      )
      .join('')}
    ${schedule.length > 12 ? `<p class="sub">총 ${schedule.length}일치가 생성되었습니다.</p>` : ''}
  `;
}

function formatSourceDetail(detail) {
  if (!detail) return '원인 정보 없음';
  const status = detail.httpStatus ? `HTTP ${detail.httpStatus}` : '';
  const msg = detail.errorMessage || detail.reason || '알 수 없음';
  const code = detail.errorCode ? `(${detail.errorCode})` : '';
  return [status, code, msg].filter(Boolean).join(' ');
}

function setBusy(nextBusy, label) {
  busy = nextBusy;
  submitBtn.disabled = nextBusy;
  submitBtn.textContent = label;
  const actionButtons = preview.querySelectorAll('button');
  actionButtons.forEach((btn) => {
    btn.disabled = nextBusy;
  });
}
