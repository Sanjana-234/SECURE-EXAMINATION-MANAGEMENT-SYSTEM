import { existsSync } from 'node:fs';
import { openDb, backupDb } from './db.ts';

const dest = process.argv[2] ?? `./sems-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
if (existsSync(dest)) { console.error(`Refusing to overwrite existing file: ${dest}`); process.exit(1); }   // never clobber a previous backup
try {
  backupDb(openDb(process.env.SEMS_DB ?? './sems.db'), dest);        // consistent online snapshot (VACUUM INTO); safe while the server runs
  console.log('Backup written to ' + dest + ' (copy the uploads/ directory too).');
} catch (e: any) { console.error('Backup failed: ' + e.message); process.exit(1); }
