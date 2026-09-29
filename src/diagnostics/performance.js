export function extractPerformanceMetrics(metricsList = []) {
  const map = new Map(metricsList.map((m) => [m.name, m.value]));
  const heapUsed = map.get('JSHeapUsedSize') ?? 0;
  const heapTotal = map.get('JSHeapTotalSize') ?? 0;
  const nodes = map.get('Nodes') ?? 0;
  const layoutCount = map.get('LayoutCount') ?? 0;
  const recalcStyleCount = map.get('RecalcStyleCount') ?? 0;
  const taskDuration = map.get('TaskDuration') ?? 0;
  const scriptDuration = map.get('ScriptDuration') ?? 0;

  const heapUsedMb = Math.round((heapUsed / (1024 * 1024)) * 10) / 10;
  const heapTotalMb = Math.round((heapTotal / (1024 * 1024)) * 10) / 10;

  const warnings = [];
  if (heapUsedMb > 250) {
    warnings.push(`High JS Heap usage (${heapUsedMb} MB). Potential memory leak in frontend plugins.`);
  }
  if (nodes > 15000) {
    warnings.push(`High DOM node count (${nodes}). Detached DOM nodes or uncleaned viewports detected.`);
  }

  return {
    jsHeapUsedMb: heapUsedMb,
    jsHeapTotalMb: heapTotalMb,
    heapUtilizationRatio: heapTotal > 0 ? Math.round((heapUsed / heapTotal) * 100) / 100 : 0,
    nodesCount: nodes,
    layoutCount,
    recalcStyleCount,
    taskDurationSeconds: Math.round(taskDuration * 100) / 100,
    scriptDurationSeconds: Math.round(scriptDuration * 100) / 100,
    warnings
  };
}
