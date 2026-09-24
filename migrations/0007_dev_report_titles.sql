ALTER TABLE dev_reports ADD COLUMN title TEXT;

UPDATE dev_reports
SET title = CASE
  WHEN length(trim(description)) <= 120 THEN trim(description)
  ELSE substr(trim(description), 1, 119) || '…'
END
WHERE title IS NULL OR trim(title) = '';
