-- Publish only synced application tables; storage may share this database.
CREATE PUBLICATION powersync FOR TABLE public.devices, public.items;
