// app.js - UI glue for the Satisfactory mobile calculator.
(function () {
  "use strict";

  const S = window.SatisfactorySolver;
  const data = new S.GameData(window.GAME_DATA);
  const graph = new S.FactoryGraph(data);

  // ---- Item lists -------------------------------------------------------

  // Items you can actually target (anything a recipe produces), sorted by name.
  const producible = Object.keys(data.recipeIndex.byOutput)
    .map((id) => ({ id, name: data.itemName(id) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Any item usable as a resource limit / node (raw + producible).
  const allItems = Object.keys(data.items)
    .map((id) => ({ id, name: data.itemName(id) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  let selectedItem = null;
  let moduleMode = "depth";
  let stepFilter = "todo"; // todo | done | all
  let lastResult = null;

  const $ = (id) => document.getElementById(id);

  // ---- "Built" status storage (survives reloads where storage is allowed) --

  const memFallback = {};
  const store = {
    get(key) {
      try { return JSON.parse(localStorage.getItem(key)) || []; }
      catch (e) { return memFallback[key] || []; }
    },
    set(key, val) {
      try { localStorage.setItem(key, JSON.stringify(val)); }
      catch (e) { memFallback[key] = val; }
    },
  };

  // A stable key for the current factory so checkmarks stick to this build.
  function factoryKey(r) {
    const rate = Math.round(r.target_rate * 100) / 100;
    return "satcalc.done." + [r.target_item, rate, r.allow_alternate ? 1 : 0, r.maximized ? 1 : 0].join("|");
  }
  function doneSetFor(r) { return new Set(store.get(factoryKey(r))); }
  function saveDoneSet(r, set) { store.set(factoryKey(r), Array.from(set)); }

  // ---- Item search dropdown ---------------------------------------------

  const searchInput = $("itemSearch");
  const searchResults = $("searchResults");

  function renderSearch(query) {
    const q = (query || "").trim().toLowerCase();
    const matches = (q
      ? producible.filter((it) => it.name.toLowerCase().includes(q) || it.id.includes(q))
      : producible
    ).slice(0, 60);

    searchResults.innerHTML = "";
    matches.forEach((it) => {
      const div = document.createElement("div");
      div.textContent = it.name;
      // pointerdown fires before blur and works for both touch and mouse.
      div.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        selectItem(it);
      });
      // Fallback for browsers without pointer events.
      div.addEventListener("click", () => selectItem(it));
      searchResults.appendChild(div);
    });
    searchResults.classList.toggle("open", matches.length > 0);
  }

  function selectItem(it) {
    selectedItem = it.id;
    searchInput.value = it.name;
    searchResults.classList.remove("open");
  }

  // On phones, tapping a pre-filled field puts the cursor at the end and typing
  // appends - so clear it on focus and show the full list. You can then just
  // scroll and tap an item without typing anything at all.
  searchInput.addEventListener("focus", () => {
    searchInput.value = "";
    renderSearch("");
  });
  searchInput.addEventListener("input", () => {
    selectedItem = null; // typing invalidates a previous pick
    renderSearch(searchInput.value);
  });
  searchInput.addEventListener("blur", () => {
    setTimeout(() => {
      searchResults.classList.remove("open");
      // If nothing new was picked, put the current item's name back.
      if (selectedItem && !searchInput.value) {
        searchInput.value = data.itemName(selectedItem);
      }
    }, 200);
  });

  // Default selection so the app is usable immediately.
  const defaultItem = producible.find((it) => it.id === "heavy_modular_frame") || producible[0];
  if (defaultItem) selectItem(defaultItem);

  // ---- Belt / pipe selectors --------------------------------------------

  function fillTransportSelect(select, transports, defaultMk) {
    const entries = Object.keys(transports)
      .map((id) => transports[id])
      .sort((a, b) => a.mk - b.mk);
    entries.forEach((t) => {
      const opt = document.createElement("option");
      opt.value = t.mk;
      opt.textContent = t.name;
      if (t.mk === defaultMk) opt.selected = true;
      select.appendChild(opt);
    });
  }
  fillTransportSelect($("maxBelt"), data.belts, 6);
  fillTransportSelect($("maxPipe"), data.pipes, 2);

  // ---- Dynamic resource / node rows -------------------------------------

  function itemOptionsHtml(includeRawOnly) {
    const list = includeRawOnly
      ? allItems.filter((it) => S.NATURAL_RESOURCE_ITEMS.has(it.id)).concat(
          allItems.filter((it) => !S.NATURAL_RESOURCE_ITEMS.has(it.id)))
      : allItems;
    return list.map((it) => `<option value="${it.id}">${it.name}</option>`).join("");
  }

  function addResourceRow() {
    const row = document.createElement("div");
    row.className = "dyn-row";
    row.innerHTML =
      `<select class="res-item">${itemOptionsHtml(true)}</select>` +
      `<input type="number" class="res-rate" placeholder="/min" min="0" step="any" inputmode="decimal" style="max-width:110px" />` +
      `<button type="button" class="btn-mini">&times;</button>`;
    row.querySelector(".btn-mini").addEventListener("click", () => row.remove());
    $("resourceRows").appendChild(row);
  }

  function addNodeRow() {
    const row = document.createElement("div");
    row.className = "dyn-row";
    row.style.flexWrap = "wrap";
    row.innerHTML =
      `<select class="node-item" style="flex:1 1 100%">${itemOptionsHtml(true)}</select>` +
      `<select class="node-purity"><option value="impure">Impure</option><option value="normal" selected>Normal</option><option value="pure">Pure</option></select>` +
      `<select class="node-miner"><option value="mk1">Miner Mk.1</option><option value="mk2">Miner Mk.2</option><option value="mk3">Miner Mk.3</option></select>` +
      `<input type="number" class="node-count" value="1" min="1" step="1" inputmode="numeric" style="max-width:70px" />` +
      `<button type="button" class="btn-mini">&times;</button>`;
    row.querySelector(".btn-mini").addEventListener("click", () => row.remove());
    $("nodeRows").appendChild(row);
  }

  $("addResource").addEventListener("click", addResourceRow);
  $("addNode").addEventListener("click", addNodeRow);

  // ---- Gather constraints from the form ---------------------------------

  function buildConstraints() {
    const resourceLimits = {};
    document.querySelectorAll("#resourceRows .dyn-row").forEach((row) => {
      const item = row.querySelector(".res-item").value;
      const rate = parseFloat(row.querySelector(".res-rate").value);
      if (item && rate > 0) resourceLimits[item] = (resourceLimits[item] || 0) + rate;
    });

    const nodes = [];
    document.querySelectorAll("#nodeRows .dyn-row").forEach((row) => {
      const item = row.querySelector(".node-item").value;
      const count = parseFloat(row.querySelector(".node-count").value) || 1;
      nodes.push({
        item,
        purity: row.querySelector(".node-purity").value,
        miner: row.querySelector(".node-miner").value,
        count,
        clock_percent: 100,
      });
    });

    const powerVal = parseFloat($("power").value);

    return new S.Constraints({
      max_belt_mk: parseInt($("maxBelt").value, 10),
      max_pipe_mk: parseInt($("maxPipe").value, 10),
      resource_limits: resourceLimits,
      resource_nodes: nodes,
      power_limit: isNaN(powerVal) ? null : powerVal,
    });
  }

  // ---- Calculate --------------------------------------------------------

  $("calcBtn").addEventListener("click", calculate);

  function calculate() {
    if (!selectedItem) {
      alert("Pick a target item from the list first.");
      searchInput.focus();
      return;
    }
    const constraints = buildConstraints();
    const allowAlt = $("allowAlt").checked;
    const maximize = $("maximize").checked;

    let result;
    try {
      if (maximize) {
        result = graph.maximize(selectedItem, constraints, allowAlt, {});
      } else {
        const rate = parseFloat($("rate").value);
        if (!(rate > 0)) { alert("Enter a production rate above 0."); return; }
        result = graph.solve(selectedItem, rate, constraints, allowAlt, {});
      }
    } catch (err) {
      alert("Error: " + err.message);
      return;
    }

    lastResult = result;
    render(result);
    $("placeholder").style.display = "none";
    $("results").style.display = "block";
    $("results").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ---- Rendering helpers ------------------------------------------------

  const fmt = S.formatRate;
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

  function kv(k, v) {
    return `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`;
  }

  function block(title, inner) {
    if (!inner) return "";
    return `<h3 class="block">${esc(title)}</h3>${inner}`;
  }

  // ---- Overview tab -----------------------------------------------------

  function renderOverview(r) {
    const el = $("tab-overview");
    const okPill = r.feasible
      ? `<span class="pill ok">OK</span>`
      : `<span class="pill bad">OVER LIMIT</span>`;

    let html = `<div class="status-line">${esc(r.target_name)}: ${fmt(r.target_rate)}/min ${okPill}</div>`;
    html += `<div class="sub">Total power: ${fmt(r.power)} MW`;
    if (r.maximized) html += ` &middot; maximized`;
    if (r.allow_alternate) html += ` &middot; alternates on`;
    html += `</div>`;

    // Feasibility problems
    if (r.resource_issues.length) {
      html += `<div class="note">Resource over limit: ` +
        r.resource_issues.map((i) => `${data.itemName(i.item)} +${fmt(i.over)}/min`).join(", ") + `</div>`;
    }
    if (r.power_issue) {
      html += `<div class="note">Power over budget by ${fmt(r.power_issue.over)} MW (uses ${fmt(r.power_issue.used)} / ${fmt(r.power_issue.limit)} MW).</div>`;
    }

    // Machines
    html += block("Machines", Object.keys(r.machines).map((b) =>
      kv(data.buildingName(b), `${r.machines[b]} (${fmt(r.machines_exact[b])} exact)`)).join(""));

    // Power by building
    html += block("Power by building", Object.keys(r.power_by_building).map((b) =>
      kv(data.buildingName(b), `${fmt(r.power_by_building[b])} MW`)).join("")
      + (r.node_power ? kv("Miners (nodes)", `${fmt(r.node_power)} MW`) : ""));

    // Raw resources
    html += block("Raw resources", Object.keys(r.resources).map((i) =>
      kv(data.itemName(i), `${fmt(r.resources[i])}/min`)).join(""));

    // Unused resources
    const unused = Object.keys(r.unused_resources).filter((i) => r.unused_resources[i] > 0.0001);
    html += block("Unused resources", unused.map((i) =>
      kv(data.itemName(i), `${fmt(r.unused_resources[i])}/min`)).join(""));

    // Byproducts
    const byp = Object.keys(r.byproducts).filter((i) => r.byproducts[i] > 0.0001);
    html += block("Byproducts", byp.map((i) =>
      kv(data.itemName(i), `${fmt(r.byproducts[i])}/min`)).join(""));

    // Transport splits (only ones that need splitting)
    const splits = r.transport.filter((t) => t.needs_split);
    html += block("Transport splits", splits.map((t) =>
      kv(t.item_name, `${t.lines} x ${t.transport_name} (${fmt(t.capacity)}/min each, ${fmt(t.rate)}/min total)`)).join(""));

    // Flow recommendations
    html += block("Flow recommendations", r.flow_recommendations.map((f) =>
      `<div class="kv"><span class="k">Feed ${esc(f.item_name)} &rarr; ${esc(f.target_name)}</span>` +
      `<span class="v">${f.lines} x ${esc(f.transport_name)}<br><span class="sub">${fmt(f.machines_per_line)} machines/line</span></span></div>`).join(""));

    // Warnings
    if (r.warnings.length) {
      html += r.warnings.map((w) => `<div class="note">${esc(w)}</div>`).join("");
    }

    el.innerHTML = html;
  }

  // ---- Steps tab (build order + buildable checklist) --------------------

  // Order steps so you build dependencies first: shallowest depth first, then
  // by name. Within a depth, inputs are already produced by earlier steps.
  function buildOrderedSteps(r) {
    const levels = S.computeLevels(r.steps);
    return r.steps.slice().sort((a, b) => {
      const la = levels[a.item] || 0;
      const lb = levels[b.item] || 0;
      if (la !== lb) return la - lb;
      return a.item_name.localeCompare(b.item_name);
    });
  }

  function stepCard(step, index, isDone) {
    const baseRate = step.machines_exact ? step.rate / step.machines_exact : null;
    const plan = S.machineClockPlan(step.machines_exact, baseRate);
    const altBadge = step.alternate ? `<span class="alt">ALT</span>` : "";

    const inputs = Object.keys(step.inputs)
      .sort((a, b) => data.itemName(a).localeCompare(data.itemName(b)))
      .map((i) => `${data.itemName(i)} ${fmt(step.inputs[i])}`).join(", ");
    const outputs = Object.keys(step.outputs)
      .sort((a, b) => data.itemName(a).localeCompare(data.itemName(b)))
      .map((i) => `${data.itemName(i)} ${fmt(step.outputs[i])}`).join(", ");

    return `<div class="step${isDone ? " done" : ""}">
      <label class="step-check">
        <input type="checkbox" data-item="${esc(step.item)}" ${isDone ? "checked" : ""} />
        <span class="step-order">${index + 1}</span>
      </label>
      <div class="step-body">
        <div class="step-head">
          <div class="step-name">${esc(step.item_name)}${altBadge}</div>
          <div class="step-rate">${fmt(step.rate)}/min</div>
        </div>
        <div class="step-meta">${esc(step.building_name)} &middot; ${step.machines} machines (${fmt(step.machines_exact)} exact)</div>
        <div class="clock"><span class="label">Clock:</span> ${esc(plan.text)}</div>
        ${inputs ? `<div class="io"><b>In:</b> ${esc(inputs)}/min</div>` : ""}
        <div class="io"><b>Out:</b> ${esc(outputs)}/min</div>
      </div>
    </div>`;
  }

  function renderSteps(r) {
    const el = $("tab-steps");
    if (!r.steps.length) { el.innerHTML = `<div class="empty">This item is a raw resource.</div>`; return; }

    const ordered = buildOrderedSteps(r);
    const done = doneSetFor(r);
    const doneCount = ordered.filter((s) => done.has(s.item)).length;
    const total = ordered.length;

    const counts = { todo: total - doneCount, done: doneCount, all: total };
    const labels = { todo: "To-do", done: "Done", all: "All" };
    const seg = `<div class="seg">` +
      ["todo", "done", "all"].map((m) =>
        `<button data-filter="${m}" class="${m === stepFilter ? "active" : ""}">${labels[m]} (${counts[m]})</button>`).join("") +
      `</div>`;

    const pct = total ? Math.round((doneCount / total) * 100) : 0;
    const progress =
      `<div class="progress"><div class="progress-bar" style="width:${pct}%"></div></div>` +
      `<div class="progress-text">${doneCount} of ${total} built &middot; ${pct}%` +
      (doneCount ? ` <button class="link-btn" id="resetDone">reset</button>` : "") + `</div>`;

    const visible = ordered.filter((s) => {
      const isDone = done.has(s.item);
      return stepFilter === "all" || (stepFilter === "done" ? isDone : !isDone);
    });

    const cards = visible.length
      ? visible.map((s) => stepCard(s, ordered.indexOf(s), done.has(s.item))).join("")
      : `<div class="empty">${stepFilter === "todo" ? "All steps built. 🎉" : "Nothing here yet."}</div>`;

    el.innerHTML = seg + progress + cards;

    // Wire up the filter buttons.
    el.querySelectorAll(".seg button").forEach((btn) => {
      btn.addEventListener("click", () => { stepFilter = btn.dataset.filter; renderSteps(r); });
    });

    // Wire up the checkboxes.
    el.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener("change", () => {
        const set = doneSetFor(r);
        if (cb.checked) set.add(cb.dataset.item); else set.delete(cb.dataset.item);
        saveDoneSet(r, set);
        renderSteps(r);
      });
    });

    const reset = $("resetDone");
    if (reset) reset.addEventListener("click", () => { saveDoneSet(r, new Set()); renderSteps(r); });
  }

  // ---- Modules tab ------------------------------------------------------

  function renderModules(r) {
    const el = $("tab-modules");
    const seg = `<div class="seg">
      ${["depth", "building", "resource"].map((m) =>
        `<button data-mode="${m}" class="${m === moduleMode ? "active" : ""}">${m[0].toUpperCase() + m.slice(1)}</button>`).join("")}
    </div>`;

    const modules = S.groupModules(data, r, moduleMode);
    let body = "";
    if (!modules.length) {
      body = `<div class="empty">Nothing to build.</div>`;
    } else {
      body = modules.map((mod) => {
        const steps = mod.steps.map((s) => {
          const feeds = s.feeds_into.length ? `<div class="feeds">Feeds: ${esc(s.feeds_into.join(", "))}</div>` : "";
          return `<div class="step">
            <div class="step-head">
              <div class="step-name">${esc(s.item_name)}</div>
              <div class="step-rate">${esc(s.rate_text)}</div>
            </div>
            <div class="step-meta">${esc(s.building_name)} &middot; ${s.machines} machines</div>
            <div class="clock"><span class="label">Clock:</span> ${esc(s.clock_plan.text)}</div>
            ${feeds}
          </div>`;
        }).join("");
        return `<div class="module-title">${esc(mod.title)}</div>${steps}`;
      }).join("");
    }

    el.innerHTML = seg + body;
    el.querySelectorAll(".seg button").forEach((btn) => {
      btn.addEventListener("click", () => {
        moduleMode = btn.dataset.mode;
        renderModules(r);
      });
    });
  }

  // ---- Flow tab (text build tree) --------------------------------------

  function renderFlow(r) {
    const el = $("tab-flow");
    const stepByItem = Object.create(null);
    r.steps.forEach((s) => { stepByItem[s.item] = s; });
    const visited = new Set();

    function rawNode(item) {
      const rate = r.resources[item] || 0;
      return `<div class="tnode raw">
        <div class="tlabel"><span class="tname raw">${esc(data.itemName(item))}</span><span class="trate">${fmt(rate)}/min</span></div>
        <div class="tmeta">raw resource &mdash; mine / extract this</div>
      </div>`;
    }

    function node(item, isRoot) {
      const step = stepByItem[item];
      if (!step) return rawNode(item);

      if (visited.has(item) && !isRoot) {
        return `<div class="tnode ref">
          <div class="tlabel"><span class="tname">${esc(step.item_name)}</span><span class="trate">${fmt(step.rate)}/min</span></div>
          <div class="tmeta">&uarr; same line as above</div>
        </div>`;
      }
      visited.add(item);

      const base = step.machines_exact ? step.rate / step.machines_exact : null;
      const plan = S.machineClockPlan(step.machines_exact, base);
      const inputs = Object.keys(step.inputs)
        .sort((a, b) => data.itemName(a).localeCompare(data.itemName(b)));

      // Spell out exactly what goes INTO this machine, so the indented
      // sub-trees below aren't mistaken for direct inputs.
      const directLine = inputs.length
        ? `<div class="tinputs">Into this ${esc(step.building_name)}: ` +
          inputs.map((i) => `<b>${esc(data.itemName(i))}</b> ${fmt(step.inputs[i])}`).join(" &nbsp;+&nbsp; ") +
          ` /min</div>`
        : "";

      const children = inputs.map((i) => node(i, false)).join("");

      return `<div class="tnode${isRoot ? " root" : ""}">
        <div class="tlabel"><span class="tname">${esc(step.item_name)}</span><span class="trate">${fmt(step.rate)}/min</span></div>
        <div class="tmeta">${step.machines}&times; ${esc(step.building_name)} &middot; ${esc(plan.text)}</div>
        ${directLine}
        ${children ? `<div class="tchildren">${children}</div>` : ""}
      </div>`;
    }

    if (!r.steps.length) {
      el.innerHTML = `<div class="empty">This item is a raw resource &mdash; just mine it.</div>`;
      return;
    }

    el.innerHTML =
      `<div class="tree-help">Read top to bottom: to build <b>${esc(r.target_name)}</b>, ` +
      `feed it the lines indented under it, all the way down to the raw resources at the tips. ` +
      `Each line shows machines, clock and total flow per minute.</div>` +
      node(r.target_item, true);
  }

  function render(r) {
    renderOverview(r);
    renderFlow(r);
    renderSteps(r);
    renderModules(r);
  }

  // ---- Tab switching ----------------------------------------------------

  document.querySelectorAll(".tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tabs button").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tabpanel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      $("tab-" + btn.dataset.tab).classList.add("active");
    });
  });

  // Expose for quick debugging in the console.
  window._app = { data, graph, calculate, get result() { return lastResult; } };
})();
