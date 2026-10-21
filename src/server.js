const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const connectPgSimple = require('connect-pg-simple');
const express = require('express');
const { rateLimit } = require('express-rate-limit');
const session = require('express-session');
const helmet = require('helmet');
const { Pool } = require('pg');
const client = require('prom-client');

const app = express();
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 10,
  idleTimeoutMillis: 30000
});
const logFile = process.env.LOG_FILE || '/var/log/library/app.log';
const PgStore = connectPgSimple(session);
const register = new client.Registry();
client.collectDefaultMetrics({ register });
const requestCount = new client.Counter({
  name: 'library_http_requests_total',
  help: 'Total HTTP requests handled by the library application.',
  labelNames: ['method', 'route', 'status'],
  registers: [register]
});
const requestDuration = new client.Histogram({
  name: 'library_http_request_duration_seconds',
  help: 'HTTP request duration in seconds.',
  labelNames: ['method', 'route', 'status'],
  registers: [register]
});

function log(level, event, details = {}) {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...details });
  process.stdout.write(`${line}\n`);
  fs.appendFile(logFile, `${line}\n`, () => {});
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function requireFields(values) {
  return values.every((value) => typeof value === 'string' && value.trim().length > 0);
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS administrators (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS books (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      author TEXT NOT NULL,
      isbn TEXT UNIQUE,
      category TEXT NOT NULL DEFAULT 'Khác',
      total_copies INTEGER NOT NULL CHECK (total_copies > 0),
      available_copies INTEGER NOT NULL CHECK (available_copies >= 0 AND available_copies <= total_copies),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS readers (
      id SERIAL PRIMARY KEY,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      phone TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS loans (
      id SERIAL PRIMARY KEY,
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE RESTRICT,
      reader_id INTEGER NOT NULL REFERENCES readers(id) ON DELETE RESTRICT,
      borrowed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      due_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '14 days'),
      returned_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'borrowed' CHECK (status IN ('borrowed', 'returned'))
    );
    CREATE INDEX IF NOT EXISTS loans_status_due_idx ON loans(status, due_at);
  `);

  const email = process.env.LIBRARY_ADMIN_EMAIL;
  const password = process.env.LIBRARY_ADMIN_PASSWORD;
  if (!email || !password || password.length < 16) {
    throw new Error('Set LIBRARY_ADMIN_EMAIL and a LIBRARY_ADMIN_PASSWORD of at least 16 characters.');
  }
  const passwordHash = await bcrypt.hash(password, 12);
  await pool.query(
    'INSERT INTO administrators (email, password_hash) VALUES ($1, $2) ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash',
    [email, passwordHash]
  );
}

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  frameguard: false,
  hsts: false,
  referrerPolicy: false,
  xContentTypeOptions: false
}));
app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : req.path;
    const labels = { method: req.method, route, status: String(res.statusCode) };
    requestCount.inc(labels);
    requestDuration.observe(labels, Number(process.hrtime.bigint() - started) / 1e9);
    log(res.statusCode >= 500 ? 'error' : 'info', 'http_request', {
      method: req.method, path: req.path, status: res.statusCode
    });
  });
  next();
});

app.use(session({
  store: new PgStore({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: 8 * 60 * 60 * 1000
  }
}));

app.get('/health', asyncRoute(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok' });
}));
app.get('/metrics', asyncRoute(async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false
});

app.use('/api', (req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('x-requested-with') !== 'XMLHttpRequest') {
    return res.status(403).json({ error: 'Yêu cầu không hợp lệ.' });
  }
  next();
});

app.post('/api/auth/login', loginLimiter, asyncRoute(async (req, res) => {
  const { email, password } = req.body || {};
  if (!requireFields([email, password])) return res.status(400).json({ error: 'Vui lòng nhập email và mật khẩu.' });
  const { rows } = await pool.query('SELECT id, email, password_hash FROM administrators WHERE email = $1', [email]);
  const administrator = rows[0];
  if (!administrator || !(await bcrypt.compare(password, administrator.password_hash))) {
    return res.status(401).json({ error: 'Thông tin đăng nhập không chính xác.' });
  }
  await new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
  req.session.administratorId = administrator.id;
  res.json({ id: administrator.id, email: administrator.email });
}));

app.post('/api/auth/logout', asyncRoute(async (req, res) => {
  req.session.destroy((error) => {
    if (error) return res.status(500).json({ error: 'Không thể kết thúc phiên đăng nhập.' });
    res.clearCookie('connect.sid', { httpOnly: true, sameSite: 'strict' });
    res.status(204).end();
  });
}));

app.get('/api/auth/me', (req, res) => {
  if (!req.session.administratorId) return res.status(401).json({ error: 'Chưa đăng nhập.' });
  res.json({ id: req.session.administratorId });
});

app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/')) return next();
  if (!req.session.administratorId) return res.status(401).json({ error: 'Phiên đăng nhập đã hết hạn.' });
  next();
});

app.get('/api/books', asyncRoute(async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM books ORDER BY title, id');
  res.json(rows);
}));
app.post('/api/books', asyncRoute(async (req, res) => {
  const { title, author, isbn, category = 'Khác', total_copies: totalCopies } = req.body || {};
  if (!requireFields([title, author, category]) || !Number.isInteger(totalCopies) || totalCopies < 1) {
    return res.status(400).json({ error: 'Thông tin sách không hợp lệ.' });
  }
  const { rows } = await pool.query(
    'INSERT INTO books (title, author, isbn, category, total_copies, available_copies) VALUES ($1, $2, $3, $4, $5, $5) RETURNING *',
    [title.trim(), author.trim(), isbn?.trim() || null, category.trim(), totalCopies]
  );
  res.status(201).json(rows[0]);
}));
app.put('/api/books/:id', asyncRoute(async (req, res) => {
  const { title, author, isbn, category, total_copies: totalCopies } = req.body || {};
  if (!requireFields([title, author, category]) || !Number.isInteger(totalCopies) || totalCopies < 1) {
    return res.status(400).json({ error: 'Thông tin sách không hợp lệ.' });
  }
  const { rows } = await pool.query(
    `UPDATE books SET title = $1, author = $2, isbn = $3, category = $4, total_copies = $5,
       available_copies = available_copies + $5 - total_copies
     WHERE id = $6 AND available_copies + $5 - total_copies >= 0 RETURNING *`,
    [title.trim(), author.trim(), isbn?.trim() || null, category.trim(), totalCopies, req.params.id]
  );
  if (!rows[0]) return res.status(400).json({ error: 'Không tìm thấy sách hoặc số bản mới thấp hơn số đang cho mượn.' });
  res.json(rows[0]);
}));
app.delete('/api/books/:id', asyncRoute(async (req, res) => {
  const result = await pool.query('DELETE FROM books WHERE id = $1', [req.params.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Không tìm thấy sách.' });
  res.status(204).end();
}));

app.get('/api/readers', asyncRoute(async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM readers ORDER BY full_name, id');
  res.json(rows);
}));
app.post('/api/readers', asyncRoute(async (req, res) => {
  const { full_name: fullName, email, phone } = req.body || {};
  if (!requireFields([fullName, email, phone]) || !email.includes('@')) {
    return res.status(400).json({ error: 'Thông tin độc giả không hợp lệ.' });
  }
  const { rows } = await pool.query(
    'INSERT INTO readers (full_name, email, phone) VALUES ($1, $2, $3) RETURNING *',
    [fullName.trim(), email.trim().toLowerCase(), phone.trim()]
  );
  res.status(201).json(rows[0]);
}));
app.put('/api/readers/:id', asyncRoute(async (req, res) => {
  const { full_name: fullName, email, phone } = req.body || {};
  if (!requireFields([fullName, email, phone]) || !email.includes('@')) {
    return res.status(400).json({ error: 'Thông tin độc giả không hợp lệ.' });
  }
  const { rows } = await pool.query(
    'UPDATE readers SET full_name = $1, email = $2, phone = $3 WHERE id = $4 RETURNING *',
    [fullName.trim(), email.trim().toLowerCase(), phone.trim(), req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Không tìm thấy độc giả.' });
  res.json(rows[0]);
}));
app.delete('/api/readers/:id', asyncRoute(async (req, res) => {
  const result = await pool.query('DELETE FROM readers WHERE id = $1', [req.params.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Không tìm thấy độc giả.' });
  res.status(204).end();
}));

app.get('/api/loans', asyncRoute(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT l.id, l.book_id, l.reader_id, l.borrowed_at, l.due_at, l.returned_at, l.status,
      b.title AS book_title, r.full_name AS reader_name
    FROM loans l JOIN books b ON b.id = l.book_id JOIN readers r ON r.id = l.reader_id
    ORDER BY l.borrowed_at DESC, l.id DESC
  `);
  res.json(rows);
}));
app.post('/api/loans', asyncRoute(async (req, res) => {
  const bookId = Number(req.body?.book_id);
  const readerId = Number(req.body?.reader_id);
  if (!Number.isInteger(bookId) || !Number.isInteger(readerId)) {
    return res.status(400).json({ error: 'Vui lòng chọn sách và độc giả.' });
  }
  const connection = await pool.connect();
  try {
    await connection.query('BEGIN');
    const book = await connection.query('SELECT available_copies FROM books WHERE id = $1 FOR UPDATE', [bookId]);
    if (!book.rowCount || book.rows[0].available_copies < 1) {
      await connection.query('ROLLBACK');
      return res.status(409).json({ error: 'Sách không còn bản có thể cho mượn.' });
    }
    await connection.query('UPDATE books SET available_copies = available_copies - 1 WHERE id = $1', [bookId]);
    const { rows } = await connection.query(
      'INSERT INTO loans (book_id, reader_id) VALUES ($1, $2) RETURNING *', [bookId, readerId]
    );
    await connection.query('COMMIT');
    res.status(201).json(rows[0]);
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
}));
app.post('/api/loans/:id/return', asyncRoute(async (req, res) => {
  const connection = await pool.connect();
  try {
    await connection.query('BEGIN');
    const loan = await connection.query('SELECT book_id, status FROM loans WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!loan.rowCount || loan.rows[0].status !== 'borrowed') {
      await connection.query('ROLLBACK');
      return res.status(404).json({ error: 'Không tìm thấy lượt mượn đang hoạt động.' });
    }
    await connection.query("UPDATE loans SET status = 'returned', returned_at = NOW() WHERE id = $1", [req.params.id]);
    await connection.query('UPDATE books SET available_copies = available_copies + 1 WHERE id = $1', [loan.rows[0].book_id]);
    await connection.query('COMMIT');
    res.status(204).end();
  } catch (error) {
    await connection.query('ROLLBACK');
    throw error;
  } finally {
    connection.release();
  }
}));

app.use(express.static(path.join(__dirname, '..', 'public'), { etag: true, maxAge: '1h' }));
app.use((error, _req, res, _next) => {
  log('error', 'request_failed', { message: error.message });
  if (error.code === '23505') return res.status(409).json({ error: 'Dữ liệu bị trùng (ISBN hoặc email).' });
  if (error.code === '23503') return res.status(409).json({ error: 'Không thể xóa bản ghi đang có lịch sử mượn.' });
  res.status(500).json({ error: 'Đã xảy ra lỗi máy chủ.' });
});

const port = Number(process.env.PORT || 3000);
initializeDatabase().then(() => {
  app.listen(port, '0.0.0.0', () => log('info', 'server_started', { port }));
}).catch((error) => {
  log('fatal', 'startup_failed', { message: error.message });
  process.exit(1);
});
