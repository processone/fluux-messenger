/**
 * Race a promise against a deadline, clearing the deadline's timer once the
 * race settles.
 *
 * A bare `Promise.race` with `setTimeout` leaves the timer pending after the
 * work finishes first: one stray timer per call, which keeps a Node host's
 * event loop alive until it fires.
 *
 * @param onDeadline - Produces the result when the deadline wins; throw from it
 *   to reject instead.
 */
export function raceDeadline<T, F>(
  promise: Promise<T>,
  ms: number,
  onDeadline: () => F,
): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<F>((resolve, reject) => {
    timer = setTimeout(() => {
      try {
        resolve(onDeadline())
      } catch (error) {
        reject(error)
      }
    }, ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}
