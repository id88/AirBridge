import type { ParsedFrame } from "./protocol";

export interface EquationRow {
  vars: Set<number>;
  data: Uint8Array;
}

export interface SerializedSession {
  sid: string;
  size: number;
  bs: number;
  total: number;
  solved: Array<[number, Uint8Array]>;
  basis: Array<[number[], Uint8Array]>;
  updatedAt: number;
}

export interface IngestResult {
  status: "solved" | "equation" | "duplicate" | "complete";
  newlySolved: number[];
  rank: number;
  solvedCount: number;
  total: number;
}

function xorInto(target: Uint8Array, source: Uint8Array): void {
  for (let i = 0; i < target.length; i++) {
    target[i] = target[i]! ^ source[i]!;
  }
}

function minOfSet(set: Set<number>): number {
  let min = Infinity;
  for (const v of set) {
    if (v < min) min = v;
  }
  return min;
}

/**
 * Online Peeling + GF(2) Upper-Triangular Basis Solver.
 *
 * Invariants:
 * 1. Every row in `basis` only references unsolved block indices.
 * 2. Every row in `basis` is keyed by its minimum variable index (`pivot`).
 * 3. `rank = solvedCount + basis.size` equals the number of linearly independent equations collected.
 * 4. Whenever `rank === total`, descending back-substitution uniquely solves all remaining blocks in one pass.
 */
export class AirBridgeSolver {
  readonly sid: string;
  readonly size: number;
  readonly bs: number;
  readonly total: number;

  private readonly solved: Array<Uint8Array | null>;
  private readonly basis = new Map<number, EquationRow>();
  private _solvedCount = 0;

  constructor(sid: string, size: number, bs: number) {
    this.sid = sid;
    this.size = size;
    this.bs = bs;
    this.total = Math.ceil(size / bs);
    this.solved = new Array<Uint8Array | null>(this.total).fill(null);
  }

  get solvedCount(): number {
    return this._solvedCount;
  }

  get equationCount(): number {
    return this.basis.size;
  }

  get rank(): number {
    return this._solvedCount + this.basis.size;
  }

  get isComplete(): boolean {
    return this._solvedCount === this.total;
  }

  hasBlock(index: number): boolean {
    return this.solved[index] !== null;
  }

  getMissingIndices(): number[] {
    const missing: number[] = [];
    for (let i = 0; i < this.total; i++) {
      if (this.solved[i] === null) missing.push(i);
    }
    return missing;
  }

  getBlockStates(): Uint8Array {
    // 0 = missing, 1 = solved, 2 = constrained by pending GF(2) pivot
    const states = new Uint8Array(this.total);
    for (let i = 0; i < this.total; i++) {
      if (this.solved[i] !== null) {
        states[i] = 1;
      } else if (this.basis.has(i)) {
        states[i] = 2;
      }
    }
    return states;
  }

  ingest(frame: ParsedFrame): IngestResult {
    if (this.isComplete) {
      return { status: "complete", newlySolved: [], rank: this.rank, solvedCount: this._solvedCount, total: this.total };
    }
    const newlySolved: number[] = [];
    const inserted = this.addEquation(new Set(frame.ids), new Uint8Array(frame.payload), newlySolved);

    if (this.rank === this.total && !this.isComplete) {
      this.backSubstitute(newlySolved);
    }

    if (this.isComplete) {
      return { status: "complete", newlySolved, rank: this.rank, solvedCount: this._solvedCount, total: this.total };
    }
    if (newlySolved.length > 0) {
      return { status: "solved", newlySolved, rank: this.rank, solvedCount: this._solvedCount, total: this.total };
    }
    if (inserted) {
      return { status: "equation", newlySolved, rank: this.rank, solvedCount: this._solvedCount, total: this.total };
    }
    return { status: "duplicate", newlySolved, rank: this.rank, solvedCount: this._solvedCount, total: this.total };
  }

