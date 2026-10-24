BEGIN;

INSERT INTO books (title, author, isbn, category, total_copies, available_copies)
VALUES
  ('Dế Mèn Phiêu Lưu Ký', 'Tô Hoài', '9786042250001', 'Văn học', 5, 5),
  ('Cho Tôi Xin Một Vé Đi Tuổi Thơ', 'Nguyễn Nhật Ánh', '9786042250002', 'Văn học', 4, 4),
  ('Clean Code', 'Robert C. Martin', '9780132350884', 'Công nghệ', 3, 3),
  ('Atomic Habits', 'James Clear', '9780735211292', 'Kỹ năng', 2, 2),
  ('Nhà Giả Kim', 'Paulo Coelho', '9786045320005', 'Tiểu thuyết', 3, 3)
ON CONFLICT (isbn) DO NOTHING;

INSERT INTO readers (full_name, email, phone)
VALUES
  ('Nguyễn Minh Anh', 'minh.anh.demo@example.com', '0901000001'),
  ('Trần Quốc Bảo', 'quoc.bao.demo@example.com', '0901000002'),
  ('Lê Thu Hà', 'thu.ha.demo@example.com', '0901000003')
ON CONFLICT (email) DO NOTHING;

WITH demo_loans (reader_email, isbn, status, borrowed_at, due_at, returned_at) AS (
  VALUES
    ('minh.anh.demo@example.com', '9786042250001', 'borrowed',
      NOW() - INTERVAL '7 days', NOW() + INTERVAL '7 days', NULL::timestamptz),
    ('quoc.bao.demo@example.com', '9780132350884', 'borrowed',
      NOW() - INTERVAL '21 days', NOW() - INTERVAL '7 days', NULL::timestamptz),
    ('thu.ha.demo@example.com', '9780735211292', 'returned',
      NOW() - INTERVAL '30 days', NOW() - INTERVAL '16 days', NOW() - INTERVAL '15 days')
),
inserted_loans AS (
  INSERT INTO loans (book_id, reader_id, status, borrowed_at, due_at, returned_at)
  SELECT b.id, r.id, d.status, d.borrowed_at, d.due_at, d.returned_at
  FROM demo_loans AS d
  JOIN books AS b ON b.isbn = d.isbn
  JOIN readers AS r ON r.email = d.reader_email
  WHERE (d.status = 'returned' OR b.available_copies > 0)
    AND NOT EXISTS (
      SELECT 1
      FROM loans AS existing
      WHERE existing.book_id = b.id
        AND existing.reader_id = r.id
    )
  RETURNING book_id, status
),
borrowed_counts AS (
  SELECT book_id, COUNT(*) AS quantity
  FROM inserted_loans
  WHERE status = 'borrowed'
  GROUP BY book_id
)
UPDATE books AS b
SET available_copies = b.available_copies - borrowed_counts.quantity
FROM borrowed_counts
WHERE b.id = borrowed_counts.book_id;

COMMIT;

-- Danh sách sách và số bản còn có thể cho mượn.
SELECT id, title, author, category, total_copies, available_copies
FROM books
ORDER BY title;

-- Tìm sách theo thể loại.
SELECT id, title, author, total_copies, available_copies
FROM books
WHERE category = 'Văn học'
ORDER BY title;

-- Danh sách độc giả.
SELECT id, full_name, email, phone
FROM readers
ORDER BY full_name;

-- Tài khoản độc giả mẫu trong ứng dụng là hồ sơ độc giả, không có mật khẩu đăng nhập.
SELECT id, full_name, email, phone
FROM readers
WHERE email LIKE '%.demo@example.com'
ORDER BY full_name;

-- Lượt mượn, độc giả và sách; đánh dấu các lượt đang quá hạn.
SELECT
  l.id AS loan_id,
  r.full_name AS reader,
  b.title AS book,
  l.borrowed_at,
  l.due_at,
  l.status,
  (l.status = 'borrowed' AND l.due_at < NOW()) AS is_overdue
FROM loans AS l
JOIN readers AS r ON r.id = l.reader_id
JOIN books AS b ON b.id = l.book_id
ORDER BY l.borrowed_at DESC;

-- Thống kê số sách theo thể loại.
SELECT category, COUNT(*) AS book_titles, SUM(total_copies) AS total_copies
FROM books
GROUP BY category
ORDER BY category;
