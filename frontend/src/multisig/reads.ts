/**
 * The four facts both own-confirmation actions read, and confirming's verdict on
 * them.
 *
 * Confirming and revoking read the same four things and judge the fourth of them
 * in opposite directions, so the reading is here and the judgements are with
 * their actions. Every read is sequential and every answer is parsed before the
 * next call is made: a wallet that serialises requests gains nothing from being
 * asked in a burst, and a parse this app cannot do is a refusal rather than a
 * guess.
 */
import {
  decodeBool,
  decodeProposal,
  decodeUint,
  evaluatePreflight,
  type Preflight,
  type PreflightReads,
} from './confirm.ts'
import {
  MALFORMED_ANSWER,
  type ActionOutcome,
  type ActionReadContext,
} from './useMultisigAction.ts'

/** The four readings, or the reason they could not be read, or null if retired. */
export type FourFacts =
  | { ok: true; reads: PreflightReads }
  | { ok: false; reason: string }
  | null

export async function readFourFacts(context: ActionReadContext): Promise<FourFacts> {
  const ownerRaw = await context.call(context.encode('isOwner', [context.account]))
  if (!context.live()) {
    return null
  }

  const countRaw = await context.call(context.encode('getTransactionCount', []))
  if (!context.live()) {
    return null
  }

  const proposalRaw = await context.call(context.encode('transactions', [context.index]))
  if (!context.live()) {
    return null
  }

  const confirmedRaw = await context.call(
    context.encode('isConfirmed', [context.index, context.account]),
  )
  if (!context.live()) {
    return null
  }

  const isOwner = decodeBool(ownerRaw)
  const transactionCount = decodeUint(countRaw)
  const proposal = decodeProposal(proposalRaw)
  const alreadyConfirmed = decodeBool(confirmedRaw)

  if (isOwner === null || transactionCount === null || proposal === null || alreadyConfirmed === null) {
    return { ok: false, reason: MALFORMED_ANSWER }
  }

  return { ok: true, reads: { isOwner, transactionCount, proposal, alreadyConfirmed } }
}

/** Confirming: the four facts, then the verdict that refuses a confirmed account. */
export async function runConfirmation(
  context: ActionReadContext,
): Promise<ActionOutcome<Preflight> | null> {
  const facts = await readFourFacts(context)

  if (facts === null) {
    return null
  }

  if (!facts.ok) {
    return facts
  }

  return evaluatePreflight(facts.reads, context.index, context.payload)
}
