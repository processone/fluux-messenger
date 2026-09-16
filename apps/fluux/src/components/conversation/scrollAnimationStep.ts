export function createScrollAnimation(): (current: number, target: number) => number {
  let framesLeft = 18
  return (current, target) => {
    if (framesLeft <= 1 || Math.abs(target - current) <= 1) return target
    const fraction = 1 - ((framesLeft - 1) / framesLeft) ** 3
    framesLeft -= 1
    return current + (target - current) * fraction
  }
}
