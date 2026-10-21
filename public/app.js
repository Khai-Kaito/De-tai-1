const labels = {
  books: { title: 'Kho sách', kicker: 'DANH MỤC', description: 'Theo dõi bộ sưu tập và số bản có thể cho mượn.', add: 'Thêm sách' },
  readers: { title: 'Độc giả', kicker: 'CỘNG ĐỒNG', description: 'Quản lý thông tin và liên hệ của bạn đọc.', add: 'Thêm độc giả' },
  loans: { title: 'Mượn & trả', kicker: 'GIAO DỊCH', description: 'Theo dõi các lượt mượn đang mở và lịch sử trả sách.', add: 'Tạo lượt mượn' }
};
const state = { view: 'books', books: [], readers: [], loans: [], editing: null, query: '' };
const byId = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

async function api(path, options = {}) {
  const headers = { 'X-Requested-With': 'XMLHttpRequest', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers };
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Không thể hoàn thành yêu cầu.');
  return data;
}

function notify(message) {
  const toast = byId('toast');
  toast.textContent = message;
  toast.classList.add('is-visible');
  window.setTimeout(() => toast.classList.remove('is-visible'), 2600);
}

function setView(view) {
  state.view = view;
  document.querySelectorAll('.nav-item').forEach((button) => button.classList.toggle('is-active', button.dataset.view === view));
  byId('page-title').textContent = labels[view].title;
  byId('page-kicker').textContent = labels[view].kicker;
  byId('page-description').textContent = labels[view].description;
  byId('create-button').innerHTML = `<span aria-hidden="true">＋</span> ${labels[view].add}`;
  byId('search-input').value = '';
  state.query = '';
  refresh();
}

async function refresh() {
  try {
    const [books, readers, loans] = await Promise.all([
      api('/api/books'), api('/api/readers'), api('/api/loans')
    ]);
    Object.assign(state, { books, readers, loans });
    render();
  } catch (error) {
    notify(error.message);
  }
}

function renderSummary() {
  const activeLoans = state.loans.filter((loan) => loan.status === 'borrowed').length;
  const cards = state.view === 'books'
    ? [['ĐẦU SÁCH', state.books.length], ['TỔNG BẢN', state.books.reduce((sum, book) => sum + book.total_copies, 0)], ['ĐANG LƯU HÀNH', activeLoans]]
    : state.view === 'readers'
      ? [['ĐỘC GIẢ', state.readers.length], ['LƯỢT ĐANG MƯỢN', activeLoans], ['ĐÃ HOÀN TẤT', state.loans.filter((loan) => loan.status === 'returned').length]]
      : [['TỔNG LƯỢT MƯỢN', state.loans.length], ['ĐANG MƯỢN', activeLoans], ['ĐÃ TRẢ', state.loans.filter((loan) => loan.status === 'returned').length]];
  byId('summary-row').innerHTML = cards.map(([label, value]) => `<div class="summary-card"><span>${label}</span><strong>${value}</strong></div>`).join('');
}

