-- `private` holds LOI files, receipts and proofs of delivery: only the API (service role) reads
-- them, after its own access checks. `public` holds product pictures, which pages show directly.
insert into storage.buckets (id, name, public) values ('private', 'private', false), ('public', 'public', true)
on conflict (id) do nothing;
