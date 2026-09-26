-- Parking Ops — database part 39: remove the result tables the old isolation
-- checks (parts 9 and 11) leave behind. They hold only pass/fail lines; the
-- checks make them again if they are ever re-run. Safe to run twice.

drop table if exists public.zz_fn_results;
drop table if exists public.zz_isolation_results;
