Schema lives in server/src/db.ts (portable SQL). Postgres port: TEXT dates -> timestamptz, 0/1 flags -> boolean,
AUTOINCREMENT -> GENERATED ALWAYS AS IDENTITY, JSON text columns -> jsonb.