  private addEquation(vars: Set<number>, data: Uint8Array, newlySolved: number[]): boolean {
    // 1. Substitute already-solved blocks
    for (const id of [...vars]) {
      const known = this.solved[id];
      if (known) {
        xorInto(data, known);
        vars.delete(id);
      }
    }

    if (vars.size === 0) return false;

    // 2. If degree-1, immediately solve and peel
    if (vars.size === 1) {
      const [onlyId] = vars;
      this.markSolvedAndPeel(onlyId!, data, newlySolved);
      return true;
    }

    // 3. Reduce against existing upper-triangular GF(2) basis
    while (vars.size > 0) {
      const pivot = minOfSet(vars);
      const existing = this.basis.get(pivot);
      if (!existing) {
        if (vars.size === 1) {
          this.markSolvedAndPeel(pivot, data, newlySolved);
        } else {
          this.basis.set(pivot, { vars, data });
        }
        return true;
      }
      xorInto(data, existing.data);
      for (const v of existing.vars) {
        if (vars.has(v)) vars.delete(v);
        else vars.add(v);
      }
    }

    // Linearly dependent with existing basis
    return false;
  }

  private markSolvedAndPeel(startId: number, startData: Uint8Array, newlySolved: number[]): void {
    const queue: Array<[number, Uint8Array]> = [[startId, startData]];

    while (queue.length > 0) {
      const [id, blockData] = queue.shift()!;
      if (this.solved[id] !== null) continue;

      this.solved[id] = blockData;
      this._solvedCount++;
      newlySolved.push(id);

      // Collect rows in basis affected by `id`
      const reinsert: EquationRow[] = [];
      for (const [pivot, row] of [...this.basis.entries()]) {
        if (!row.vars.has(id)) continue;
        row.vars.delete(id);
        xorInto(row.data, blockData);

        if (row.vars.size === 0) {
          this.basis.delete(pivot);
        } else if (row.vars.size === 1) {
          this.basis.delete(pivot);
          const [nextId] = row.vars;
          queue.push([nextId!, row.data]);
        } else if (pivot === id) {
          // Pivot itself was eliminated; must re-insert with new minimum pivot
          this.basis.delete(pivot);
          reinsert.push(row);
        }
      }

      for (const row of reinsert) {
        this.addEquation(row.vars, row.data, newlySolved);
      }
    }
  }

  private backSubstitute(newlySolved: number[]): void {
    const pivots = [...this.basis.keys()].sort((a, b) => b - a);
    for (const pivot of pivots) {
      const row = this.basis.get(pivot);
      if (!row) continue;
      const data = row.data;
      for (const v of row.vars) {
        if (v === pivot) continue;
        const known = this.solved[v];
        if (!known) {
          throw new Error(`GF(2) back-substitution invariant broken at pivot ${pivot}, missing ${v}`);
        }
        xorInto(data, known);
      }
      if (this.solved[pivot] === null) {
        this.solved[pivot] = data;
        this._solvedCount++;
        newlySolved.push(pivot);
      }
    }
    this.basis.clear();
  }

  assemble(): Uint8Array {
    if (!this.isComplete) {
      throw new Error(`数据未收齐 (${this._solvedCount}/${this.total})`);
    }
    const full = new Uint8Array(this.total * this.bs);
    for (let i = 0; i < this.total; i++) {
      full.set(this.solved[i]!, i * this.bs);
    }
    return full.subarray(0, this.size);
  }

  serialize(): SerializedSession {
    const solved: Array<[number, Uint8Array]> = [];
    for (let i = 0; i < this.total; i++) {
      if (this.solved[i] !== null) solved.push([i, this.solved[i]!]);
    }
    const basis: Array<[number[], Uint8Array]> = [];
    for (const row of this.basis.values()) {
      basis.push([[...row.vars], row.data]);
    }
    return {
      sid: this.sid,
      size: this.size,
      bs: this.bs,
      total: this.total,
      solved,
      basis,
      updatedAt: Date.now(),
    };
  }

  static deserialize(saved: SerializedSession): AirBridgeSolver {
    const solver = new AirBridgeSolver(saved.sid, saved.size, saved.bs);
    const dummy: number[] = [];
    for (const [id, data] of saved.solved) {
      if (id >= 0 && id < solver.total && data.length === solver.bs) {
        solver.solved[id] = new Uint8Array(data);
        solver._solvedCount++;
      }
    }
    for (const [vars, data] of saved.basis) {
      if (data.length === solver.bs) {
        solver.addEquation(new Set(vars), new Uint8Array(data), dummy);
      }
    }
    if (solver.rank === solver.total && !solver.isComplete) {
      solver.backSubstitute(dummy);
    }
    return solver;
  }
}
