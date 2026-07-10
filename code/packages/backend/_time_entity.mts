import { buildEntityView } from "./src/modules/entity/entity.service.js";
const dir = process.argv[2];
function timeit(label: string, r: boolean) {
  const t0 = process.hrtime.bigint();
  const v = buildEntityView(dir, { rollup: r }) as any;
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`${label}: ${ms.toFixed(0)} ms`);
}
console.log("dir:", dir);
timeit("  OLD menu (rollup on) ", true);
timeit("  NEW menu (rollup off)", false);
