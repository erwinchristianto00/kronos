/**
 * OPERATOR SCRIPT (report-only subsystem): force ONE meta-label refit anchored on a CHOSEN previous
 * model version instead of on the latest one.
 *
 * WHY THIS EXISTS (2026-07-26): the nightly refit anchors to the last model (wPrior), which is what
 * gives successive fits continuity. But that same continuity means a model that turned out to be
 * ANTI-predictive keeps anchoring its own successors. Measured on testnet, walk-forward, each cohort
 * scored only by the model that froze it:
 *     v3 (n=2469): corr(score,netR) +0.052, lift at tau=0.70  +0.0853R
 *     v4 (n=1459): corr(score,netR) -0.174, lift at tau=0.70  -0.2125R
 * v4 is the active model, so without this the gate would keep being re-anchored on the bad one.
 * (The v3→v4 swing itself is what META_LABEL_REFIT_MAX_JUMP + wPrior anchoring now prevent going
 * forward — see meta-label-gate.ts. This script is the one-off escape from the version already
 * installed before that guard existed.)
 *
 * HONESTY NOTE — this is a judgment call, not a proof. v3 was selected BECAUSE it measured best out
 * of four versions, which is mild selection bias; its +0.052 correlation is real but modest
 * (t=+2.59). Anchoring on it does NOT guarantee the resulting fit is good — it only refuses to keep
 * building on the one version measured to be actively harmful. Whatever this installs is unproven
 * until its OWN walk-forward cohort accumulates, which is exactly what
 * report.cohortsCurrentModel now measures.
 *
 * SAFETY: meta-label-gate.ts is scored-only — nothing reads its score on any admission, resolution,
 * allocation or live path (verified by grep: the only importer outside its own tests is
 * routes/shadow.ts, which serves the report). This script therefore cannot move money. It refuses to
 * install anything the normal fit path would have rejected, and --dry-run changes nothing.
 */
import {
  META_LABEL_FEATURE_SCHEMA_VERSION,
  META_LABEL_MIN_EXAMPLES,
  fitMetaLabelLogistic,
  getMetaLabelStore,
  type MetaLabelTrainingExample,
} from "../src/lib/meta-label-gate.js";

function arg(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

function main(): void {
  const dataDir = arg("data-dir") ?? "data";
  const priorVersion = Number(arg("prior-version") ?? "3");
  const dryRun = process.argv.includes("--dry-run");

  if (!Number.isInteger(priorVersion) || priorVersion <= 0) {
    console.error("[meta-label-refit-from-prior] --prior-version must be a positive integer");
    process.exitCode = 1;
    return;
  }

  const store = getMetaLabelStore(dataDir);
  const models = store.models;
  const prior = models.find((m) => m.version === priorVersion);
  const latest = models.length ? models[models.length - 1]! : null;

  console.log(`[meta-label-refit-from-prior] dataDir=${dataDir} dryRun=${dryRun}`);
  console.log(`  versions stored : ${models.map((m) => m.version).join(", ") || "(none)"}`);
  console.log(`  latest          : v${latest?.version ?? "-"} (nTrain=${latest?.nTrain ?? "-"})`);
  console.log(`  chosen prior    : v${priorVersion} (nTrain=${prior?.nTrain ?? "-"})`);

  if (!prior) {
    console.error(`[meta-label-refit-from-prior] version ${priorVersion} is not in the store's model history — nothing to anchor on.`);
    process.exitCode = 1;
    return;
  }
  if (prior.featureSchemaVersion !== META_LABEL_FEATURE_SCHEMA_VERSION) {
    console.error(
      `[meta-label-refit-from-prior] REFUSING: v${priorVersion} was fit under feature schema ` +
        `${prior.featureSchemaVersion}, current is ${META_LABEL_FEATURE_SCHEMA_VERSION}. Its weights index a ` +
        `different feature vector, so anchoring on them would be meaningless.`,
    );
    process.exitCode = 1;
    return;
  }

  const examples: MetaLabelTrainingExample[] = store.all
    .filter((r) => r.label != null && !r.voided && r.featureSchemaVersion === META_LABEL_FEATURE_SCHEMA_VERSION)
    .map((r) => ({ features: r.features, y: (r.label!.win ? 1 : 0) as 0 | 1 }));
  console.log(`  labeled examples: ${examples.length} (min ${META_LABEL_MIN_EXAMPLES})`);

  const fit = fitMetaLabelLogistic(examples, { wPrior: prior.weights });
  console.log(`  fit status      : ${fit.status} (nTrain=${fit.nTrain})`);

  if (fit.status !== "ACCEPTED") {
    console.error(`[meta-label-refit-from-prior] not installing — the fit was rejected exactly as the nightly path would reject it.`);
    process.exitCode = 1;
    return;
  }

  const jumpFromPrior = Math.max(...fit.weights.map((w, i) => Math.abs(w - prior.weights[i]!)));
  const jumpFromLatest = latest ? Math.max(...fit.weights.map((w, i) => Math.abs(w - latest.weights[i]!))) : null;
  console.log(`  max|w - v${priorVersion}|      : ${jumpFromPrior.toFixed(4)}`);
  if (jumpFromLatest !== null) console.log(`  max|w - v${latest!.version}| (latest): ${jumpFromLatest.toFixed(4)}`);

  if (dryRun) {
    console.log("[meta-label-refit-from-prior] DRY RUN — nothing written.");
    return;
  }

  const installed = store.addModel({
    weights: fit.weights,
    featureSchemaVersion: META_LABEL_FEATURE_SCHEMA_VERSION,
    fittedAtIso: new Date().toISOString(),
    fittedAtMs: Date.now(),
    nTrain: fit.nTrain,
  });
  store.save();
  console.log(`[meta-label-refit-from-prior] installed v${installed.version}, anchored on v${priorVersion}.`);
  console.log(
    `  NOTE: existing scores are NOT retro-changed (walk-forward). Only signals scored from now on ` +
      `carry v${installed.version}, and only THEIR cohort measures it — see report.cohortsCurrentModel.`,
  );
}

main();
