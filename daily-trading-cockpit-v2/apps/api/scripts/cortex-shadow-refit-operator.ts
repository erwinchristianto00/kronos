import { runCortexShadowRefitOperator } from "../src/lib/cortex-shadow-refit-operator.js";

const report = runCortexShadowRefitOperator(process.argv.slice(2));
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = report.exitCode;
