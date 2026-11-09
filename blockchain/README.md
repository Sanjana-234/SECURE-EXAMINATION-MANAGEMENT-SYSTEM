# Blockchain (EVM) integration: sources provided, NOT yet compiled or run

These files could not be compiled in the build sandbox (no npm/network). Treat them as reviewed-but-unverified:
run `npm install && npx hardhat test` first.

The server talks to the chain only through the `Ledger` interface in `server/src/ledger.ts`:

    anchor(payloadHash: string): Promise<{ txRef, blockIndex }>
    lookup(txRef: string): Promise<{ payloadHash, chainValid } | null>

To go on-chain, add `server/src/evm-ledger.ts` implementing it with ethers v6 and pass it to `createSems({ ledger })`:
- `anchor`: `tx = await contract.anchor('0x' + hash)`; wait for the receipt; `blockIndex` = `index` from the `HashAnchored` event; `txRef = tx.hash`.
- `lookup(txRef)`: fetch the receipt, decode `HashAnchored`, return `payloadHash` (strip `0x`) and `chainValid: true`
  (the chain itself guarantees ordering/immutability).
Run a local chain with `npx hardhat node`, deploy with `npm run deploy`, and give the server the RPC URL, contract address and
the owner's private key via env vars (never commit the key). No application logic changes are needed: the existing integrity tests describe the behaviour the adapter must keep.
