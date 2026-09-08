const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

export class LcuSchemaService {
  #schema = null;

  constructor({ client } = {}) {
    this.client = client;
  }

  async fetchSchema({ refresh = false } = {}) {
    if (this.#schema && !refresh) {
      return this.#schema;
    }

    if (!this.client || typeof this.client.get !== 'function') {
      throw new Error('LCU client is required to fetch schema');
    }

    const response = await this.client.get('/swagger/v2/swagger.json');
    if (response?.status && response.status >= 400) {
      throw new Error(`LCU request GET /swagger/v2/swagger.json failed: HTTP ${response.status}`);
    }

    let data = response?.body !== undefined ? response.body : response;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        // Keep raw data if not JSON
      }
    }

    this.#schema = data;
    return this.#schema;
  }

  dereference(target, definitions, depth = 0, seen = new Set()) {
    if (target === null || typeof target !== 'object') {
      return target;
    }

    if (depth >= 3) {
      return target;
    }

    if (seen.has(target)) {
      return target;
    }

    const nextSeen = new Set(seen);
    nextSeen.add(target);

    if (Array.isArray(target)) {
      return target.map((item) => this.dereference(item, definitions, depth, nextSeen));
    }

    let result = { ...target };

    if (typeof target.$ref === 'string') {
      const ref = target.$ref;
      const modelName = ref.startsWith('#/definitions/')
        ? ref.slice('#/definitions/'.length)
        : ref.split('/').pop();

      const def = definitions?.[modelName];
      if (def) {
        const resolved = this.dereference(def, definitions, depth + 1, nextSeen);
        result = { ...resolved, ...result };
      }
    }

    const output = {};
    for (const [key, value] of Object.entries(result)) {
      if (key !== '$ref' && value !== null && typeof value === 'object') {
        output[key] = this.dereference(value, definitions, depth, nextSeen);
      } else {
        output[key] = value;
      }
    }

    return output;
  }

  async query({ path, method, model, refresh = false } = {}) {
    const doc = await this.fetchSchema({ refresh });
    const definitions = doc?.definitions || {};
    const paths = doc?.paths || {};

    if (model) {
      let def = definitions[model];
      let matchedModel = model;
      if (!def) {
        const lower = model.toLowerCase();
        const found = Object.keys(definitions).find((k) => k.toLowerCase() === lower);
        if (found) {
          def = definitions[found];
          matchedModel = found;
        }
      }
      return {
        model: matchedModel,
        schema: def ? this.dereference(def, definitions) : null
      };
    }

    if (path !== undefined && path !== null && path !== '') {
      const lowerPath = path.toLowerCase();
      const allPaths = Object.keys(paths);

      const exactMatch = allPaths.find((p) => p.toLowerCase() === lowerPath);
      const matchingPathKeys = exactMatch
        ? [exactMatch]
        : allPaths.filter((p) => p.toLowerCase().includes(lowerPath));

      const matchedPaths = {};
      const upperMethod = method ? String(method).toUpperCase() : null;

      for (const p of matchingPathKeys) {
        const pathItem = paths[p];
        if (!pathItem || typeof pathItem !== 'object') continue;

        const filteredOps = {};
        for (const [verb, op] of Object.entries(pathItem)) {
          const verbUpper = verb.toUpperCase();
          if (!HTTP_METHODS.has(verbUpper)) continue;
          if (upperMethod && verbUpper !== upperMethod) continue;

          filteredOps[verb.toLowerCase()] = this.dereference(op, definitions);
        }

        if (Object.keys(filteredOps).length > 0) {
          matchedPaths[p] = filteredOps;
        }
      }

      return {
        paths: matchedPaths
      };
    }

    return {
      info: doc?.info || {},
      pathsCount: Object.keys(paths).length,
      definitionsCount: Object.keys(definitions).length,
      paths: Object.keys(paths)
    };
  }
}
