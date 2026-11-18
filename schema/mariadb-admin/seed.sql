-- The rows of the shared list `everchat_kind`: the ids and names of `KINDS`
-- (packages/core/src/store.ts), as SQLite's schema inserts them. An
-- administrator runs this after the tables, in the schema that the client
-- names. It can run again: it adds each row whose id and name are both
-- missing, and changes no row that is there, with no error. Not `insert
-- ignore` (it cuts a text with no error), not `replace`, not an upsert.
insert into everchat_kind (id, name)
select seed.id, seed.name
from (
  select 1 as id, 'user' as name
  union all select 2, 'asst'
  union all select 3, 'tool'
  union all select 4, 'echo'
  union all select 5, 'work'
  union all select 6, 'note'
  union all select 7, 'late'
  union all select 8, 'wake'
) as seed
where not exists (select 1 from everchat_kind as kind where kind.id = seed.id or kind.name = seed.name);
