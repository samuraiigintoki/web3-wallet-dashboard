/**
 * The four facts the auth surface states, in the product's own words.
 *
 * They are the same four the direction document and the experience brief
 * record, verified against the API and the indexer rather than written to
 * reassure:
 *
 *   1. The server never holds a key and never signs. Signing happens in the
 *      person's wallet.
 *   2. The indexer polls every fifteen seconds and stops short of the chain
 *      head, so the indexed history it serves can lag the chain.
 *   3. The reversibility window is a heuristic with a block count, not
 *      finality, and the copy never calls it final.
 *   4. Execution needs the threshold the contract is configured with, which is
 *      not the same as every owner approving.
 *
 * This list is the static composition and the fallback: it is what renders
 * when the bounded scroll sequence does not run, so it has to stand on its
 * own, in order, with nothing hidden behind a disclosure.
 */
export const AUTH_FACTS = [
  'Keys stay in your wallet. The server never signs.',
  'Indexing polls every 15 seconds and stays behind its safety head, so indexed history can lag the chain.',
  'Twelve blocks is a reversibility heuristic, not finality.',
  'Execution needs the configured approval threshold, not every owner.',
] as const
