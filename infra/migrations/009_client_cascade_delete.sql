-- Add ON DELETE CASCADE to all foreign keys referencing clients(id)
-- so that deleting a client removes all its data automatically.
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT tc.constraint_name, tc.table_name, kcu.column_name
        FROM information_schema.table_constraints AS tc
        JOIN information_schema.key_column_usage AS kcu
            ON tc.constraint_name = kcu.constraint_name
            AND tc.table_schema = kcu.table_schema
        JOIN information_schema.referential_constraints AS rc
            ON tc.constraint_name = rc.constraint_name
            AND tc.table_schema = rc.constraint_schema
        JOIN information_schema.key_column_usage AS ccu
            ON ccu.constraint_name = rc.unique_constraint_name
            AND ccu.table_schema = rc.unique_constraint_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
            AND ccu.table_name = 'clients'
            AND ccu.table_schema = 'public'
    LOOP
        EXECUTE format(
            'ALTER TABLE %I DROP CONSTRAINT %I',
            r.table_name, r.constraint_name
        );
        EXECUTE format(
            'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES clients(id) ON DELETE CASCADE',
            r.table_name, r.constraint_name, r.column_name
        );
    END LOOP;
END $$;
