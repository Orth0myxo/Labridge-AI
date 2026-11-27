alter table public.patient_records
  add column if not exists patient_id text;

alter table public.patient_records
  add column if not exists signature_version integer not null default 1;

update public.patient_records
set patient_id = 'LEGACY-' || upper(id::text)
where patient_id is null and id is not null;

create index if not exists patient_records_patient_id_created_at_idx
  on public.patient_records (patient_id, created_at desc);
