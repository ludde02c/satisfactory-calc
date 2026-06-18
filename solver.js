// solver.js - JavaScript port of the SatisfactoryProjectGPT calculation engine.
// Mirrors core/factory_graph.py, core/constraints.py, core/recipe_index.py and
// core/build_plan.py. The game data is normalized ahead of time (see
// scripts/export_mobile_data.py) so no item-name normalization is needed here.

(function (global) {
  "use strict";

  // ---- Constants ---------------------------------------------------------

  const NATURAL_RESOURCE_ITEMS = new Set([
    "limestone", "iron_ore", "copper_ore", "caterium_ore", "coal",
    "raw_quartz", "sulfur", "bauxite", "sam", "uranium", "water",
    "crude_oil", "nitrogen_gas",
  ]);

  const FLUID_CATEGORIES = new Set(["liquid", "gas"]);

  const POWER_EXPONENT = 1.321928;

  const DEFAULT_POWER_BY_BUILDING = {
    smelter: 4.0, constructor: 4.0, assembler: 15.0, foundry: 16.0,
    manufacturer: 55.0, refinery: 30.0, packager: 10.0, blender: 75.0,
    particle_accelerator: 250.0, quantum_encoder: 0.0, converter: 250.0,
    miner_mk1: 5.0, miner_mk2: 12.0, miner_mk3: 30.0, water_extractor: 20.0,
    oil_extractor: 40.0, resource_well_extractor: 0.0,
  };

  const PURITY_RATES = { impure: 30.0, normal: 60.0, pure: 120.0 };

  const MINER_MULTIPLIERS = {
    mk1: 1.0, miner_mk1: 1.0, "1": 1.0,
    mk2: 2.0, miner_mk2: 2.0, "2": 2.0,
    mk3: 4.0, miner_mk3: 4.0, "3": 4.0,
  };

  // ---- Clock-plan constants (core/build_plan.py) -------------------------

  const CLOCK_STEP = 0.05;
  const THIRD_CLOCKS = [16.6666667, 33.3333333, 66.6666667, 83.3333333, 91.6666667];
  const NICE_CLOCKS = [
    100.0, 50.0, 25.0, 75.0, 66.6666667, 33.3333333,
    20.0, 40.0, 60.0, 80.0, 10.0, 30.0, 70.0, 90.0,
    12.5, 87.5, 37.5, 62.5, 16.6666667, 83.3333333,
  ];
  const MAX_EXTRA_MACHINES = 5;
  const EXTRA_MACHINE_PENALTY = 2.0;
  const OVERPRODUCTION_PENALTY = 10.0;
  const RANK_PENALTY = 0.25;

  // ---- Small helpers -----------------------------------------------------

  function titleCase(id) {
    return String(id).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // A defaultdict(float) stand-in built on a plain object.
  function bump(obj, key, amount) {
    obj[key] = (obj[key] || 0) + amount;
  }

  // Separator for composite accumulator keys (item/recipe ids never contain it).
  const SEP = String.fromCharCode(1);

  // ---- Data wrapper ------------------------------------------------------

  class GameData {
    constructor(data) {
      this.items = data.items || {};
      this.recipes = data.recipes || {};
      this.buildings = data.buildings || {};
      this.belts = data.belts || {};
      this.pipes = data.pipes || {};
      this.recipeIndex = new RecipeIndex(this.recipes);
    }

    itemName(id) {
      const item = this.items[id];
      return (item && item.name) || titleCase(id);
    }

    itemCategory(id) {
      const item = this.items[id];
      return item ? item.category : null;
    }

    isFluid(id) {
      return FLUID_CATEGORIES.has(this.itemCategory(id));
    }

    buildingName(id) {
      const b = this.buildings[id];
      return (b && b.name) || titleCase(id);
    }

    buildingPower(id) {
      const b = this.buildings[id];
      if (b && b.power != null) return Number(b.power);
      return DEFAULT_POWER_BY_BUILDING[id] || 0.0;
    }
  }

  // ---- RecipeIndex (core/recipe_index.py) --------------------------------

  class RecipeIndex {
    constructor(recipes) {
      this.recipes = recipes;
      this.byOutput = {};
      for (const recipeId of Object.keys(recipes)) {
        const recipe = recipes[recipeId];
        for (const item of Object.keys(recipe.outputs || {})) {
          (this.byOutput[item] = this.byOutput[item] || []).push(recipeId);
        }
      }
      for (const item of Object.keys(this.byOutput)) {
        this.byOutput[item].sort((a, b) => this._sortKey(a, b, item));
      }
    }

    _sortKey(a, b, item) {
      const ra = this.recipes[a];
      const rb = this.recipes[b];
      // Packager recipes are package/unpackage conversions (e.g. Packaged
      // Turbofuel -> Turbofuel). And a recipe where this item is only a
      // secondary output (e.g. Compacted Coal as a byproduct of Ionized Fuel)
      // is not a real way to produce it. Neither should be the default
      // producer when a proper recipe exists, or solving loops/cycles.
      const pkgA = ra.building === "packager" ? 1 : 0;
      const pkgB = rb.building === "packager" ? 1 : 0;
      if (pkgA !== pkgB) return pkgA - pkgB;
      const bypA = Object.keys(ra.outputs || {})[0] !== item ? 1 : 0;
      const bypB = Object.keys(rb.outputs || {})[0] !== item ? 1 : 0;
      if (bypA !== bypB) return bypA - bypB;
      const altA = ra.alternate ? 1 : 0;
      const altB = rb.alternate ? 1 : 0;
      if (altA !== altB) return altA - altB;
      return a < b ? -1 : a > b ? 1 : 0;
    }

    recipesFor(item, allowAlternate) {
      const ids = this.byOutput[item] || [];
      if (allowAlternate) return ids.slice();
      const standard = ids.filter((id) => !this.recipes[id].alternate);
      return standard.length ? standard : ids.slice();
    }

    chooseRecipe(item, allowAlternate, recipeOverrides) {
      recipeOverrides = recipeOverrides || {};
      const override = recipeOverrides[item];
      if (override) {
        const recipe = this.recipes[override];
        if (!recipe) throw new Error(`Recipe override '${override}' does not exist`);
        if (!(item in (recipe.outputs || {})))
          throw new Error(`Recipe override '${override}' does not produce '${item}'`);
        return override;
      }
      const ids = this.recipesFor(item, allowAlternate);
      return ids.length ? ids[0] : null;
    }

    describeRecipesFor(item) {
      return (this.byOutput[item] || []).map((id) => this.recipes[id]);
    }
  }

  // ---- Resource nodes & constraints (core/constraints.py) ----------------

  function minerId(miner) {
    const m = String(miner).toLowerCase().replace(/\./g, "").replace(/ /g, "_");
    if (m === "mk1" || m === "mk2" || m === "mk3") return `miner_${m}`;
    return m;
  }

  function nodeRate(node) {
    const purityRate = PURITY_RATES[String(node.purity).toLowerCase()] || PURITY_RATES.normal;
    const mult = MINER_MULTIPLIERS[String(node.miner).toLowerCase().replace(/\./g, "")] || 1.0;
    const clock = node.clock_percent == null ? 100.0 : node.clock_percent;
    return purityRate * mult * (node.count || 1) * (clock / 100.0);
  }

  function nodePower(node) {
    const base = DEFAULT_POWER_BY_BUILDING[minerId(node.miner)] || 0.0;
    const clock = node.clock_percent == null ? 100.0 : node.clock_percent;
    return base * (node.count || 1) * Math.pow(clock / 100.0, POWER_EXPONENT);
  }

  class Constraints {
    constructor(opts) {
      opts = opts || {};
      this.max_belt_mk = opts.max_belt_mk == null ? 6 : opts.max_belt_mk;
      this.max_pipe_mk = opts.max_pipe_mk == null ? 2 : opts.max_pipe_mk;
      this.resource_limits = opts.resource_limits || {};
      this.resource_nodes = opts.resource_nodes || [];
      this.power_limit = opts.power_limit == null ? null : opts.power_limit;
    }

    combinedResourceLimits() {
      const limits = Object.assign({}, this.resource_limits);
      for (const node of this.resource_nodes) {
        limits[node.item] = (limits[node.item] || 0) + nodeRate(node);
      }
      return limits;
    }

    nodePower() {
      return this.resource_nodes.reduce((sum, n) => sum + nodePower(n), 0);
    }

    hasAnyLimit() {
      return Object.keys(this.combinedResourceLimits()).length > 0 || this.power_limit != null;
    }
  }

  function clockedPower(basePower, exactMachines) {
    if (exactMachines <= 0 || basePower <= 0) return 0.0;
    return basePower * exactMachines; // linear budget model, matches Python
  }

  // ---- FactoryGraph (core/factory_graph.py) ------------------------------

  class FactoryGraph {
    constructor(gameData) {
      this.data = gameData;
      this.recipes = gameData.recipes;
      this.recipeIndex = gameData.recipeIndex;
    }

    solve(item, rate, constraints, allowAlternate, recipeOverrides) {
      return this._solveFixed(item, Number(rate), constraints || new Constraints(),
        !!allowAlternate, recipeOverrides || {}, false);
    }

    maximize(item, constraints, allowAlternate, recipeOverrides) {
      if (!constraints.hasAnyLimit())
        throw new Error("Maximize needs at least one resource limit, node, or power limit");
      recipeOverrides = recipeOverrides || {};

      let low = 0.0;
      let high = 1.0;
      while (high < 1000000) {
        const r = this._solveFixed(item, high, constraints, allowAlternate, recipeOverrides, true);
        if (!r.feasible) break;
        low = high;
        high *= 2;
      }
      for (let i = 0; i < 50; i++) {
        const mid = (low + high) / 2;
        const r = this._solveFixed(item, mid, constraints, allowAlternate, recipeOverrides, true);
        if (r.feasible) low = mid; else high = mid;
      }
      return this._solveFixed(item, low, constraints, allowAlternate, recipeOverrides, true);
    }

    _solveFixed(item, rate, constraints, allowAlternate, recipeOverrides, maximized) {
      const acc = this._newAccumulator();
      this._expand(item, Number(rate), acc, allowAlternate, recipeOverrides, []);
      return this._buildResult(item, Number(rate), acc, constraints, allowAlternate, maximized);
    }

    _newAccumulator() {
      return {
        recipe_usage: Object.create(null),
        recipe_inputs: Object.create(null),
        item_usage: Object.create(null),
        item_production: Object.create(null),
        raw_resources: Object.create(null),
        byproducts: Object.create(null),
        warnings: [],
      };
    }

    _expand(item, rate, acc, allowAlternate, recipeOverrides, stack) {
      if (rate <= 0) return;

      if (stack.indexOf(item) !== -1) {
        bump(acc.raw_resources, item, rate);
        acc.warnings.push(
          `Cycle detected for ${this.data.itemName(item)}. Treated ${rate.toFixed(2)}/min as an external input.`);
        return;
      }

      if (NATURAL_RESOURCE_ITEMS.has(item) && !(item in recipeOverrides)) {
        bump(acc.raw_resources, item, rate);
        return;
      }

      const recipeId = this.recipeIndex.chooseRecipe(item, allowAlternate, recipeOverrides);
      if (recipeId == null) {
        bump(acc.raw_resources, item, rate);
        return;
      }

      const recipe = this.recipes[recipeId];
      const outputRate = (recipe.outputs || {})[item] || 0;
      if (outputRate <= 0) {
        bump(acc.raw_resources, item, rate);
        acc.warnings.push(
          `Recipe ${recipeId} could not produce ${this.data.itemName(item)}. Treated it as raw input.`);
        return;
      }

      const exactMachines = rate / outputRate;
      bump(acc.recipe_usage, recipeId + SEP + item, rate);
      bump(acc.item_production, item, rate);

      for (const outputItem of Object.keys(recipe.outputs || {})) {
        const producedRate = recipe.outputs[outputItem] * exactMachines;
        if (outputItem !== item) {
          bump(acc.item_production, outputItem, producedRate);
          bump(acc.byproducts, outputItem, producedRate);
        }
      }

      for (const inputItem of Object.keys(recipe.inputs || {})) {
        const requiredRate = recipe.inputs[inputItem] * exactMachines;
        bump(acc.recipe_inputs, recipeId + SEP + item + SEP + inputItem, requiredRate);
        bump(acc.item_usage, inputItem, requiredRate);
        this._expand(inputItem, requiredRate, acc, allowAlternate, recipeOverrides, stack.concat([item]));
      }
    }

    _buildResult(targetItem, targetRate, acc, constraints, allowAlternate, maximized) {
      const steps = this._buildRecipeSteps(acc);
      const machines = Object.create(null);
      const machinesExact = Object.create(null);
      const powerByBuilding = Object.create(null);

      for (const step of steps) {
        bump(machines, step.building, step.machines);
        bump(machinesExact, step.building, step.machines_exact);
        bump(powerByBuilding, step.building, step.power);
      }

      const nodePwr = constraints.nodePower();
      const totalPower = Object.values(powerByBuilding).reduce((a, b) => a + b, 0) + nodePwr;
      const resources = sortedObject(acc.raw_resources);
      const limits = constraints.combinedResourceLimits();
      const unusedResources = Object.create(null);
      const resourceIssues = [];

      for (const item of Object.keys(limits).sort()) {
        const used = resources[item] || 0;
        unusedResources[item] = Math.max(0, limits[item] - used);
        if (used > limits[item] + 0.0001) {
          resourceIssues.push({ item, used, limit: limits[item], over: used - limits[item] });
        }
      }

      let powerIssue = null;
      if (constraints.power_limit != null && totalPower > constraints.power_limit + 0.0001) {
        powerIssue = { used: totalPower, limit: constraints.power_limit, over: totalPower - constraints.power_limit };
      }

      const transport = this._buildTransport(resources, acc, constraints);
      const nodeTransport = this._buildNodeTransport(constraints);
      const flowRecommendations = this._buildFlowRecommendations(steps, constraints);
      const feasible = resourceIssues.length === 0 && powerIssue == null;

      return {
        target_item: targetItem,
        target_name: this.data.itemName(targetItem),
        target_rate: targetRate,
        maximized,
        allow_alternate: allowAlternate,
        feasible,
        machines: sortedObject(machines),
        machines_exact: sortedObject(machinesExact),
        steps,
        items: sortedObject(acc.item_usage),
        resources,
        resource_limits: limits,
        unused_resources: sortedObject(unusedResources),
        resource_issues: resourceIssues,
        byproducts: sortedObject(acc.byproducts),
        power: totalPower,
        power_by_building: sortedObject(powerByBuilding),
        node_power: nodePwr,
        power_limit: constraints.power_limit,
        power_issue: powerIssue,
        transport,
        node_transport: nodeTransport,
        flow_recommendations: flowRecommendations,
        warnings: acc.warnings,
      };
    }

    _buildRecipeSteps(acc) {
      const steps = [];
      const keys = Object.keys(acc.recipe_usage).sort();
      for (const key of keys) {
        const rate = acc.recipe_usage[key];
        const [recipeId, item] = key.split(SEP);
        const recipe = this.recipes[recipeId];
        const outputRate = recipe.outputs[item];
        const machinesExact = rate / outputRate;
        const physicalMachines = Math.ceil(machinesExact);
        const clockPercent = physicalMachines === 0 ? 0 : (machinesExact / physicalMachines) * 100;
        const building = recipe.building;
        const basePower = this.data.buildingPower(building);

        const inputs = {};
        for (const inputItem of Object.keys(recipe.inputs || {})) {
          inputs[inputItem] = recipe.inputs[inputItem] * machinesExact;
        }
        const outputs = {};
        for (const outputItem of Object.keys(recipe.outputs || {})) {
          outputs[outputItem] = recipe.outputs[outputItem] * machinesExact;
        }

        steps.push({
          recipe_id: recipeId,
          recipe_name: recipe.name || this.data.itemName(item),
          item,
          item_name: this.data.itemName(item),
          rate,
          building,
          building_name: this.data.buildingName(building),
          machines_exact: machinesExact,
          machines: physicalMachines,
          clock_percent: clockPercent,
          power: clockedPower(basePower, machinesExact),
          inputs,
          outputs,
          alternate: !!recipe.alternate,
        });
      }
      return steps;
    }

    _buildTransport(resources, acc, constraints) {
      const flows = Object.create(null);
      const merge = (src) => {
        for (const item of Object.keys(src)) {
          flows[item] = Math.max(flows[item] || 0, src[item]);
        }
      };
      merge(resources);
      merge(acc.item_usage);
      merge(acc.item_production);

      const plans = [];
      for (const item of Object.keys(flows).sort()) {
        const plan = this._transportPlan(item, flows[item], constraints);
        if (plan) plans.push(plan);
      }
      return plans;
    }

    _buildNodeTransport(constraints) {
      const plans = [];
      for (const node of constraints.resource_nodes) {
        const plan = this._transportPlan(node.item, nodeRate(node), constraints);
        if (plan) {
          plan.source = "node";
          plan.purity = node.purity;
          plan.miner = minerId(node.miner);
          plan.node_count = node.count;
          plans.push(plan);
        }
      }
      return plans;
    }

    _buildFlowRecommendations(steps, constraints) {
      const recommendations = [];
      for (const step of steps) {
        const recipe = this.recipes[step.recipe_id];
        for (const inputItem of Object.keys(recipe.inputs || {})) {
          const inputPerMachine = recipe.inputs[inputItem];
          const totalRate = inputPerMachine * step.machines_exact;
          const plan = this._transportPlan(inputItem, totalRate, constraints);
          if (!plan || !plan.needs_split || inputPerMachine <= 0) continue;
          recommendations.push({
            item: inputItem,
            item_name: this.data.itemName(inputItem),
            target_item: step.item,
            target_name: step.item_name,
            building_name: step.building_name,
            transport_name: plan.transport_name,
            lines: plan.lines,
            rate: totalRate,
            capacity: plan.capacity,
            machines_per_line: plan.capacity / inputPerMachine,
          });
        }
      }
      return recommendations;
    }

    _transportPlan(item, rate, constraints) {
      if (rate <= 0) return null;
      const kind = this.data.isFluid(item) ? "pipe" : "belt";
      const transport = this._selectTransport(kind, constraints);
      if (!transport) return null;
      const capacity = Number(transport.speed);
      const lines = Math.max(1, Math.ceil(rate / capacity));
      return {
        item,
        item_name: this.data.itemName(item),
        kind,
        transport_id: transport.id,
        transport_name: transport.name,
        mk: transport.mk,
        capacity,
        rate,
        lines,
        rate_per_line: rate / lines,
        needs_split: lines > 1,
      };
    }

    _selectTransport(kind, constraints) {
      const data = kind === "pipe" ? this.data.pipes : this.data.belts;
      const maxMk = kind === "pipe" ? constraints.max_pipe_mk : constraints.max_belt_mk;
      let best = null;
      for (const id of Object.keys(data)) {
        const t = data[id];
        const mk = parseInt(t.mk || 0, 10);
        if (mk <= maxMk && t.speed) {
          if (!best || mk > best.mk) best = Object.assign({ id }, t);
        }
      }
      return best;
    }
  }

  function sortedObject(obj) {
    const out = Object.create(null);
    for (const key of Object.keys(obj).sort()) out[key] = obj[key];
    return out;
  }

  // ---- Clock plan & formatting (core/build_plan.py) ----------------------

  function roundClockPercent(value, step) {
    step = step || CLOCK_STEP;
    if (value <= 0) return 0.0;
    for (const third of THIRD_CLOCKS) {
      if (Math.abs(value - third) < 0.04) return round2(third);
    }
    return round2(Math.round(value / step) * step);
  }

  function round2(v) {
    return Math.round(v * 100) / 100;
  }

  function formatClock(value) {
    return roundClockPercent(value).toFixed(2) + "%";
  }

  function clockQuality(clock, baseRate) {
    let bestDistance = Infinity;
    let bestRank = 0;
    NICE_CLOCKS.forEach((nice, index) => {
      const d = Math.abs(clock - nice);
      if (d < bestDistance) { bestDistance = d; bestRank = index; }
    });
    let penalty = bestDistance * 3.0 + bestRank * RANK_PENALTY;
    if (clock < 20) penalty += (20 - clock) * 0.3;
    if (baseRate) {
      const rate = baseRate * clock / 100.0;
      penalty += Math.abs(rate - Math.round(rate)) * 5.0;
    }
    return penalty;
  }

  function plan(machines, full, partial, partialClock, text) {
    return { machines, full_machines: full, partial_machines: partial, partial_clock: partialClock, text };
  }

  function machineClockPlan(exactMachines, baseRate) {
    const exact = Number(exactMachines);
    if (exact <= 0) return plan(0, 0, 0, 0.0, "0 machines");

    if (Math.abs(exact - Math.round(exact)) < 0.0001) {
      const m = Math.round(exact);
      return plan(m, m, 0, 100.0, `${m} x 100.00%`);
    }

    const ceilM = Math.ceil(exact);
    const floorM = Math.floor(exact);
    const cap = ceilM + MAX_EXTRA_MACHINES;

    let best = null; // [score, machines, full, partial, clock, overflow]
    const better = (a, b) => {
      // Lexicographic compare like Python tuple comparison.
      for (let i = 0; i < a.length; i++) {
        if (a[i] < b[i]) return true;
        if (a[i] > b[i]) return false;
      }
      return false;
    };

    for (let full = 0; full <= floorM; full++) {
      const partialMin = Math.max(1, Math.ceil(exact - full - 1e-9));
      for (let partial = partialMin; partial <= cap - full; partial++) {
        const clock = (exact - full) / partial * 100.0;
        if (clock <= 0 || clock > 100.0 + 1e-9) continue;
        const machines = full + partial;
        const extra = Math.max(0, machines - ceilM);
        const score = clockQuality(clock, baseRate) + extra * EXTRA_MACHINE_PENALTY + partial * 0.05;
        const candidate = [score, machines, full, partial, clock, 0.0];
        if (best === null || better(candidate, best)) best = candidate;
      }
    }

    const overflow = ceilM - exact;
    const fallback = [overflow * OVERPRODUCTION_PENALTY, ceilM, ceilM, 0, 100.0, overflow];
    if (best === null || better(fallback, best)) best = fallback;

    let [, machines, full, partial, clock] = best;
    clock = roundClockPercent(clock);

    let partialLabel = `${partial} x ${clock.toFixed(2)}%`;
    if (baseRate && partial) {
      const partialRate = baseRate * (exact - full) / partial;
      partialLabel += ` (${formatRate(partialRate)}/min)`;
    }

    let text;
    if (partial === 0) text = `${full} x 100.00%`;
    else if (full === 0) text = partialLabel;
    else text = `${full} x 100.00% + ${partialLabel}`;

    return plan(machines, full, partial, clock, text);
  }

  function formatRate(value) {
    value = Number(value);
    if (Math.abs(value) < 0.0001) return "0";
    if (Math.abs(value - Math.round(value)) < 0.0001) return String(Math.round(value));
    if (Math.abs(value) >= 100) return trimZeros(value.toFixed(1));
    return trimZeros(value.toFixed(2));
  }

  function trimZeros(s) {
    return s.replace(/\.?0+$/, "");
  }

  // ---- Build modules (core/build_plan.py) --------------------------------

  function consumersByItem(steps) {
    const stepByItem = {};
    for (const step of steps) stepByItem[step.item] = step;
    const consumers = {};
    for (const step of steps) {
      for (const inputItem of Object.keys(step.inputs || {})) {
        if (inputItem in stepByItem) {
          (consumers[inputItem] = consumers[inputItem] || []).push(step);
        }
      }
    }
    return consumers;
  }

  function computeLevels(steps) {
    const stepByItem = {};
    for (const step of steps) stepByItem[step.item] = step;
    const cache = {};

    function levelFor(item, stack) {
      stack = stack || new Set();
      if (item in cache) return cache[item];
      if (stack.has(item) || !(item in stepByItem)) return 0;
      const deps = Object.keys(stepByItem[item].inputs || {}).filter((i) => i in stepByItem);
      if (!deps.length) { cache[item] = 0; return 0; }
      const nextStack = new Set(stack);
      nextStack.add(item);
      cache[item] = 1 + Math.max(...deps.map((d) => levelFor(d, nextStack)));
      return cache[item];
    }

    const levels = {};
    for (const step of steps) levels[step.item] = levelFor(step.item);
    return levels;
  }

  function primaryRawLines(result) {
    const steps = result.steps || [];
    const stepByItem = {};
    for (const step of steps) stepByItem[step.item] = step;
    const rawItems = new Set(Object.keys(result.resources || {}));
    const memo = {};

    function rawMix(item, stack) {
      stack = stack || new Set();
      if (rawItems.has(item) || !(item in stepByItem)) return { [item]: 1.0 };
      if (item in memo) return memo[item];
      if (stack.has(item)) return {};
      const mix = {};
      const inputs = stepByItem[item].inputs || {};
      const total = Object.values(inputs).reduce((a, b) => a + b, 0) || 1.0;
      const nextStack = new Set(stack);
      nextStack.add(item);
      for (const inputItem of Object.keys(inputs)) {
        const share = inputs[inputItem] / total;
        const sub = rawMix(inputItem, nextStack);
        for (const raw of Object.keys(sub)) bump(mix, raw, share * sub[raw]);
      }
      memo[item] = mix;
      return mix;
    }

    const primary = {};
    for (const step of steps) {
      const mix = rawMix(step.item);
      const keys = Object.keys(mix);
      primary[step.item] = keys.length ? keys.reduce((a, b) => (mix[b] > mix[a] ? b : a)) : step.item;
    }
    return primary;
  }

  function moduleTitle(level, maxLevel) {
    const number = level + 1;
    let name;
    if (level === 0) name = "Raw and Base Production";
    else if (level === maxLevel) name = "Final Assembly";
    else name = "Intermediate Production";
    return `Module ${number} - ${name}`;
  }

  function moduleStep(data, step, consumers) {
    const inputLines = Object.keys(step.inputs || {})
      .sort((a, b) => cmp(data.itemName(a), data.itemName(b)))
      .map((i) => `${data.itemName(i)} ${formatRate(step.inputs[i])}/min`);
    const outputLines = Object.keys(step.outputs || {})
      .sort((a, b) => cmp(data.itemName(a), data.itemName(b)))
      .map((i) => `${data.itemName(i)} ${formatRate(step.outputs[i])}/min`);
    const feeders = (consumers[step.item] || []).slice()
      .sort((a, b) => cmp(a.item_name, b.item_name))
      .map((c) => c.item_name);
    const baseRate = step.machines_exact ? step.rate / step.machines_exact : null;

    return {
      item: step.item,
      item_name: step.item_name,
      recipe_id: step.recipe_id,
      building_name: step.building_name,
      machines: step.machines,
      machines_exact: step.machines_exact,
      clock_percent: roundClockPercent(step.clock_percent),
      clock_text: formatClock(step.clock_percent),
      clock_plan: machineClockPlan(step.machines_exact, baseRate),
      rate: step.rate,
      rate_text: `${formatRate(step.rate)}/min`,
      inputs: inputLines,
      outputs: outputLines,
      feeds_into: feeders,
    };
  }

  function cmp(a, b) {
    a = String(a).toLowerCase();
    b = String(b).toLowerCase();
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function buildModules(data, result) {
    const steps = result.steps || [];
    const consumers = consumersByItem(steps);
    const levels = computeLevels(steps);

    const grouped = {};
    for (const step of steps) {
      (grouped[levels[step.item]] = grouped[levels[step.item]] || []).push(moduleStep(data, step, consumers));
    }

    const maxLevel = Object.keys(grouped).length
      ? Math.max(...Object.keys(grouped).map(Number)) : 0;
    const modules = [];
    for (const level of Object.keys(grouped).map(Number).sort((a, b) => a - b)) {
      modules.push({
        level,
        title: moduleTitle(level, maxLevel),
        steps: grouped[level].sort((a, b) => cmp(a.item_name, b.item_name)),
      });
    }
    return modules;
  }

  function groupModules(data, result, mode) {
    mode = mode || "depth";
    if (mode === "depth") return buildModules(data, result);

    const steps = result.steps || [];
    if (!steps.length) return [];
    const consumers = consumersByItem(steps);
    const levels = computeLevels(steps);
    const built = {};
    for (const step of steps) built[step.item] = moduleStep(data, step, consumers);

    let keyFor, labelFor;
    if (mode === "building") {
      keyFor = {};
      for (const step of steps) keyFor[step.item] = step.building_name;
      labelFor = (k) => k;
    } else if (mode === "resource") {
      keyFor = primaryRawLines(result);
      labelFor = (k) => `${data.itemName(k)} line`;
    } else {
      throw new Error(`Unknown module grouping mode: ${mode}`);
    }

    const grouped = {};
    for (const step of steps) {
      const key = keyFor[step.item];
      (grouped[key] = grouped[key] || []).push(built[step.item]);
    }

    const groupSortKey = (key) => {
      const members = grouped[key];
      const minLevel = Math.min(...members.map((m) => levels[m.item] || 0));
      return [minLevel, labelFor(key).toLowerCase()];
    };

    const orderedKeys = Object.keys(grouped).sort((a, b) => {
      const ka = groupSortKey(a), kb = groupSortKey(b);
      if (ka[0] !== kb[0]) return ka[0] - kb[0];
      return cmp(ka[1], kb[1]);
    });

    const modules = [];
    orderedKeys.forEach((key, index) => {
      modules.push({
        level: index,
        title: `Module ${index + 1} - ${labelFor(key)}`,
        steps: grouped[key].sort((a, b) => cmp(a.item_name, b.item_name)),
      });
    });
    return modules;
  }

  // ---- Public API --------------------------------------------------------

  global.SatisfactorySolver = {
    GameData,
    FactoryGraph,
    Constraints,
    RecipeIndex,
    nodeRate,
    nodePower,
    minerId,
    groupModules,
    buildModules,
    computeLevels,
    machineClockPlan,
    roundClockPercent,
    formatClock,
    formatRate,
    NATURAL_RESOURCE_ITEMS,
    PURITY_RATES,
    MINER_MULTIPLIERS,
  };
})(typeof window !== "undefined" ? window : this);
