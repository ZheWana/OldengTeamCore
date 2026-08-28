declare module "diff3" {
  interface Diff3Conflict<T> {
    a: T[];
    o: T[];
    b: T[];
  }

  type Diff3Result<T> = { ok: T[] } | { conflict: Diff3Conflict<T> };

  export default function diff3Merge<T>(ours: T[], base: T[], theirs: T[]): Diff3Result<T>[];
}