function render() {
  renderSummary();
  const config = {
    books: {
      headings: ['TÊN SÁCH', 'TÁC GIẢ', 'THỂ LOẠI', 'CÓ SẴN', 'THAO TÁC'],
      rows: state.books.map((book) => ({ search: `${book.title} ${book.author} ${book.category} ${book.isbn || ''}`, cells: [
        `<strong>${esc(book.title)}</strong><span class="cell-sub">${esc(book.isbn || 'Chưa có ISBN')}</span>`, esc(book.author), esc(book.category), `${book.available_copies} / ${book.total_copies}`, actions('books', book.id)
      ] }))
    },
    readers: {
      headings: ['ĐỘC GIẢ', 'EMAIL', 'ĐIỆN THOẠI', 'ĐANG MƯỢN', 'THAO TÁC'],
      rows: state.readers.map((reader) => ({ search: `${reader.full_name} ${reader.email} ${reader.phone}`, cells: [esc(reader.full_name), esc(reader.email), esc(reader.phone), state.loans.filter((loan) => loan.reader_id === reader.id && loan.status === 'borrowed').length, actions('readers', reader.id)] }))
    },
    loans: {
      headings: ['ĐẦU SÁCH', 'ĐỘC GIẢ', 'NGÀY MƯỢN', 'HẠN TRẢ', 'TRẠNG THÁI', 'THAO TÁC'],
      rows: state.loans.map((loan) => ({ search: `${loan.book_title} ${loan.reader_name} ${loan.status}`, cells: [esc(loan.book_title), esc(loan.reader_name), formatDate(loan.borrowed_at), formatDate(loan.due_at), `<span class="pill ${loan.status === 'borrowed' && new Date(loan.due_at) < new Date() ? 'is-overdue' : ''}">${loan.status === 'returned' ? 'Đã trả' : new Date(loan.due_at) < new Date() ? 'Quá hạn' : 'Đang mượn'}</span>`, loan.status === 'borrowed' ? `<button class="small-button" data-return="${loan.id}">Nhận trả</button>` : '—'] }))
    }
  }[state.view];
  const filtered = config.rows.filter((row) => row.search.toLocaleLowerCase('vi').includes(state.query.toLocaleLowerCase('vi')));
  byId('table-head').innerHTML = `<tr>${config.headings.map((heading) => `<th>${heading}</th>`).join('')}</tr>`;
  byId('table-body').innerHTML = filtered.map((row) => `<tr>${row.cells.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('');
  byId('empty-state').hidden = filtered.length > 0;
  byId('result-count').textContent = `${filtered.length} kết quả`;
}

function actions(type, id) {
  return `<div class="row-actions"><button class="small-button" data-edit="${type}:${id}">Sửa</button><button class="small-button is-danger" data-delete="${type}:${id}">Xóa</button></div>`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(value));
}

function field(name, label, value = '', type = 'text', required = true, full = false) {
  return `<label class="${full ? 'full' : ''}">${label}<input name="${name}" type="${type}" value="${esc(value)}" ${required ? 'required' : ''}></label>`;
}

function openDialog(record = null) {
  state.editing = record;
  const editing = Boolean(record);
  byId('dialog-title').textContent = `${editing ? 'Sửa' : 'Thêm'} ${state.view === 'books' ? 'sách' : 'độc giả'}`;
  byId('dialog-error').textContent = '';
  let fields = '';
  if (state.view === 'books') {
    fields = field('title', 'Tên sách', record?.title || '', 'text', true, true)
      + field('author', 'Tác giả', record?.author || '')
      + field('category', 'Thể loại', record?.category || 'Khác')
      + field('isbn', 'ISBN', record?.isbn || '', 'text', false)
      + field('total_copies', 'Tổng số bản', record?.total_copies || 1, 'number');
  } else if (state.view === 'readers') {
    fields = field('full_name', 'Họ và tên', record?.full_name || '', 'text', true, true)
      + field('email', 'Email', record?.email || '', 'email')
      + field('phone', 'Điện thoại', record?.phone || '', 'tel');
  } else {
    byId('dialog-title').textContent = 'Tạo lượt mượn';
    fields = `<label class="full">Độc giả<select name="reader_id" required>${state.readers.map((reader) => `<option value="${reader.id}">${esc(reader.full_name)}</option>`).join('')}</select></label><label class="full">Sách<select name="book_id" required>${state.books.filter((book) => book.available_copies > 0).map((book) => `<option value="${book.id}">${esc(book.title)} · còn ${book.available_copies} bản</option>`).join('')}</select></label>`;
  }
  byId('dialog-fields').innerHTML = fields;
  byId('record-dialog').showModal();
}

async function saveRecord(event) {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
  if (state.view === 'books') payload.total_copies = Number(payload.total_copies);
  if (state.view === 'loans') {
    payload.reader_id = Number(payload.reader_id);
    payload.book_id = Number(payload.book_id);
  }
  const resource = state.view === 'loans' ? 'loans' : state.view;
  try {
    await api(state.editing ? `/api/${resource}/${state.editing.id}` : `/api/${resource}`, {
      method: state.editing ? 'PUT' : 'POST', body: JSON.stringify(payload)
    });
    byId('record-dialog').close();
    await refresh();
    notify(state.view === 'loans' ? 'Đã ghi nhận lượt mượn.' : 'Đã lưu thông tin.');
  } catch (error) { byId('dialog-error').textContent = error.message; }
}

async function startApp() {
  try {
    await api('/api/auth/me');
    byId('login-view').hidden = true;
    byId('app-view').hidden = false;
    await refresh();
  } catch {
    byId('login-view').hidden = false;
    byId('app-view').hidden = true;
  }
}

document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
byId('create-button').addEventListener('click', () => openDialog());
byId('record-form').addEventListener('submit', saveRecord);
byId('search-input').addEventListener('input', (event) => { state.query = event.target.value; render(); });
byId('table-body').addEventListener('click', async (event) => {
  const edit = event.target.closest('[data-edit]');
  const remove = event.target.closest('[data-delete]');
  const returnButton = event.target.closest('[data-return]');
  try {
    if (edit) {
      const [resource, id] = edit.dataset.edit.split(':');
      openDialog(state[resource].find((item) => item.id === Number(id)));
    } else if (remove) {
      const [resource, id] = remove.dataset.delete.split(':');
      if (!window.confirm('Xóa hồ sơ này?')) return;
      await api(`/api/${resource}/${id}`, { method: 'DELETE' });
      await refresh();
      notify('Đã xóa hồ sơ.');
    } else if (returnButton) {
      await api(`/api/loans/${returnButton.dataset.return}/return`, { method: 'POST', body: '{}' });
      await refresh();
      notify('Đã nhận trả sách.');
    }
  } catch (error) { notify(error.message); }
});
byId('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const credentials = Object.fromEntries(new FormData(event.currentTarget).entries());
  try {
    await api('/api/auth/login', { method: 'POST', body: JSON.stringify(credentials) });
    byId('login-error').textContent = '';
    await startApp();
  } catch (error) { byId('login-error').textContent = error.message; }
});
byId('logout-button').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST', body: '{}' });
  await startApp();
});
startApp();
