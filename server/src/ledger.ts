import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { withTx } from './db.ts';

// Abstraction so a Hardhat/EVM implementation can replace LocalLedger without touching business logic.
export interface Ledger {
  anchor(payloadHash: string): Promise<{ txRef: string; blockIndex: number }>;
  lookup(txRef: string): Promise<{ payloadHash: string; chainValid: boolean } | null>;
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// Local hash-chained append-only ledger (development stand-in for a smart contract).
export class LocalLedger implements Ledger {
  db: DatabaseSync; now: () => Date;
  constructor(db: DatabaseSync, now: () => Date) { this.db = db; this.now = now; }
  async anchor(payloadHash: string) {
    return withTx(this.db, () => {                                   // read-last + insert must be atomic across instances
      const last: any = this.db.prepare('SELECT * FROM ledger ORDER BY idx DESC LIMIT 1').get();
      const idx = last ? last.idx + 1 : 0, prev = last ? last.block_hash : '0'.repeat(64);
      const ts = this.now().toISOString();
      const blockHash = sha256(`${idx}|${prev}|${payloadHash}|${ts}`);
      this.db.prepare('INSERT INTO ledger VALUES (?,?,?,?,?)').run(idx, prev, payloadHash, blockHash, ts);
      return { txRef: `0x${blockHash}`, blockIndex: idx };
    });
  }
  chainValid(): boolean {
    let prev = '0'.repeat(64);
    for (const b of this.db.prepare('SELECT * FROM ledger ORDER BY idx').all() as any[]) {
      if (b.prev_hash !== prev || sha256(`${b.idx}|${b.prev_hash}|${b.payload_hash}|${b.ts}`) !== b.block_hash) return false;
      prev = b.block_hash;
    }
    return true;
  }
  async lookup(txRef: string) {
    const b: any = this.db.prepare('SELECT * FROM ledger WHERE block_hash = ?').get(txRef.replace(/^0x/, ''));
    return b ? { payloadHash: b.payload_hash, chainValid: this.chainValid() } : null;
  }
}

// Deterministic JSON (sorted keys) so identical data always yields the identical SHA-256.
export function canonical(v: any): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',')}}`;
  return JSON.stringify(v ?? null);
}
