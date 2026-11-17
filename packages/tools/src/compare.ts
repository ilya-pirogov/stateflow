/** A place where two JSON values differ: the keys from the root to it, and each side, absent where it is missing. */
type Difference = { path: string[]; left?: unknown; right?: unknown };

/**
 * Each place where `left` and `right`, two values JSON.parse gave, differ, in the order of `left`'s keys and then of
 * the keys only `right` has: two objects, or two arrays, are compared key by key (an array's keys are its indices), and
 * any other two values are one place, which differs when their JSON texts do. Empty when they are equal.
 */
export function compareJson(left: unknown, right: unknown, path: string[] = []): Difference[] {
  if (
    typeof left !== "object" ||
    typeof right !== "object" ||
    left === null ||
    right === null ||
    Array.isArray(left) !== Array.isArray(right)
  ) {
    return JSON.stringify(left) === JSON.stringify(right) ? [] : [{ path, left, right }];
  }
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].flatMap((key) =>
    compareJson((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], [...path, key]),
  );
}
