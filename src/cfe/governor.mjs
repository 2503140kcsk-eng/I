const TASK_KINDS = new Set([
  "verify_certificate", "extract_proof", "dfpn_search", "normal_search", "neural_inference"
]);

function finiteNonNegative(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(label + " must be a finite non-negative number");
  }
  return value;
}

function unitInterval(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(label + " must be between 0 and 1");
  }
  return value;
}

function validateBudget(budget) {
  return {
    cpuMs: finiteNonNegative(budget.cpuMs, "budget.cpuMs"),
    gpuMs: finiteNonNegative(budget.gpuMs, "budget.gpuMs"),
    memoryBytes: finiteNonNegative(budget.memoryBytes, "budget.memoryBytes"),
    currentTemperatureC: finiteNonNegative(budget.currentTemperatureC, "budget.currentTemperatureC"),
    maxTemperatureC: finiteNonNegative(budget.maxTemperatureC, "budget.maxTemperatureC")
  };
}

function taskDensity(task, weights) {
  const benefit = task.expectedValue * task.confidence + task.priority;
  const cost = 1 + task.cpuMs +
    task.gpuMs * weights.gpuMs +
    (task.memoryBytes / 1048576) * weights.memoryMiB +
    task.heatDeltaC * weights.heat;
  return benefit / cost;
}

/**
 * Deterministic resource scheduler. Verification is scheduled before ordinary
 * search. If it cannot fit, the plan reports it as blocked and never accepts
 * the certificate on the strength of the schedule alone.
 */
export function planTasks(tasks, budget, weights = {}) {
  if (!Array.isArray(tasks)) throw new TypeError("tasks must be an array");
  const remaining = validateBudget(budget);
  const w = {
    gpuMs: weights.gpuMs === undefined ? 1 : weights.gpuMs,
    memoryMiB: weights.memoryMiB === undefined ? 4 : weights.memoryMiB,
    heat: weights.heat === undefined ? 2 : weights.heat
  };
  for (const key of Object.keys(w)) finiteNonNegative(w[key], "weights." + key);

  const seenIds = new Set();
  const prepared = tasks.map(function (task) {
    if (!task || typeof task.id !== "string" || task.id.length === 0 || !TASK_KINDS.has(task.kind)) {
      throw new TypeError("Each task needs a unique id and supported kind");
    }
    if (seenIds.has(task.id)) throw new TypeError("Duplicate task id: " + task.id);
    seenIds.add(task.id);
    return {
      id: task.id,
      kind: task.kind,
      expectedValue: unitInterval(task.expectedValue, task.id + ".expectedValue"),
      confidence: unitInterval(task.confidence, task.id + ".confidence"),
      priority: unitInterval(task.priority === undefined ? 0 : task.priority, task.id + ".priority"),
      cpuMs: finiteNonNegative(task.cpuMs, task.id + ".cpuMs"),
      gpuMs: finiteNonNegative(task.gpuMs === undefined ? 0 : task.gpuMs, task.id + ".gpuMs"),
      memoryBytes: finiteNonNegative(task.memoryBytes, task.id + ".memoryBytes"),
      heatDeltaC: finiteNonNegative(task.heatDeltaC === undefined ? 0 : task.heatDeltaC, task.id + ".heatDeltaC")
    };
  });

  prepared.sort(function (a, b) {
    const aVerify = a.kind === "verify_certificate" ? 1 : 0;
    const bVerify = b.kind === "verify_certificate" ? 1 : 0;
    if (aVerify !== bVerify) return bVerify - aVerify;
    const density = taskDensity(b, w) - taskDensity(a, w);
    return density || a.id.localeCompare(b.id);
  });

  const selected = [];
  const deferred = [];
  let temperature = remaining.currentTemperatureC;
  for (const task of prepared) {
    const exceedsResources = task.cpuMs > remaining.cpuMs ||
      task.gpuMs > remaining.gpuMs || task.memoryBytes > remaining.memoryBytes;
    const exceedsThermal = temperature + task.heatDeltaC > remaining.maxTemperatureC;
    if (exceedsResources || exceedsThermal) {
      deferred.push({
        id: task.id,
        reason: exceedsThermal ? "thermal-budget" : "resource-budget"
      });
      continue;
    }
    selected.push({ id: task.id, kind: task.kind, score: taskDensity(task, w) });
    remaining.cpuMs -= task.cpuMs;
    remaining.gpuMs -= task.gpuMs;
    remaining.memoryBytes -= task.memoryBytes;
    temperature += task.heatDeltaC;
  }

  const verificationTasks = prepared.filter(function (task) {
    return task.kind === "verify_certificate";
  });
  const selectedIds = new Set(selected.map(function (task) { return task.id; }));
  const verificationBlocked = verificationTasks.some(function (task) {
    return !selectedIds.has(task.id);
  });

  return {
    selected: selected,
    deferred: deferred,
    remainingBudget: remaining,
    projectedTemperatureC: temperature,
    verificationBlocked: verificationBlocked,
    verificationScheduled: verificationTasks.length > 0 && !verificationBlocked,
    proofAcceptanceAllowed: false
  };
}
