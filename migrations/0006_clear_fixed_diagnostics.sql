UPDATE dev_reports SET diagnostics = ''
WHERE status = 'fixed' AND diagnostics != '';
