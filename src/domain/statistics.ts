const CHI_SQUARE_95_ONE_DF = 3.841458820694124

export const TRINOMIAL_PROFILE_LIKELIHOOD_95_METHOD = 'trinomial-profile-likelihood-95-v1' as const
export const MAX_APPROVED_EVIDENCE_GAMES = 268_479_804 as const

function validatedSampleSize(wins: number, draws: number, losses: number): number {
  for (const [label, value] of [['wins', wins], ['draws', draws], ['losses', losses]] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative safe integer`)
  }
  const n = wins + draws + losses
  if (!Number.isSafeInteger(n)) throw new Error('Trinomial sample size exceeds the safe integer range')
  if (n > MAX_APPROVED_EVIDENCE_GAMES) {
    throw new Error(`Trinomial sample size exceeds the approved ${MAX_APPROVED_EVIDENCE_GAMES}-game evidence bound`)
  }
  return n
}

function multinomialLogLikelihood(
  wins: number,
  draws: number,
  losses: number,
  winProbability: number,
  drawProbability: number,
  lossProbability: number,
): number {
  const term = (count: number, probability: number): number => {
    if (count === 0) return 0
    return probability > 0 ? count * Math.log(probability) : Number.NEGATIVE_INFINITY
  }
  return term(wins, winProbability) + term(draws, drawProbability) + term(losses, lossProbability)
}

/**
 * Maximize the trinomial log-likelihood at a fixed score
 * `p(win) + 0.5 * p(draw)`. The nuisance draw probability has a compact
 * feasible interval and a concave likelihood. Evaluating the feasible roots
 * of the cleared quadratic derivative plus both boundaries avoids a general
 * iterative optimizer.
 */
function profiledScoreLogLikelihood(
  wins: number,
  draws: number,
  losses: number,
  score: number,
): number {
  const upperDrawProbability = 2 * Math.min(score, 1 - score)
  const at = (drawProbability: number): number => multinomialLogLikelihood(
    wins,
    draws,
    losses,
    score - drawProbability / 2,
    drawProbability,
    1 - score - drawProbability / 2,
  )
  if (upperDrawProbability <= 0) return at(0)
  const n = wins + draws + losses
  const linear = wins * (1 - score) + draws + losses * score
  const discriminant = Math.max(0, linear * linear - 4 * n * draws * score * (1 - score))
  const rootDistance = Math.sqrt(discriminant)
  const candidates = [
    0,
    upperDrawProbability,
    (linear - rootDistance) / n,
    (linear + rootDistance) / n,
  ].filter((value) => value >= 0 && value <= upperDrawProbability)
  return Math.max(...candidates.map(at))
}

/**
 * Deterministic 95% likelihood-ratio interval for descriptive chess score,
 * where a win is one point and a draw is one half-point. It is deliberately
 * not described as a causal performance interval.
 */
export function trinomialScoreProfileLikelihoodInterval(
  wins: number,
  draws: number,
  losses: number,
): { low: number; high: number } | null {
  const n = validatedSampleSize(wins, draws, losses)
  if (n === 0) return null

  const estimate = (wins + draws * 0.5) / n
  const maximum = multinomialLogLikelihood(wins, draws, losses, wins / n, draws / n, losses / n)
  const likelihoodRatio = (score: number): number => {
    const profiled = profiledScoreLogLikelihood(wins, draws, losses, score)
    return Number.isFinite(profiled) ? Math.max(0, 2 * (maximum - profiled)) : Number.POSITIVE_INFINITY
  }
  const lower = (() => {
    if (estimate === 0 || likelihoodRatio(0) <= CHI_SQUARE_95_ONE_DF) return 0
    let outside = 0
    let inside = estimate
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const midpoint = (outside + inside) / 2
      if (likelihoodRatio(midpoint) > CHI_SQUARE_95_ONE_DF) outside = midpoint
      else inside = midpoint
    }
    return inside
  })()
  const high = (() => {
    if (estimate === 1 || likelihoodRatio(1) <= CHI_SQUARE_95_ONE_DF) return 1
    let inside = estimate
    let outside = 1
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const midpoint = (inside + outside) / 2
      if (likelihoodRatio(midpoint) > CHI_SQUARE_95_ONE_DF) outside = midpoint
      else inside = midpoint
    }
    return inside
  })()
  return {
    low: Math.max(0, Math.min(estimate, lower)),
    high: Math.min(1, Math.max(estimate, high)),
  }
}

/**
 * Validate stored interval endpoints directly against the deterministic
 * likelihood-ratio equation. This is mathematically equivalent to rerunning
 * bisection, while keeping browser shard validation bounded to two profile
 * evaluations per non-empty band.
 */
export function assertTrinomialScoreProfileLikelihoodInterval(
  wins: number,
  draws: number,
  losses: number,
  interval: { low: number; high: number },
): void {
  const n = validatedSampleSize(wins, draws, losses)
  if (n === 0) throw new Error('A zero-game outcome has no score interval')
  if (!Number.isFinite(interval.low) || !Number.isFinite(interval.high)
    || interval.low < 0 || interval.high > 1 || interval.low > interval.high) {
    throw new Error('Score interval endpoints must be finite and ordered within [0, 1]')
  }
  const estimate = (wins + draws * 0.5) / n
  if (interval.low > estimate || interval.high < estimate) {
    throw new Error('Score interval must contain the maximum-likelihood score')
  }
  const maximum = multinomialLogLikelihood(wins, draws, losses, wins / n, draws / n, losses / n)
  const ratio = (score: number): number => {
    const profiled = profiledScoreLogLikelihood(wins, draws, losses, score)
    return Number.isFinite(profiled) ? Math.max(0, 2 * (maximum - profiled)) : Number.POSITIVE_INFINITY
  }
  const endpointIsValid = (score: number, boundary: 0 | 1): boolean => {
    const value = ratio(score)
    if (score === boundary) return value <= CHI_SQUARE_95_ONE_DF + 1e-10
    // At the approved upper corpus bound the two log-likelihoods are roughly
    // 1e8 in magnitude, so their subtraction loses several decimal places in
    // IEEE-754. A 1e-5 likelihood-ratio tolerance remains far tighter than a
    // displayable score increment and avoids rejecting the generator's root.
    return Math.abs(value - CHI_SQUARE_95_ONE_DF) <= 1e-5
  }
  if (!endpointIsValid(interval.low, 0) || !endpointIsValid(interval.high, 1)) {
    throw new Error('Score interval endpoints do not solve the tagged 95% trinomial profile-likelihood equation')
  }
}
